import type { Redis } from "ioredis";
import { errorFields, logger } from "./log.js";

const log = logger("agent.fleet-budget");

// What the whole fleet may spend per hour and per day, kept in Redis so every worker
// holds the same line. Counting only what has been spent lets a thousand runs that
// each start under the cap blow through it together, so a run reserves what it is
// expected to cost before it starts, and the cap is held against spend plus every
// reservation still outstanding. As the run spends, its reservation is drawn down;
// when it ends, what it did not use is let go and the expectation for runs of its
// kind moves toward what this one cost.
//
// Admission is for automated starts only. A person's run is never refused here, and
// a resume is work already under way; both are still charged. If Redis cannot be
// reached the budget admits and says so: each run's own budget still holds, and the
// gateway's key is the hard stop.
export interface FleetBudgetLimits {
  // USD; 0 or absent means no cap of that kind.
  hourly?: number;
  daily?: number;
  // What a run is expected to cost before any of its kind has finished.
  expected: number;
  // How long a reservation outlives the last thing its run spent.
  holdMs: number;
}

export type Admission = { admitted: true } | { admitted: false; retryInMs: number; reason: string };

export interface FleetBudget {
  admit(runId: string, kind: string): Promise<Admission>;
  charge(runId: string, costUsd: number): Promise<void>;
  settle(runId: string, kind: string): Promise<void>;
}

export const unboundedBudget: FleetBudget = {
  admit: async () => ({ admitted: true }),
  charge: async () => {},
  settle: async () => {},
};

const K = "vigil:budget";

// Purges reservations whose runs went quiet, then admits or says how long to wait.
const ADMIT = `
local held, expiry, hour, day, expect = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local now, run, fallback, hourCap, dayCap, hold = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local untilHour, untilDay = tonumber(ARGV[7]), tonumber(ARGV[8])
for _, gone in ipairs(redis.call('ZRANGEBYSCORE', expiry, '-inf', now)) do
  redis.call('HDEL', held, gone)
  redis.call('ZREM', expiry, gone)
end
if redis.call('HEXISTS', held, run) == 1 then return {0, '0'} end
local want = tonumber(redis.call('GET', expect) or fallback)
local outstanding = 0
for _, value in ipairs(redis.call('HVALS', held)) do outstanding = outstanding + tonumber(value) end
local spentHour = tonumber(redis.call('GET', hour) or '0')
local spentDay = tonumber(redis.call('GET', day) or '0')
if hourCap > 0 and spentHour + outstanding + want > hourCap then return {untilHour, 'hourly'} end
if dayCap > 0 and spentDay + outstanding + want > dayCap then return {untilDay, 'daily'} end
redis.call('HSET', held, run, want)
redis.call('ZADD', expiry, now + hold, run)
return {0, tostring(want)}
`;

const CHARGE = `
local held, expiry, hour, day, spent = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local now, run, cost, hold = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
redis.call('INCRBYFLOAT', hour, cost)
redis.call('PEXPIRE', hour, 7200000)
redis.call('INCRBYFLOAT', day, cost)
redis.call('PEXPIRE', day, 172800000)
redis.call('HINCRBYFLOAT', spent, run, cost)
local remaining = redis.call('HGET', held, run)
if remaining then
  local left = tonumber(remaining) - cost
  if left < 0 then left = 0 end
  redis.call('HSET', held, run, left)
  redis.call('ZADD', expiry, now + hold, run)
end
return 1
`;

// Lets go of the run's reservation and moves its kind's expectation toward what it cost.
const SETTLE = `
local held, expiry, spent, expect = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local run, fallback = ARGV[1], tonumber(ARGV[2])
local cost = tonumber(redis.call('HGET', spent, run) or '0')
redis.call('HDEL', held, run)
redis.call('ZREM', expiry, run)
redis.call('HDEL', spent, run)
if cost > 0 then
  local before = tonumber(redis.call('GET', expect) or fallback)
  redis.call('SET', expect, tostring(before * 0.9 + cost * 0.1))
end
return tostring(cost)
`;

function windows(now: number): { hour: string; day: string; untilHour: number; untilDay: number } {
  const at = new Date(now);
  const stamp = at.toISOString();
  const nextHour = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours() + 1);
  const nextDay = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return { hour: `${K}:hour:${stamp.slice(0, 13)}`, day: `${K}:day:${stamp.slice(0, 10)}`, untilHour: nextHour - now, untilDay: nextDay - now };
}

export class RedisFleetBudget implements FleetBudget {
  private warned = 0;

  constructor(
    private readonly redis: Redis,
    private readonly limits: FleetBudgetLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(runId: string, kind: string): Promise<Admission> {
    const at = this.now();
    const window = windows(at);
    try {
      const [wait, detail] = (await this.redis.eval(
        ADMIT,
        5,
        `${K}:held`,
        `${K}:expiry`,
        window.hour,
        window.day,
        `${K}:expect:${kind}`,
        at,
        runId,
        this.limits.expected,
        this.limits.hourly ?? 0,
        this.limits.daily ?? 0,
        this.limits.holdMs,
        window.untilHour,
        window.untilDay,
      )) as [number, string];
      if (Number(wait) === 0) return { admitted: true };
      return { admitted: false, retryInMs: Number(wait), reason: `the fleet's ${detail} budget is spoken for` };
    } catch (error) {
      this.unreachable(error);
      return { admitted: true };
    }
  }

  async charge(runId: string, costUsd: number): Promise<void> {
    if (!(costUsd > 0)) return;
    const at = this.now();
    const window = windows(at);
    try {
      await this.redis.eval(CHARGE, 5, `${K}:held`, `${K}:expiry`, window.hour, window.day, `${K}:spent`, at, runId, costUsd, this.limits.holdMs);
    } catch (error) {
      this.unreachable(error);
    }
  }

  async settle(runId: string, kind: string): Promise<void> {
    try {
      await this.redis.eval(SETTLE, 4, `${K}:held`, `${K}:expiry`, `${K}:spent`, `${K}:expect:${kind}`, runId, this.limits.expected);
    } catch (error) {
      this.unreachable(error);
    }
  }

  private unreachable(error: unknown): void {
    if (Date.now() - this.warned < 30_000) return;
    this.warned = Date.now();
    log.warn("fleet budget unreachable; admitting and not counting", errorFields(error));
  }
}

// Configured from the environment; no cap set means no fleet budget at all.
export function fleetBudgetLimitsFrom(env: NodeJS.ProcessEnv = process.env): FleetBudgetLimits | null {
  const usd = (name: string) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const hourly = usd("VIGIL_FLEET_BUDGET_HOURLY_USD");
  const daily = usd("VIGIL_FLEET_BUDGET_DAILY_USD");
  if (hourly === 0 && daily === 0) return null;
  return { hourly, daily, expected: usd("VIGIL_FLEET_EXPECTED_RUN_USD") || 0.05, holdMs: 6 * 3_600_000 };
}
