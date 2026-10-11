import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RedisFleetBudget } from "../../core/fleet-budget.js";

// Not REDIS_URL, for the reason the fleet gate test gives. The budget's keys are
// fixed (vigil:budget:*), so each test starts from none of them.
const redis = new Redis(process.env["AGENT_TEST_REDIS_URL"] ?? "redis://127.0.0.1:56379/15", { maxRetriesPerRequest: 1 });
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  const keys = await redis.keys("vigil:budget:*");
  if (keys.length > 0) await redis.del(...keys);
});

// Mid-hour, so a test does not straddle a window by accident.
let now = Date.UTC(2026, 9, 10, 12, 30);
const budget = (hourly: number, daily = 0, expected = 1, holdMs = 3_600_000) =>
  new RedisFleetBudget(redis, { hourly, daily, expected, holdMs }, () => now);

describe("the fleet's budget, held in Redis", () => {
  it("admits runs while spend plus what is reserved fits, and holds the next one", async () => {
    const fleet = budget(3);
    expect(await fleet.admit("a", "investigate")).toMatchObject({ admitted: true });
    expect(await fleet.admit("b", "investigate")).toMatchObject({ admitted: true });
    expect(await fleet.admit("c", "investigate")).toMatchObject({ admitted: true });
    const held = await fleet.admit("d", "investigate");
    expect(held).toMatchObject({ admitted: false, reason: "the fleet hourly budget is spoken for" });
    // Until the next hour starts.
    expect((held as { retryInMs: number }).retryInMs).toBe(30 * 60_000);
  });

  it("says how much of the tighter cap is spoken for once a run is admitted", async () => {
    const fleet = budget(4, 10);
    expect(await fleet.admit("a", "investigate")).toEqual({ admitted: true, used: 0.25 });
    expect(await fleet.admit("b", "investigate")).toEqual({ admitted: true, used: 0.5 });
    // No cap set: nothing to be a share of.
    expect(await budget(0, 0).admit("c", "investigate")).toEqual({ admitted: true });
  });

  it("admits a run it already admitted, without reserving twice", async () => {
    const fleet = budget(1);
    expect(await fleet.admit("a", "investigate")).toMatchObject({ admitted: true });
    expect(await fleet.admit("a", "investigate")).toMatchObject({ admitted: true });
  });

  it("draws a run's reservation down as it spends, so the next run fits again", async () => {
    const fleet = budget(2.5);
    await fleet.admit("a", "investigate"); // 1 reserved
    await fleet.admit("b", "investigate"); // 2 reserved
    expect((await fleet.admit("c", "investigate")).admitted).toBe(false);
    // a spends 0.4: 0.4 spent, 0.6 + 1 still reserved -- 2.0 in all, so c's 1 does not fit.
    await fleet.charge("a", 0.4);
    expect((await fleet.admit("c", "investigate")).admitted).toBe(false);
    // a ends: its unused 0.6 comes back, and c fits.
    await fleet.settle("a", "investigate");
    expect((await fleet.admit("c", "investigate")).admitted).toBe(true);
  });

  it("counts spend beyond a run's reservation against the cap", async () => {
    const fleet = budget(2);
    await fleet.admit("a", "investigate");
    await fleet.charge("a", 1.5);
    expect((await fleet.admit("b", "investigate")).admitted).toBe(false);
  });

  it("moves the expected cost of a kind toward what its runs cost", async () => {
    const fleet = budget(100, 0, 1);
    await fleet.admit("a", "hunt");
    await fleet.charge("a", 3);
    await fleet.settle("a", "hunt");
    expect(Number(await redis.get("vigil:budget:expect:hunt"))).toBeCloseTo(1.2);
    expect(await redis.get("vigil:budget:expect:investigate")).toBeNull();
  });

  it("holds against the daily cap once the hourly one is clear", async () => {
    const fleet = budget(0, 2);
    await fleet.admit("a", "investigate");
    await fleet.admit("b", "investigate");
    const held = await fleet.admit("c", "investigate");
    expect(held).toMatchObject({ admitted: false, reason: "the fleet daily budget is spoken for" });
  });

  it("lets go of a reservation whose run went quiet", async () => {
    const fleet = budget(1, 0, 1, 1_000);
    await fleet.admit("a", "investigate");
    expect((await fleet.admit("b", "investigate")).admitted).toBe(false);
    now += 2_000;
    expect((await fleet.admit("b", "investigate")).admitted).toBe(true);
  });

  it("admits when Redis cannot be reached, rather than stopping the fleet", async () => {
    const down = new Redis("redis://127.0.0.1:1/0", { maxRetriesPerRequest: 0, enableOfflineQueue: false, lazyConnect: true, retryStrategy: () => null });
    down.on("error", () => undefined);
    const fleet = new RedisFleetBudget(down, { hourly: 0.01, expected: 1, holdMs: 1_000 });
    expect(await fleet.admit("a", "investigate")).toMatchObject({ admitted: true });
    await fleet.charge("a", 5);
    await fleet.settle("a", "investigate");
    down.disconnect();
  });
});

describe("a workflow's own share of the budget", () => {
  const scope = (hourly: number) => ({ scope: "full-investigation", hourly });

  it("holds a workflow at its own cap while the fleet still has room", async () => {
    const fleet = budget(100);
    expect(await fleet.admit("a", "investigate", scope(2))).toMatchObject({ admitted: true });
    expect(await fleet.admit("b", "investigate", scope(2))).toMatchObject({ admitted: true });
    expect(await fleet.admit("c", "investigate", scope(2))).toMatchObject({ admitted: false, reason: "the full-investigation hourly budget is spoken for" });
    // Another workflow, and a run with none, still fit under the fleet's cap.
    expect(await fleet.admit("d", "investigate", { scope: "incident-response", hourly: 2 })).toMatchObject({ admitted: true });
    expect(await fleet.admit("e", "investigate")).toMatchObject({ admitted: true });
  });

  it("counts a workflow's spend, and lets go of its reservation when the run ends", async () => {
    const fleet = budget(100);
    await fleet.admit("a", "investigate", scope(2)); // 1 reserved
    await fleet.charge("a", 1.5); // 1.5 spent, nothing left reserved
    expect((await fleet.admit("b", "investigate", scope(2))).admitted).toBe(false);
    await fleet.settle("a", "investigate");
    // Still 1.5 spent this hour, so another expected 1 does not fit under 2.
    expect((await fleet.admit("b", "investigate", scope(2))).admitted).toBe(false);
    expect(Number(await redis.get("vigil:budget:scope:full-investigation:hour:2026-10-10T12"))).toBeCloseTo(1.5);
  });

  it("learns what runs of a workflow cost apart from runs of its kind", async () => {
    const fleet = budget(100, 0, 1);
    await fleet.admit("a", "investigate", scope(100));
    await fleet.charge("a", 3);
    await fleet.settle("a", "investigate");
    expect(Number(await redis.get("vigil:budget:expect:scope:full-investigation"))).toBeCloseTo(1.2);
    expect(await redis.get("vigil:budget:expect:investigate")).toBeNull();
  });

  it("works with no fleet cap at all", async () => {
    const fleet = budget(0);
    expect((await fleet.admit("a", "investigate", scope(1))).admitted).toBe(true);
    expect((await fleet.admit("b", "investigate", scope(1))).admitted).toBe(false);
  });

  it("lets go of a quiet run's share of its workflow too", async () => {
    const fleet = budget(0, 0, 1, 1_000);
    await fleet.admit("a", "investigate", scope(1));
    expect((await fleet.admit("b", "investigate", scope(1))).admitted).toBe(false);
    now += 2_000;
    expect((await fleet.admit("b", "investigate", scope(1))).admitted).toBe(true);
  });
});
