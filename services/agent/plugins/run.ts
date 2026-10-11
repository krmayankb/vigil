import type { RunKind, TerminalHandoff } from "../contracts/events.js";
import { runAgent, type AgentKinds, type AgentOptions, type AgentReport, type PluginHooks, type StopSource } from "../core/agent.js";
import { noAnswers, type Answers } from "../core/answers.js";
import { noAnnounce, type Announce } from "../core/checkpoints.js";
import type { Harness } from "../core/loop.js";
import { SpecError, type RunSpec } from "../core/spec.js";
import { toolsFrom } from "../tools/remote.js";
import { composeHooks } from "./compose/hooks.js";
import { nullMirror, type Mirror } from "./compose/mirror.js";
import { huntSpec, recallKeysOf } from "./hunt/config.js";
import { huntHooks } from "./hunt/hooks.js";
import type { DirectiveQueue } from "./hunt/ports.js";
import { delegablePlugin, loadPlugin } from "./index.js";

// The one way a run of any plugin is started or picked up. The kernel runs every
// plugin the same; what differs is only what a plugin's hooks are built from --
// things only the worker holds, such as the operator's directive queue or the
// console mirror -- and the few options a plugin sets for itself. Both live in the
// table below, so the worker has no branch per kind, and a plugin that is files
// alone needs no entry at all.

// What the worker holds that a plugin's hooks may need. Each is optional, and its
// absence is the honest default: nobody to answer, nobody to tell.
export interface RunPorts {
  queue?: DirectiveQueue;
  mirror?: Mirror;
  answers?: Answers;
  announce?: Announce;
  onHandoff?: (runId: string, handoff: TerminalHandoff) => Promise<boolean>;
  onFindings?: (runId: string, findingIds: readonly string[]) => Promise<boolean>;
  onCost?: (runId: string, costUsd: number) => Promise<void>;
}

export interface PluginRun {
  run_id: string;
  run_kind: RunKind;
  spec: RunSpec;
  started_by?: string;
  signal?: AbortSignal;
}

interface Runtime {
  // Refuses a run before its ledger opens, for one that could never finish.
  check?(spec: RunSpec, ports: RunPorts): void;
  hooks?(ports: RunPorts, kind: RunKind): PluginHooks;
  options?(spec: RunSpec, ports: RunPorts): Partial<AgentOptions>;
}

const HUNT: Runtime = {
  hooks: (ports, kind) => {
    // Only a forward hunt files handoffs and the alerts it cites as it goes: an
    // adjudication proposes and executes nothing.
    const forward = kind === "hunt";
    return huntHooks({
      queue: queueOf(ports),
      handoffs: forward,
      ...(forward && ports.onHandoff !== undefined ? { onHandoff: ports.onHandoff } : {}),
      ...(forward && ports.onFindings !== undefined ? { onFindings: ports.onFindings } : {}),
      ...(ports.onCost === undefined ? {} : { onCost: ports.onCost }),
    });
  },
  // The hunt's own: declared subjects first, else what its statements name.
  options: (spec) => ({ recall_keys: recallKeysOf(huntSpec(spec)) }),
};

const RUNTIME: Readonly<Record<string, Runtime>> = {
  hunt: HUNT,
  adjudicate: HUNT,
  rootcause: {
    check: (spec) => {
      if (spec.roles.lead === undefined) throw new SpecError(`arch ${spec.arch} declares no lead, so it cannot trace a root cause`);
    },
  },
  compose: {
    // A step that stops for a human, on a deployment with nowhere to ask, parks on
    // its first gate and no answer can ever reach it.
    check: (spec, ports) => {
      if ((ports.mirror ?? nullMirror).answerable) return;
      const gated = spec.phases.filter((phase) => phase.approval_required).map((phase) => phase.id);
      if (gated.length > 0) throw new SpecError(`${spec.name} stops for a human at ${gated.join(", ")}, and no mirror is configured to carry a decision back`);
    },
    hooks: (ports) => composeHooks(ports.mirror ?? nullMirror),
    // Python records the decision and the mirror carries it back, so the ledger
    // keeps its single writer. The phase row is how a person is asked.
    options: (_spec, ports) => {
      const mirror = ports.mirror ?? nullMirror;
      return { answers: (runId) => mirror.decisions(runId), announce: noAnnounce };
    },
  },
};

export async function runPlugin(id: string, harness: Harness<AgentKinds>, run: PluginRun, ports: RunPorts = {}): Promise<AgentReport> {
  const runtime = RUNTIME[id] ?? {};
  runtime.check?.(run.spec, ports);
  const loaded = loadPlugin(id);
  const hooks = runtime.hooks?.(ports, run.run_kind) ?? loaded.hooks;
  return await runAgent(harness, {
    run_id: run.run_id,
    run_kind: run.run_kind,
    spec: run.spec,
    plugin: loaded.manifest,
    ...(hooks === undefined ? {} : { hooks }),
    tools: toolsFrom(run.spec.tools),
    plugins: delegablePlugin,
    started_by: run.started_by ?? "worker",
    answers: ports.answers ?? noAnswers,
    announce: ports.announce ?? noAnnounce,
    ...(ports.queue === undefined ? {} : { stop: stopFrom(ports.queue, run.run_id) }),
    ...(run.signal === undefined ? {} : { signal: run.signal }),
    ...(runtime.options?.(run.spec, ports) ?? {}),
  });
}

// An operator's stop, read off the same queue every plugin reads its directives from.
export function stopFrom(queue: DirectiveQueue, runId: string): StopSource {
  return async () => {
    const found = (await queue.pending(runId, [])).find((directive) => directive.kind === "abort");
    if (found === undefined) return null;
    const { directive_id, actor, kind, text, created_at } = found;
    return { directive_id, actor, kind, text, created_at };
  };
}

function queueOf(ports: RunPorts): DirectiveQueue {
  if (ports.queue === undefined) throw new SpecError("a hunt reads an operator's directives, and was given no queue to read them from");
  return ports.queue;
}
