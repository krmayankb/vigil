import type { PhasePayload } from "./vocabulary.js";
import type { RunOutcome } from "../../contracts/events.js";
import type { AgentKinds } from "../../core/agent.js";
import type { Harness, Outcome } from "../../core/loop.js";
import type { RunSpec } from "../../core/spec.js";
import { runPlugin } from "../run.js";
import { checkpointFor } from "./hooks.js";
import { nullMirror, type Mirror } from "./mirror.js";
import type { ComposeKinds } from "./vocabulary.js";

export { checkpointFor };

export interface ComposeOptions {
  run_id: string;
  spec: RunSpec;
  started_by?: string;
  mirror?: Mirror;
  // Aborted when this worker loses its lease: a run another worker has taken over
  // must stop writing, and stop paying for calls nobody will record.
  signal?: AbortSignal;
}

export interface ComposeReport {
  status: RunOutcome | "waiting_approval";
  reason: string;
  completed: number;
  total: number;
  pending: Outcome<unknown>["pending"];
}

// A composed playbook is the compose plugin on the kernel: the kernel opens, parks,
// stops and ends the run; the plugin walks the playbook's phases in order.
export async function runCompose(harness: Harness<ComposeKinds>, options: ComposeOptions): Promise<ComposeReport> {
  const report = await runPlugin(
    "compose",
    harness as unknown as Harness<AgentKinds>,
    { run_id: options.run_id, run_kind: "compose", spec: options.spec, started_by: options.started_by ?? "compose", ...(options.signal === undefined ? {} : { signal: options.signal }) },
    { mirror: options.mirror ?? nullMirror },
  );
  const done = (await harness.state.read(options.run_id)).filter((event) => event.kind === "phase").map((event) => event.payload as PhasePayload);
  return { status: report.status, reason: report.reason, completed: new Set(done.map((one) => one.phase_id)).size, total: options.spec.phases.length, pending: report.pending };
}
