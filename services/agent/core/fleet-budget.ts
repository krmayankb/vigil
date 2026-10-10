import type { Redis } from "ioredis";
import { errorFields, logger } from "./log.js";

const log = logger("agent.fleet-budget");

// What the whole fleet may spend per hour and per day, kept in Redis so every worker
// holds the same line. Counting only what has been spent lets a thousand runs that
// each start under the cap blow through it together, so a run reserves what it is
// expected to cost before it starts, and the cap is held against spend plus every
// reservation still outstanding. As the run spends, its reservation is drawn down;
// when it ends, what it did not use is let go and the expectation for runs like it
// moves toward what this one cost.
//
// A run may also belong to a scope -- its workflow -- with caps of its own, held the
// same way against that scope's spend and reservations; and the expectation is
// learned per scope, so a long workflow and a short one are not priced alike.
//
// Admission is for automated starts only. A person's run is never refused here, and
// a resume is work already under way; both are still charged. If Redis cannot be
// reached the budget admits and says so: each run's own budget still holds, and the
// gateway's key is the hard stop.
export interface FleetBudgetLimits {
  // USD; 0 or absent means no cap of that kind.
  hourly?: number;
  daily?: number;
  // What a run is expected to cost before any like it has finished.
  expected: number;
  // How long a reservation outlives the last thing its run spent.
  holdMs: number;
}

// A run's own share of the budget: its workflow, and that workflow's caps.
export interface BudgetScope {
  scope: string;
  hourly?: number | null;
  daily?: number | null;
}

export type Admission = { admitted: true } | { admitted: false; retryInMs: number; reason: string };

export interface FleetBudget {
  admit(runId: string, kind: string, scope?: BudgetScope | null): Promise<Admission>;
  charge(runId: string, costUsd: number): Promise<void>;
  settle(runId: string, kind: string): Promise<void>;
}

export const unboundedBudget: FleetBudget = {
  admit: async () => ({ admitted: true }),
  charge: async () => {},
  settle: async () => {},
};

const K = "vigil:budget";

// KEYS: fleet held, fleet expiry, fleet hour, fleet day, expect, scope held, scope
// hour, scope day, run-to-scope. ARGV: now, run, fallback, hour cap, day cap, hold,
// until-hour, until-day, scope ("" for none), scope hour cap, scope day cap.
// Purges reservations whose runs went quiet, then admits or says how long to wait.
const ADMIT = `
local held, expiry, hour, day, expect = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5]
local sheld, shour, sday, scopes = KEYS[6], KEYS[7], KEYS[8], KEYS[9]
local now, run, fallback, hourCap, dayCap, hold = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6])
local untilHour, untilDay = tonumber(ARGV[7]), tonumber(ARGV[8])
local scope, sHourCap, sDayCap = ARGV[9], tonumber(ARGV[10]), tonumber(ARGV[11])
for _, gone in ipairs(redis.call('ZRANGEBYSCORE', expiry, '-inf', now)) do
  redis.call('HDEL', held, gone)
  redis.call('ZREM', expiry, gone)
  local was = redis.call('HGET', scopes, gone)
  if was then redis.call('HDEL', 'vigil:budget:held:' .. was, gone); redis.call('HDEL', scopes, gone) end
end
if redis.call('HEXISTS', held, run) == 1 then return {0, '0'} end
local want = tonumber(redis.call('GET', expect) or fallback)
local function sum(key)
  local total = 0
  for _, value in ipairs(redis.call('HVALS', key)) do total = total + tonumber(value) end
  return total
end
local outstanding = sum(held)
if hourCap > 0 and tonumber(redis.call('GET', hour) or '0') + outstanding + want > hourCap then return {untilHour, 'fleet hourly'} end
if dayCap > 0 and tonumber(redis.call('GET', day) or '0') + outstanding + want > dayCap then return {untilDay, 'fleet daily'} end
if scope ~= '' then
  local scoped = sum(sheld)
  if sHourCap > 0 and tonumber(redis.call('GET', shour) or '0') + scoped + want > sHourCap then return {untilHour, scope .. ' hourly'} end
  if sDayCap > 0 and tonumber(redis.call('GET', sday) or '0') + scoped + want > sDayCap then return {untilDay, scope .. ' daily'} end
  redis.call('HSET', sheld, run, want)
  redis.call('HSET', scopes, run, scope)
end
redis.call('HSET', held, run, want)
redis.call('ZADD', expiry, now + hold, run)
return {0, tostring(want)}
`;

// KEYS: fleet held, fleet expiry, fleet hour, fleet day, spent, run-to-scope.
// ARGV: now, run, cost, hold, hour stamp, day stamp.
const CHARGE = `
local held, expiry, hour, day, spent, scopes = KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5], KEYS[6]
local now, run, cost, hold = tonumber(ARGV[1]), ARGV[2], tonumber(ARGV[3]), tonumber(ARGV[4])
local hourStamp, dayStamp = ARGV[5], ARGV[6]
local function add(key, amount, ttl)
  redis.call('INCRBYFLOAT', key, amount)
  redis.call('PEXPIRE', key, ttl)
end
add(hour, cost, 7200000)
add(day, cost, 172800000)
redis.call('HINCRBYFLOAT', spent, run, cost)
local function drawDown(key)
  local remaining = redis.call('HGET', key, run)
  if remaining then
    local left = tonumber(remaining) - cost
    if left < 0 then left = 0 end
    redis.call('HSET', key, run, left)
  end
end
drawDown(held)
local scope = redis.call('HGET', scopes, run)
if scope then
  add('vigil:budget:scope:' .. scope .. ':hour:' .. hourStamp, cost, 7200000)
  add('vigil:budget:scope:' .. scope .. ':day:' .. dayStamp, cost, 172800000)
  drawDown('vigil:budget:held:' .. scope)
end
if redis.call('HEXISTS', held, run) == 1 then redis.call('ZADD', expiry, now + hold, run) end
return 1
`;

// Lets go of the run's reservation and moves its scope's (or kind's) expectation
// toward what it cost. KEYS: fleet held, fleet expiry, spent, run-to-scope.
// ARGV: run, fallback, kind.
const SETTLE = `
local held, expiry, spent, scopes = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local run, fallback, kind = ARGV[1], tonumber(ARGV[2]), ARGV[3]
local cost = tonumber(redis.call('HGET', spent, run) or '0')
local scope = redis.call('HGET', scopes, run)
redis.call('HDEL', held, run)
redis.call('ZREM', expiry, run)
redis.call('HDEL', spent, run)
local expect = 'vigil:budget:expect:' .. kind
if scope then
  redis.call('HDEL', 'vigil:budget:held:' .. scope, run)
  redis.call('HDEL', scopes, run)
  expect = 'vigil:budget:expect:scope:' .. scope
end
if cost > 0 then
  local before = tonumber(redis.call('GET', expect) or fallback)
  redis.call('SET', expect, tostring(before * 0.9 + cost * 0.1))
end
return tostring(cost)
`;

function windows(now: number): { hourStamp: string; dayStamp: string; untilHour: number; untilDay: number } {
  const at = new Date(now);
  const stamp = at.toISOString();
  const nextHour = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), at.getUTCHours() + 1);
  const nextDay = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return { hourStamp: stamp.slice(0, 13), dayStamp: stamp.slice(0, 10), untilHour: nextHour - now, untilDay: nextDay - now };
}

export class RedisFleetBudget implements FleetBudget {
  private warned = 0;

  constructor(
    private readonly redis: Redis,
    private readonly limits: FleetBudgetLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(runId: string, kind: string, scope?: BudgetScope | null): Promise<Admission> {
    const at = this.now();
    const w = windows(at);
    const name = scope?.scope ?? "";
    try {
      const [wait, detail] = (await this.redis.eval(
        ADMIT,
        9,
        `${K}:held`,
        `${K}:expiry`,
        `${K}:hour:${w.hourStamp}`,
        `${K}:day:${w.dayStamp}`,
        name === "" ? `${K}:expect:${kind}` : `${K}:expect:scope:${name}`,
        `${K}:held:${name}`,
        `${K}:scope:${name}:hour:${w.hourStamp}`,
        `${K}:scope:${name}:day:${w.dayStamp}`,
        `${K}:scopes`,
        at,
        runId,
        this.limits.expected,
        this.limits.hourly ?? 0,
        this.limits.daily ?? 0,
        this.limits.holdMs,
        w.untilHour,
        w.untilDay,
        name,
        scope?.hourly ?? 0,
        scope?.daily ?? 0,
      )) as [number, string];
      if (Number(wait) === 0) return { admitted: true };
      return { admitted: false, retryInMs: Number(wait), reason: `the ${detail} budget is spoken for` };
    } catch (error) {
      this.unreachable(error);
      return { admitted: true };
    }
  }

  async charge(runId: string, costUsd: number): Promise<void> {
    if (!(costUsd > 0)) return;
    const at = this.now();
    const w = windows(at);
    try {
      await this.redis.eval(
        CHARGE,
        6,
        `${K}:held`,
        `${K}:expiry`,
        `${K}:hour:${w.hourStamp}`,
        `${K}:day:${w.dayStamp}`,
        `${K}:spent`,
        `${K}:scopes`,
        at,
        runId,
        costUsd,
        this.limits.holdMs,
        w.hourStamp,
        w.dayStamp,
      );
    } catch (error) {
      this.unreachable(error);
    }
  }

  async settle(runId: string, kind: string): Promise<void> {
    try {
      await this.redis.eval(SETTLE, 4, `${K}:held`, `${K}:expiry`, `${K}:spent`, `${K}:scopes`, runId, this.limits.expected, kind);
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
  // A workflow's own caps need the budget even with no fleet cap set.
  const scoped = (env["VIGIL_FLEET_BUDGET_SCOPES"] ?? "").trim().toLowerCase() === "on";
  if (hourly === 0 && daily === 0 && !scoped) return null;
  return { hourly, daily, expected: usd("VIGIL_FLEET_EXPECTED_RUN_USD") || 0.05, holdMs: 6 * 3_600_000 };
}
