import type { RunOutcome } from "../../contracts/events.js";
import type { Answers } from "../../core/answers.js";
import type { Announce } from "../../core/checkpoints.js";
import type { AgentKinds } from "../../core/agent.js";
import type { Harness, Outcome } from "../../core/loop.js";
import type { RunSpec } from "../../core/spec.js";
import { runPlugin, stopFrom } from "../run.js";
import type { DirectiveQueue } from "../hunt/ports.js";
import type { NoticePayload, RootCauseKinds, StepPayload } from "./proof.js";

export type { NoticePayload, RootCauseKinds, StepPayload };

export interface RootCauseOptions {
  run_id: string;
  spec: RunSpec;
  started_by?: string;
  answers?: Answers;
  announce?: Announce;
  signal?: AbortSignal;
  // Where an operator's stop is queued. Read before the trace starts and polled
  // while it runs, so a cancel lands here rather than at the backend's backstop.
  queue?: DirectiveQueue;
}

export interface RootCauseReport {
  status: RunOutcome | "waiting_approval";
  reason: string;
  pending: Outcome<unknown>["pending"];
}

// A root-cause trace is the rootcause plugin on the kernel: one investigator, one
// loop, the proof in the plugin's hooks. Kept under this name so every caller and
// test that drives a trace drives the kernel.
export async function runRootCause(harness: Harness<RootCauseKinds>, options: RootCauseOptions): Promise<RootCauseReport> {
  const report = await runPlugin(
    "rootcause",
    harness as unknown as Harness<AgentKinds>,
    { run_id: options.run_id, run_kind: "root_cause", spec: options.spec, ...(options.started_by === undefined ? {} : { started_by: options.started_by }), ...(options.signal === undefined ? {} : { signal: options.signal }) },
    {
      ...(options.queue === undefined ? {} : { queue: options.queue }),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
      ...(options.announce === undefined ? {} : { announce: options.announce }),
    },
  );
  return { status: report.status, reason: report.reason, pending: report.pending };
}

export { stopFrom };
