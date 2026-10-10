import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RedisGate } from "../../core/fleet-gate.js";

// Not REDIS_URL: a shell that ran start.sh carries the developer's own. Database 15,
// and a scope per test, so nothing here touches a key anything else uses.
const URL_ = process.env["AGENT_TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379/15";
const redis = new Redis(URL_, { maxRetriesPerRequest: 1 });
afterAll(async () => {
  await redis.quit();
});

const scope = () => `test:${randomUUID()}`;
const settled = async (promise: Promise<unknown>, ms = 400) =>
  Promise.race([promise.then(() => true), new Promise((done) => setTimeout(() => done(false), ms))]);

describe("the fleet gate, shared through Redis", () => {
  it("lets no more than its limit be in flight across every holder", async () => {
    const name = scope();
    const one = new RedisGate(redis, name, { concurrency: 2 }, 60_000);
    const two = new RedisGate(redis, name, { concurrency: 2 }, 60_000);
    const first = await one.acquire(1);
    await two.acquire(1);

    const third = one.acquire(1);
    expect(await settled(third)).toBe(false);
    await first();
    expect(await settled(third, 2_000)).toBe(true);
  });

  it("frees a slot whose holder died without giving it back", async () => {
    const gate = new RedisGate(redis, scope(), { concurrency: 1 }, 200);
    await gate.acquire(1); // never released
    expect(await settled(gate.acquire(1), 2_000)).toBe(true);
  });

  it("counts requests and tokens per minute, and opens again the next minute", async () => {
    let now = 60_000 * 1_000_000;
    const gate = new RedisGate(redis, scope(), { rpm: 2, tpm: 100 }, 60_000, () => now);
    await gate.acquire(10);
    await gate.acquire(10);
    const third = gate.acquire(10);
    expect(await settled(third)).toBe(false);
    now += 60_000;
    expect(await settled(third, 2_000)).toBe(true);

    const big = new RedisGate(redis, scope(), { tpm: 100 }, 60_000, () => now);
    await big.acquire(90);
    expect(await settled(big.acquire(20))).toBe(false);
  });

  it("stops waiting when the run lets go", async () => {
    const gate = new RedisGate(redis, scope(), { concurrency: 1 }, 60_000);
    await gate.acquire(1);
    const run = new AbortController();
    const waiting = gate.acquire(1, run.signal);
    run.abort(new Error("lease lost"));
    await expect(waiting).rejects.toThrow("lease lost");
  });

  it("opens when Redis cannot be reached, rather than stopping the fleet", async () => {
    const down = new Redis("redis://127.0.0.1:1/0", { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    down.on("error", () => undefined);
    const gate = new RedisGate(down, scope(), { concurrency: 1 }, 60_000);
    expect(await settled(gate.acquire(1), 2_000)).toBe(true);
    expect(await settled(gate.acquire(1), 2_000)).toBe(true);
    down.disconnect();
  });
});

describe("the fleet gate keeps slots for a person's run", () => {
  it("stops automated runs short of the reserve, and lets a human run use it", async () => {
    const { inLane } = await import("../../core/lane.js");
    const gate = new RedisGate(redis, scope(), { concurrency: 3, humanReserve: 1 }, 60_000);
    await gate.acquire(1);
    await gate.acquire(1);
    expect(await settled(gate.acquire(1))).toBe(false);
    expect(await settled(inLane("human", () => gate.acquire(1)))).toBe(true);
  });
});
