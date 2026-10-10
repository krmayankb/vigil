import { AsyncLocalStorage } from "node:async_hooks";
import type { Lane } from "../contracts/job.js";

// The lane of the run this code is working for, carried by the async context the
// worker opens per job, so a shared limiter deep in a model call can tell a person's
// run from an automated one without every signature in between carrying it.
const current = new AsyncLocalStorage<Lane>();

export function inLane<T>(lane: Lane, work: () => Promise<T>): Promise<T> {
  return current.run(lane, work);
}

// Automated when nothing says otherwise: a person's run is the one that has to say so.
export function laneNow(): Lane {
  return current.getStore() ?? "automated";
}
