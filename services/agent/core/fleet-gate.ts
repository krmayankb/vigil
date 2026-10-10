import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { laneNow } from "./lane.js";
import { errorFields, logger } from "./log.js";

const log = logger("agent.fleet-gate");

// One allowance shared by every worker, kept in Redis: how many calls may be in
// flight at once, and how many requests and tokens a minute. A worker's own limiter
// bounds one process; with N replicas the provider sees N times it, so the ceiling a
// provider actually enforces has to be counted in one place.
//
// A slot is held as an entry that expires: a worker that dies mid-call gives its
// slot back when the entry lapses rather than never. Requests and tokens are counted
// per wall-clock minute. If Redis cannot be reached the gate opens and says so --
// the per-process limiter still holds, and a fleet that stops because its counter
// is down has traded an overload for an outage.
export interface FleetLimits {
  // 0 or absent means no limit of that kind.
  concurrency?: number;
  // Slots of the concurrency automated runs may not take, kept for runs a person is
  // waiting on. Human runs may use every slot.
  humanReserve?: number;
  rpm?: number;
  tpm?: number;
}

export type Release = () => Promise<void>;

export interface Gate {
  acquire(tokens: number, signal?: AbortSignal): Promise<Release>;
}

export const openGate: Gate = { acquire: async () => async () => {} };

// Returns 0 when the slot was taken, else how long to wait before asking again.
const ACQUIRE = `
local inflight, rpm, tpm = KEYS[1], KEYS[2], KEYS[3]
local now, hold, id = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3]
local maxc, maxr, maxt, want = tonumber(ARGV[4]), tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local reserve = tonumber(ARGV[8])
local nextMinute = 60000 - (now % 60000)
redis.call('ZREMRANGEBYSCORE', inflight, '-inf', now)
if maxc > 0 and redis.call('ZCARD', inflight) >= maxc - reserve then return 50 end
if maxr > 0 and (tonumber(redis.call('GET', rpm) or '0') + 1) > maxr then return nextMinute end
if maxt > 0 then
  if want > maxt then want = maxt end
  if (tonumber(redis.call('GET', tpm) or '0') + want) > maxt then return nextMinute end
end
redis.call('ZADD', inflight, now + hold, id)
redis.call('PEXPIRE', inflight, hold + 60000)
if maxr > 0 then redis.call('INCR', rpm); redis.call('PEXPIRE', rpm, 120000) end
if maxt > 0 then redis.call('INCRBY', tpm, want); redis.call('PEXPIRE', tpm, 120000) end
return 0
`;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done, fail) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        fail(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });

export class RedisGate implements Gate {
  // When the last "unreachable" was logged: once per 30s, not once per call, or an
  // outage writes a line for every call the fleet makes.
  private warned = 0;

  constructor(
    private readonly redis: Redis,
    // What is being shared, e.g. "llm:vertex" or "tool:splunk_search".
    private readonly scope: string,
    private readonly limits: FleetLimits,
    // How long a slot is held at most: a call that outlives it stops counting.
    private readonly holdMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private keys(at: number): [string, string, string] {
    const minute = Math.floor(at / 60_000);
    const base = `vigil:gate:${this.scope}`;
    return [`${base}:inflight`, `${base}:rpm:${minute}`, `${base}:tpm:${minute}`];
  }

  async acquire(tokens: number, signal?: AbortSignal): Promise<Release> {
    const id = randomUUID();
    let waited = 0;
    for (;;) {
      signal?.throwIfAborted();
      const at = this.now();
      let wait: number;
      try {
        wait = Number(
          await this.redis.eval(
            ACQUIRE,
            3,
            ...this.keys(at),
            at,
            this.holdMs,
            id,
            this.limits.concurrency ?? 0,
            this.limits.rpm ?? 0,
            this.limits.tpm ?? 0,
            Math.max(1, Math.round(tokens)),
            laneNow() === "human" ? 0 : Math.min(this.limits.humanReserve ?? 0, Math.max(0, (this.limits.concurrency ?? 0) - 1)),
          ),
        );
      } catch (error) {
        if (Date.now() - this.warned > 30_000) {
          this.warned = Date.now();
          log.warn("fleet gate unreachable; proceeding without it", { scope: this.scope, ...errorFields(error) });
        }
        return async () => {};
      }
      if (wait === 0) {
        if (waited > 5_000) log.info("fleet gate admitted after waiting", { scope: this.scope, waited_ms: waited });
        const [inflight] = this.keys(at);
        return async () => {
          await this.redis.zrem(inflight, id).catch(() => undefined);
        };
      }
      // Jittered and capped, so a crowd of waiters does not ask in step.
      const pause = Math.min(wait, 250) * (0.5 + Math.random());
      waited += pause;
      await sleep(pause, signal);
    }
  }
}

// A gate per scope, configured from the environment. Unset limits mean no gate.
export function fleetLimitsFrom(prefix: string, env: NodeJS.ProcessEnv = process.env): FleetLimits | null {
  const read = (name: string) => {
    const value = Number(env[`${prefix}_${name}`]);
    return Number.isInteger(value) && value > 0 ? value : 0;
  };
  const limits = { concurrency: read("CONCURRENCY"), rpm: read("RPM"), tpm: read("TPM"), humanReserve: read("HUMAN_RESERVE") };
  return limits.concurrency + limits.rpm + limits.tpm === 0 ? null : limits;
}
