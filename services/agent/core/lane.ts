import { AsyncLocalStorage } from "node:async_hooks";
import type { Lane } from "../contracts/job.js";

// The run this code is working for -- its id and its lane -- carried by the async
// context the worker opens per job, so a shared limiter or the fleet budget deep in
// a model call can tell whose call it is without every signature in between carrying
// it. A child run (a judge, a subagent) runs inside its parent's context, so its
// calls are charged to the parent, as its spend already is.
interface RunContext {
  lane: Lane;
  runId?: string;
}

const current = new AsyncLocalStorage<RunContext>();

export function inLane<T>(lane: Lane, work: () => Promise<T>, runId?: string): Promise<T> {
  return current.run(runId === undefined ? { lane } : { lane, runId }, work);
}

// Automated when nothing says otherwise: a person's run is the one that has to say so.
export function laneNow(): Lane {
  return current.getStore()?.lane ?? "automated";
}

export function runNow(): string | undefined {
  return current.getStore()?.runId;
}
