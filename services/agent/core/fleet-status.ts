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
  const [queues, deadLetters, leases, budget, oldest] = await Promise.all([
    settle(queueDepths(sources.queues)),
    settle(deadLettersOf(sources.queues)),
    settle(leaseStates(sources.pool, stalledAfter)),
    settle(sources.redis === undefined ? Promise.resolve(null) : budgetAndGate(sources.redis)),
    settle(oldestWaiting(sources.queues)),
  ]);
  return { at: new Date().toISOString(), queues, dead_letters: deadLetters, leases, budget, oldest_waiting_s: oldest };
}

// How long the run that has waited longest to start has waited, per lane: on the
// human lane, how long the oldest person's ask has gone unanswered. Null when
// nothing waits.
async function oldestWaiting(queues: FleetStatusSources["queues"]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for (const [lane, queue] of Object.entries(queues)) {
    const jobs = await queue.getJobs(["waiting", "prioritized"], 0, 199, true);
    const first = jobs.reduce<number | null>((min, job) => (job.timestamp !== undefined && (min === null || job.timestamp < min) ? job.timestamp : min), null);
    out[lane] = first === null ? null : Math.max(0, Math.round((Date.now() - first) / 1000));
  }
  return out;
}

// The same status in Prometheus' text format, for a scraper. Every value is a
// gauge read at scrape time; a part that could not be read reports as down rather
// than as zeros.
export function prometheusOf(status: Record<string, unknown>): string {
  const lines: string[] = [];
  const family = (name: string, help: string) => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  const sample = (name: string, labels: Record<string, string>, value: number | null | undefined) => {
    if (value === null || value === undefined || !Number.isFinite(value)) return;
    const tags = Object.entries(labels).map(([key, label]) => `${key}="${label.replace(/["\\\n]/g, "_")}"`).join(",");
    lines.push(`${name}${tags === "" ? "" : `{${tags}}`} ${value}`);
  };
  const part = (value: unknown) => (value !== null && typeof value === "object" && "unavailable" in value ? null : (value as Record<string, unknown> | null));

  family("vigil_fleet_part_up", "Whether each part of the fleet status could be read (1) or not (0).");
  for (const name of ["queues", "dead_letters", "leases", "budget", "oldest_waiting_s"]) {
    sample("vigil_fleet_part_up", { part: name }, part(status[name]) === null && status[name] !== null ? 0 : 1);
  }

  const queues = part(status["queues"]) as Record<string, Record<string, number>> | null;
  family("vigil_agent_queue_jobs", "Run jobs in each lane's queue, by state.");
  for (const [lane, counts] of Object.entries(queues ?? {})) for (const [state, n] of Object.entries(counts)) sample("vigil_agent_queue_jobs", { lane, state }, n);

  const leases = part(status["leases"]) as { by_state?: Record<string, Record<string, number>>; stalled?: unknown[] } | null;
  family("vigil_agent_runs", "Runs holding a lease, by state (running, waiting, due, stalled) and lane.");
  for (const [state, lanes] of Object.entries(leases?.by_state ?? {})) for (const [lane, n] of Object.entries(lanes)) sample("vigil_agent_runs", { state, lane }, n);

  const oldest = part(status["oldest_waiting_s"]) as Record<string, number | null> | null;
  family("vigil_agent_oldest_waiting_seconds", "How long the run that has waited longest to start has waited, by lane.");
  for (const [lane, seconds] of Object.entries(oldest ?? {})) sample("vigil_agent_oldest_waiting_seconds", { lane }, seconds ?? 0);

  const budget = part(status["budget"]) as Record<string, unknown> | null;
  if (budget !== null) {
    const caps = (budget["caps"] ?? {}) as Record<string, number | null>;
    family("vigil_fleet_spend_usd", "What the fleet has spent in the current window.");
    sample("vigil_fleet_spend_usd", { window: "hour" }, budget["spent_this_hour_usd"] as number);
    sample("vigil_fleet_spend_usd", { window: "day" }, budget["spent_today_usd"] as number);
    family("vigil_fleet_budget_cap_usd", "The fleet's spending cap per window, where one is set.");
    sample("vigil_fleet_budget_cap_usd", { window: "hour" }, caps["hourly_usd"]);
    sample("vigil_fleet_budget_cap_usd", { window: "day" }, caps["daily_usd"]);
    family("vigil_fleet_reserved_usd", "What runs in flight have reserved against the budget.");
    sample("vigil_fleet_reserved_usd", {}, budget["reserved_usd"] as number);
    family("vigil_fleet_reserved_runs", "Runs holding a budget reservation.");
    sample("vigil_fleet_reserved_runs", {}, budget["reserved_runs"] as number);
    family("vigil_fleet_model_calls_in_flight", "Model calls in flight across the fleet, and the cap where one is set.");
    sample("vigil_fleet_model_calls_in_flight", {}, budget["model_calls_in_flight"] as number);
    sample("vigil_fleet_model_call_cap", {}, budget["model_call_cap"] as number | null);
  }
  return `${lines.join("\n")}\n`;
}

// One part's answer, or why it has none.
async function settle<T>(work: Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await work;
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
}

// Runs waiting to start across both lanes, for an autoscaler: waiting and
// prioritized, and not delayed -- a run held for the budget or for a provider is
// not work more workers could take. One number, because KEDA reads one.
export async function backlog(queues: FleetStatusSources["queues"]): Promise<number> {
  let total = 0;
  for (const queue of Object.values(queues)) {
    const counts = await queue.getJobCounts("waiting", "prioritized");
    total += (counts["waiting"] ?? 0) + (counts["prioritized"] ?? 0);
  }
  return total;
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
