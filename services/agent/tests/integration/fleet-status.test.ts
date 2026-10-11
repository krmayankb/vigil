import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { RunJob } from "../../contracts/job.js";
import { backlog, fleetStatus } from "../../core/fleet-status.js";
import { LeaseRepository } from "../../ledger/leases.js";
import { TEST_DSN } from "../support/testdb.js";

const REDIS = new URL(process.env["AGENT_TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379/15");
const connection = { host: REDIS.hostname, port: Number(REDIS.port || 6379), db: Number(REDIS.pathname.slice(1) || 0) };
const pool = new pg.Pool({ connectionString: TEST_DSN });
// Queues of this test's own, so another suite's jobs never count here.
const names = { automated: `test-fleet-${randomUUID()}`, human: `test-fleet-${randomUUID()}` };
const queues = { automated: new Queue<RunJob>(names.automated, { connection }), human: new Queue<RunJob>(names.human, { connection }) };
const leases = new LeaseRepository(pool);
const running = randomUUID();
const stalled = randomUUID();

afterAll(async () => {
  await pool.query("DELETE FROM agent_run_leases WHERE run_id = ANY($1::uuid[])", [[running, stalled]]);
  await Promise.all([queues.automated.obliterate({ force: true }), queues.human.obliterate({ force: true })]);
  await Promise.all([queues.automated.close(), queues.human.close()]);
  await pool.end();
});

function job(runId: string): RunJob {
  return { schema_version: 1, run_id: runId, run_kind: "investigate", tenant_id: null, enqueued_at: new Date().toISOString(), enqueued_by: "test", reason: "resume" };
}

describe("what the fleet is doing, for the console and whoever is on call", () => {
  it("names a run that failed for good, says why, and finds a run nobody is picking up", async () => {
    const dead = randomUUID();
    const failing = new Worker<RunJob>(names.automated, async () => {
      throw new Error("the playbook could not be resolved");
    }, { connection });
    const failed = new Promise<void>((done) => failing.on("failed", () => done()));
    await queues.automated.add("run", job(dead), { jobId: dead, attempts: 1 });
    await failed;
    await failing.close();

    await leases.claim(running, "investigate", "worker-a", 60_000, "human");
    await leases.claim(stalled, "hunt", "worker-b", 60_000);
    await pool.query("UPDATE agent_run_leases SET claim_until = now() - interval '1 hour', owner = NULL WHERE run_id = $1", [stalled]);

    const status = (await fleetStatus({ pool, queues })) as {
      queues: Record<string, Record<string, number>>;
      dead_letters: { run_id: string; reason: string; lane: string }[];
      leases: { by_state: Record<string, Record<string, number>>; stalled: { run_id: string }[] };
      budget: unknown;
    };

    expect(status.queues["automated"]?.["failed"]).toBe(1);
    expect(status.dead_letters).toEqual([expect.objectContaining({ run_id: dead, lane: "automated", reason: "the playbook could not be resolved" })]);
    expect(status.leases.by_state["running"]?.["human"]).toBeGreaterThanOrEqual(1);
    expect(status.leases.stalled.map((one) => one.run_id)).toContain(stalled);
    expect(status.leases.stalled.map((one) => one.run_id)).not.toContain(running);
    expect(status.budget).toBeNull();
  });

  it("answers the parts it can when one source is down", async () => {
    const down = new Queue<RunJob>(`test-fleet-${randomUUID()}`, { connection: { host: "127.0.0.1", port: 1, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null } });
    down.on("error", () => undefined);
    const status = (await fleetStatus({ pool, queues: { automated: down, human: down } })) as { queues: { unavailable?: string }; leases: unknown };
    expect(status.queues.unavailable).toBeTruthy();
    expect(status.leases).toHaveProperty("by_state");
    await down.close().catch(() => undefined);
  });
});

describe("the backlog an autoscaler reads", () => {
  it("counts runs waiting on either lane, prioritized ones included, and not ones held back", async () => {
    const lanes = { automated: new Queue<RunJob>(`test-fleet-${randomUUID()}`, { connection }), human: new Queue<RunJob>(`test-fleet-${randomUUID()}`, { connection }) };
    try {
      await lanes.automated.add("run", job(randomUUID()), { priority: 1 });
      await lanes.automated.add("run", job(randomUUID()), { priority: 4 });
      await lanes.automated.add("run", job(randomUUID()));
      await lanes.automated.add("run", job(randomUUID()), { delay: 60_000 });
      await lanes.human.add("run", job(randomUUID()));
      expect(await backlog(lanes)).toBe(4);
    } finally {
      await Promise.all([lanes.automated.obliterate({ force: true }), lanes.human.obliterate({ force: true })]);
      await Promise.all([lanes.automated.close(), lanes.human.close()]);
    }
  });
});

describe("the fleet, for a scraper", () => {
  it("renders the status as Prometheus gauges, and a part it could not read as down", async () => {
    const { prometheusOf } = await import("../../core/fleet-status.js");
    const text = prometheusOf({
      queues: { automated: { waiting: 3, active: 2 }, human: { waiting: 0 } },
      leases: { by_state: { running: { automated: 2 }, stalled: { human: 1 } }, stalled: [] },
      budget: { unavailable: "redis down" },
      dead_letters: [],
      oldest_waiting_s: { automated: 42, human: null },
    });
    expect(text).toContain('vigil_agent_queue_jobs{lane="automated",state="waiting"} 3');
    expect(text).toContain('vigil_agent_runs{state="stalled",lane="human"} 1');
    expect(text).toContain('vigil_agent_oldest_waiting_seconds{lane="automated"} 42');
    expect(text).toContain('vigil_agent_oldest_waiting_seconds{lane="human"} 0');
    expect(text).toContain('vigil_fleet_part_up{part="budget"} 0');
    expect(text).toContain('vigil_fleet_part_up{part="queues"} 1');
    expect(text).not.toContain("vigil_fleet_spend_usd{");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("reports how long the oldest run in each lane has waited", async () => {
    const run = randomUUID();
    await queues.human.add("run", job(run), { jobId: run, delay: 0 });
    const status = (await fleetStatus({ pool, queues })) as { oldest_waiting_s: Record<string, number | null> };
    expect(status.oldest_waiting_s["human"]).toBeGreaterThanOrEqual(0);
    await queues.human.remove(run);
  });
});
