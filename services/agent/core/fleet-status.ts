import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import type { Lane, RunJob } from "../contracts/job.js";

// What the fleet is doing right now, for the console and for whoever is on call:
// how deep each lane's queue is, what failed for good and why, how many runs are
// being driven, waiting, or lost, and how much of the fleet's budget and model
// allowance is in use. Read-only, and every part answers on its own: a Redis that
// cannot be read leaves the lease counts standing.
export interface FleetStatusSources {
  pool: Pool;
  queues: Readonly<Record<Lane, Queue<RunJob>>>;
  redis?: Redis;
  // A run whose claim lapsed longer ago than this is one no watchdog is picking up.
  stalledAfterMs?: number;
}

export interface DeadLetter {
  lane: Lane;
  run_id: string;
  run_kind: string;
  reason: string;
  attempts: number;
  failed_at: string | null;
}

const DEAD_LETTERS = 20;

export async function fleetStatus(sources: FleetStatusSources): Promise<Record<string, unknown>> {
  const stalledAfter = (sources.stalledAfterMs ?? 5 * 60_000) / 1000;
  const [queues, deadLetters, leases, budget] = await Promise.all([
    settle(queueDepths(sources.queues)),
    settle(deadLettersOf(sources.queues)),
    settle(leaseStates(sources.pool, stalledAfter)),
    settle(sources.redis === undefined ? Promise.resolve(null) : budgetAndGate(sources.redis)),
  ]);
  return { at: new Date().toISOString(), queues, dead_letters: deadLetters, leases, budget };
}

// One part's answer, or why it has none.
async function settle<T>(work: Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await work;
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

async function queueDepths(queues: FleetStatusSources["queues"]): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [lane, queue] of Object.entries(queues)) {
    out[lane] = await queue.getJobCounts("waiting", "prioritized", "active", "delayed", "failed", "completed");
  }
  return out;
}

async function deadLettersOf(queues: FleetStatusSources["queues"]): Promise<DeadLetter[]> {
  const letters: DeadLetter[] = [];
  for (const [lane, queue] of Object.entries(queues) as [Lane, Queue<RunJob>][]) {
    for (const job of await queue.getFailed(0, DEAD_LETTERS - 1)) {
      letters.push({
        lane,
        run_id: job.data?.run_id ?? String(job.id),
        run_kind: job.data?.run_kind ?? "unknown",
        reason: job.failedReason ?? "",
        attempts: job.attemptsMade,
        failed_at: job.finishedOn === undefined ? null : new Date(job.finishedOn).toISOString(),
      });
    }
  }
  return letters.sort((a, b) => (b.failed_at ?? "").localeCompare(a.failed_at ?? "")).slice(0, DEAD_LETTERS);
}

async function leaseStates(pool: Pool, stalledAfterS: number): Promise<Record<string, unknown>> {
  const counts = await pool.query<{ state: string; lane: string; n: string }>(
    `SELECT CASE
              WHEN claim_until > now() AND owner IS NOT NULL THEN 'running'
              WHEN claim_until > now() THEN 'waiting'
              WHEN claim_until > now() - make_interval(secs => $1::double precision) THEN 'due'
              ELSE 'stalled'
            END AS state, lane, count(*) AS n
       FROM agent_run_leases GROUP BY 1, 2`,
    [stalledAfterS],
  );
  const stalled = await pool.query<{ run_id: string; run_kind: string; lane: string; claim_until: Date }>(
    `SELECT run_id, run_kind, lane, claim_until FROM agent_run_leases
      WHERE claim_until <= now() - make_interval(secs => $1::double precision)
      ORDER BY claim_until LIMIT 20`,
    [stalledAfterS],
  );
  const byState: Record<string, Record<string, number>> = {};
  for (const row of counts.rows) (byState[row.state] ??= {})[row.lane] = Number(row.n);
  return {
    by_state: byState,
    stalled: stalled.rows.map((row) => ({ ...row, claim_until: row.claim_until.toISOString() })),
  };
}

async function budgetAndGate(redis: Redis): Promise<Record<string, unknown>> {
  const at = new Date().toISOString();
  const [hour, day, held, llm] = await Promise.all([
    redis.get(`vigil:budget:hour:${at.slice(0, 13)}`),
    redis.get(`vigil:budget:day:${at.slice(0, 10)}`),
    redis.hvals("vigil:budget:held"),
    redis.zcount("vigil:gate:llm:inflight", Date.now(), "+inf"),
  ]);
  return {
    spent_this_hour_usd: Number(hour ?? 0),
    spent_today_usd: Number(day ?? 0),
    reserved_usd: held.reduce((total, value) => total + Number(value), 0),
    reserved_runs: held.length,
    caps: {
      hourly_usd: Number(process.env["VIGIL_FLEET_BUDGET_HOURLY_USD"] ?? 0) || null,
      daily_usd: Number(process.env["VIGIL_FLEET_BUDGET_DAILY_USD"] ?? 0) || null,
    },
    model_calls_in_flight: llm,
    model_call_cap: Number(process.env["VIGIL_LLM_FLEET_CONCURRENCY"] ?? 0) || null,
  };
}
