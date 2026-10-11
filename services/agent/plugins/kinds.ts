import { fileURLToPath } from "node:url";
import type { AgentEvent, RunKind } from "../contracts/events.js";
import type { Notes } from "../core/memory.js";
import type { State } from "../core/seams.js";
import { SpecError, type Owned } from "../core/spec.js";
import { composeProjection } from "./compose/projection.js";
import { huntDistil } from "./hunt/distil.js";
import { kernelDistil } from "./kernel-distil.js";
import type { HuntKinds } from "./hunt/ledger.js";
import { huntProjection } from "./hunt/projection.js";
import { huntNotes } from "./hunt/recall.js";
import { leadProjection } from "./investigate/legacy/projection.js";
import { isAgentRun } from "../core/agent.js";
import { investigateView } from "./investigate/view.js";
import { huntView } from "./hunt/view.js";
import type { LeadKinds } from "./investigate/legacy/vocabulary.js";
import { rootCauseProjection } from "./rootcause/projection.js";
import type { RootCauseKinds } from "./rootcause/proof.js";

// The plugin each run kind runs on. core/triage/routes.py RUN_KIND_PLUGINS says the
// same; a ratchet holds the two equal.
export const KIND_PLUGINS: Readonly<Record<Exclude<RunKind, "tally" | "subagent">, string>> = {
  hunt: "hunt",
  adjudicate: "adjudicate",
  investigate: "investigate",
  root_cause: "rootcause",
  compose: "compose",
  chat: "chat",
};

// What the code beside a kind's plugin says about its runs: what the console and
// memory read of them. Every kind runs the same way (plugins/run.ts); this is only
// how its ledger is read afterwards.
export interface ArchEntry {
  arch: string;
  // Whether the kind keeps the hunt's record: its runs can be written up and replayed
  // as hunts. hunt and adjudicate do.
  hunt_like?: boolean;
  // Sections of the playbook and config this workflow reads. The loader accepts
  // them and looks no further: their meaning is the workflow's to give.
  owned?: Owned;
  // How a later run recalls a finished one of this kind. Absent means it carries
  // nothing forward, which is the honest default rather than a summary of events.
  notes?: (state: State, runId: string) => Notes;
  // What a reader outside this process is told about a run of this kind. Absent
  // means there is nothing to report but the terminal the ledger already carries.
  projection?: (runId: string, events: readonly AgentEvent<Record<never, never>>[]) => unknown;
  // What episodic memory is told about a finished run of this kind; the fold
  // itself says why it is not the projection. Absent means a run of this kind is
  // not distilled, which is the honest default rather than empty rows.
  distil?: (runId: string, events: readonly AgentEvent<Record<never, never>>[]) => unknown;
}

// What `hunt` and `adjudicate` share: ownership, projection and notes. They differ
// only in the plugin that frames the job, so drift between them is impossible
// rather than a two-place edit.
// notes/projection are retyped here because this is the one place that already knows
// the kind, the same trade the worker makes when it hands a ledger to a workflow.
const HUNT_LOOP: Omit<ArchEntry, "arch"> = {
  hunt_like: true,
  owned: { playbook: ["hypotheses", "attack_techniques", "data_domains"], config: ["enrichment", "checkpoints", "hypothesis_loop"] },
  notes: (state, runId) => huntNotes(state as unknown as State<HuntKinds>, runId),
  // Either engine answers in the hunt's shape; a kernel hunt's moves are its calls.
  projection: (runId, events) => (isAgentRun(events) ? huntView(runId, events) : huntProjection(runId, events as readonly AgentEvent<HuntKinds>[])),
};

const REGISTERED: Partial<Record<RunKind, ArchEntry>> = {
  // distil is not in HUNT_LOOP: huntDistil stamps investigation_kind "hunt", and
  // that is the only kind episodic memory accepts for a run. Sharing it would
  // file an adjudication under a kind it is not.
  hunt: {
    arch: packaged(KIND_PLUGINS.hunt),
    ...HUNT_LOOP,
    distil: (runId, events) => huntDistil(runId, events as readonly AgentEvent<HuntKinds>[]),
  },
  // One investigator, prose, no hunt vocabulary. checkpoints is owned so a
  // definition that sets hypothesis_approval: ask still parses and can park.
  root_cause: {
    arch: packaged(KIND_PLUGINS.root_cause),
    owned: { config: ["checkpoints"] },
    distil: kernelDistil,
    projection: (runId, events) => rootCauseProjection(runId, events as readonly AgentEvent<RootCauseKinds>[]),
  },
  // adjudicate is a hunt run as a second opinion: the lead is shown a finding
  // intake admitted and the workflow intake chose, tests the stated intent against
  // the seeded benign account, and proposes a workflow without starting one. Same
  // HUNT_LOOP, no distil for the reason given above.
  adjudicate: { arch: packaged(KIND_PLUGINS.adjudicate), ...HUNT_LOOP },
  investigate: {
    arch: packaged(KIND_PLUGINS.investigate),
    // Every investigation teaches memory, tagged with how it ended (kernel-distil.ts).
    distil: kernelDistil,
    // Either engine answers in the lead's shape, so the console needs no second view.
    projection: (runId, events) =>
      isAgentRun(events) ? investigateView(runId, events) : leadProjection(runId, events as readonly AgentEvent<LeadKinds>[]),
  },
  compose: { arch: packaged(KIND_PLUGINS.compose), projection: composeProjection },
  // Served over SSE by serve.ts rather than the queue, so drive() never sees it.
  chat: { arch: packaged(KIND_PLUGINS.chat) },
};

// A plugin's plugin.yaml, which carries the arch layer too. Resolved against the
// package rather than the cwd: the plugins ship with the worker, so a run started
// from any directory finds the same ones.
function packaged(plugin: string): string {
  return fileURLToPath(new URL(`./${plugin}/plugin.yaml`, import.meta.url));
}

export function archFor(kind: RunKind): ArchEntry {
  const entry = REGISTERED[kind];
  if (entry === undefined) {
    throw new SpecError(`no architecture is registered for run_kind ${kind}; registered: ${registeredKinds().join(", ")}`);
  }
  return entry;
}

export function registeredKinds(): RunKind[] {
  return (Object.keys(REGISTERED) as RunKind[]).sort();
}

// Whether a kind runs the shared hunt lead-loop -- `hunt`, `adjudicate`, and any
// future kind that reuses HUNT_LOOP. The one place the membership is decided, so a
// new hunt-like kind is registered above and nothing downstream has to be found and
// widened by hand. Mirrors Python's is_hunt_like / HUNT_LIKE_RUN_KINDS.
export function isHuntLike(kind: RunKind): boolean {
  return REGISTERED[kind]?.hunt_like === true;
}
