import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { RunJob } from "../../contracts/job.js";
import { fleetStatus } from "../../core/fleet-status.js";
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
