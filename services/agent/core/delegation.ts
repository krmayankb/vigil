import { forModels } from "./guards.js";
import { createHash } from "node:crypto";
import type { Budget, Refusal, Spend, SpendPayload } from "../contracts/budget.js";
import type { CheckpointPayload, ConclusionPayload, NewEvent, ResolutionPayload, TerminalPayload } from "../contracts/events.js";
import type { DelegateSpec } from "../contracts/plugin.js";
import { defineTool, type RegisteredTool, type ToolResult } from "../contracts/tool.js";
import { addTokens } from "./budget.js";
import { childRunId } from "./frames.js";
import type { Harness } from "./loop.js";
import { CHILD_KIND, isLean, lastPayload, linkChild, runAgent, type AgentKinds, type PluginContext } from "./agent.js";
import { ZERO_TOKENS } from "../contracts/budget.js";

// Handing work to another plugin. A plugin names the work it may hand off in its
// plugin.yaml (`delegates`), and each becomes a tool by its verb. Calling it runs the
// named plugin as a run of its own: its own ledger, linked both ways to this one, the
// kernel's whole loop, and the child plugin's own answer, review and record. The
// child's model spend is journaled on the parent, so the parent's bill and budget
// count it, and it may spend only its share of what the parent has left.
//
// One level only: a child is never handed delegation of its own.
//
// A child that parks on a question parks its parent on the same question. The
// answer reaches the parent's ledger the way any answer does; the next call with the
// same arguments carries it to the child, which goes on from where it stopped.

export const DELEGATE_CHECKPOINT = "delegated_approval";

const TASK_LIMIT = 4_000;
const ENTITY_LIMIT = 20;

type Kinds = AgentKinds;

export function delegateTools(ctx: PluginContext): RegisteredTool[] {
  const { options } = ctx;
  const declared = options.plugin.delegates ?? [];
  // A lean run hands nothing off: a child is a second run's worth of spend.
  if (declared.length === 0 || options.plugins === undefined || options.run_kind === CHILD_KIND || options.conversation !== undefined || isLean(options.spec)) return [];
  return declared.map((delegate) => delegateTool(ctx, delegate));
}

function delegateTool(ctx: PluginContext, delegate: DelegateSpec): RegisteredTool {
  const tool = defineTool(
    {
      id: delegate.verb,
      description: [
        delegate.description.trim(),
        `Runs the ${delegate.plugin} agent on the task you give it, as a run of its own, and answers with its conclusion.`,
        "Give it everything it needs in the task: it sees nothing of this run. Its answer is another agent's work, to weigh like any result.",
      ].join(" "),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["task"],
        properties: {
          task: { type: "string", description: "What the other agent is to do, and what you already know that bears on it." },
          entities: { type: "array", items: { type: "string" }, description: "Entity keys the work is about, such as host:ws-17. Absent: this run's own." },
        },
      },
      execute: (args) => handOff(ctx, delegate, args),
    },
    { maxRows: 1, timeoutMs: 24 * 60 * 60 * 1000 },
    true,
  );
  return Object.assign(tool, { concurrent: true });
}

async function handOff(ctx: PluginContext, delegate: DelegateSpec, args: Record<string, unknown>): Promise<ToolResult> {
  const { harness, options } = ctx;
  const task = typeof args["task"] === "string" ? args["task"].trim() : "";
  if (task === "") return { ok: false, failure: { kind: "invalid_args", detail: "task is required" } };
  if (task.length > TASK_LIMIT) return { ok: false, failure: { kind: "invalid_args", detail: `task is over ${TASK_LIMIT} characters` } };
  const asked = Array.isArray(args["entities"]) ? (args["entities"] as unknown[]).filter((key): key is string => typeof key === "string" && key !== "") : null;
  const entities = [...new Set(asked ?? options.recall_keys ?? keysOf(options.spec.sections))].sort().slice(0, ENTITY_LIMIT);

  let loaded;
  try {
    loaded = (options.plugins as NonNullable<typeof options.plugins>)(delegate.plugin);
  } catch (error) {
    return { ok: false, failure: { kind: "refused", detail: `no plugin ${delegate.plugin} to hand this to: ${(error as Error).message}` } };
  }

  // The same work asked for twice is the same child: a resumed parent finds the run
  // it started rather than starting another, and a parked one is picked up again.
  const key = `${delegate.verb}:${digest({ task, entities })}`;
  const child = childRunId(options.run_id, key);
  const parentHeld = await harness.state.read(options.run_id);
  const childHeld = await harness.state.read(child);
  await carryAnswers(harness, child, childHeld, parentHeld);

  const ended = lastPayload<TerminalPayload>(childHeld, "terminal");
  if (ended === null) {
    const opening = lastPayload<{ budgets?: { max_cost_usd?: number } }>(childHeld, "run");
    const share = opening?.budgets?.max_cost_usd ?? shareOf(harness.budget, delegate.budget_share);
    const spentSoFar = spentBy(parentHeld, child);
    const childHarness: Harness<Kinds> = { ...baseOf(ctx), budget: slicedBudget(harness.budget, share, spentSoFar) };
    const childSpec = {
      ...options.spec,
      name: `${options.spec.name} / ${delegate.verb}`,
      // The child is another model, holding none of this run's handles (core/guards.ts).
      prompt: forModels(task),
      objectives: [],
      narrative: "",
      sections: { ...options.spec.sections, recall_keys: entities },
    };
    const report = await runAgent(childHarness, {
      run_id: child,
      run_kind: CHILD_KIND,
      spec: childSpec,
      plugin: { ...loaded.manifest, ...(delegate.max_turns === undefined ? {} : { max_turns: delegate.max_turns }) },
      ...(loaded.hooks === undefined ? {} : { hooks: loaded.hooks }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
      started_by: options.run_id,
      recall_keys: entities,
      parent: { run_id: options.run_id, run_kind: options.run_kind, role: delegate.verb, key },
      spend_to: options.spend_to ?? { run_id: options.run_id, run_kind: options.run_kind },
      ...(options.stop === undefined ? {} : { stop: options.stop }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (report.status === "waiting_approval") return await parkParent(ctx, delegate, child, report.pending?.checkpoint_id ?? null, report.reason);
  }

  const held = await harness.state.read(child);
  const terminal = lastPayload<TerminalPayload>(held, "terminal");
  if (terminal === null) return { ok: false, failure: { kind: "unavailable", detail: `the ${delegate.plugin} run ${child} stopped without ending` } };
  const conclusion = lastPayload<ConclusionPayload>(held, "conclusion");
  const cost_usd = Number(spentBy(await harness.state.read(options.run_id), child).toFixed(6));
  await linkChild({ harness, options }, child, delegate.verb, key, terminal.outcome, terminal.reason, held, cost_usd);
  return {
    ok: true,
    rows: [{ child_run_id: child, plugin: delegate.plugin, outcome: terminal.outcome, reason: terminal.reason, answer: conclusion?.value ?? null, cost_usd }],
    rowCount: 1,
    capped: false,
    sourceSystem: `delegate:${delegate.plugin}`,
  };
}

// The child's question, raised on the parent under the same id: a person answers
// the parent, as for any of its questions, and the answer is carried down.
async function parkParent(ctx: PluginContext, delegate: DelegateSpec, child: string, checkpointId: string | null, reason: string): Promise<ToolResult> {
  const { harness, options } = ctx;
  if (checkpointId === null) {
    return { ok: false, failure: { kind: "unavailable", detail: `the ${delegate.plugin} run ${child} is waiting (${reason}) on nothing anyone can answer` } };
  }
  const asked = (await harness.state.read(child))
    .filter((one) => one.kind === "checkpoint")
    .map((one) => one.payload as CheckpointPayload)
    .find((one) => one.checkpoint_id === checkpointId);
  const parentHeld = await harness.state.read(options.run_id);
  const raised = parentHeld.some((one) => one.kind === "checkpoint" && (one.payload as CheckpointPayload).checkpoint_id === checkpointId);
  if (!raised) {
    const payload: CheckpointPayload = {
      checkpoint_id: checkpointId,
      checkpoint_class: DELEGATE_CHECKPOINT,
      question: `${delegate.verb} (run ${child}) asks: ${asked?.question ?? reason}`,
      raised_at: new Date().toISOString(),
      context: { child_run_id: child, plugin: delegate.plugin },
    };
    await harness.state.append(options.run_id, [{ run_id: options.run_id, run_kind: options.run_kind, kind: "checkpoint", payload } as unknown as NewEvent<Kinds>]);
  }
  return {
    ok: true,
    rows: [{ child_run_id: child, plugin: delegate.plugin, outcome: "waiting_approval", question: asked?.question ?? reason, next: `This run waits for the answer. Once it is given, call ${delegate.verb} again with the same arguments to collect the result.` }],
    rowCount: 1,
    capped: false,
    sourceSystem: `delegate:${delegate.plugin}`,
  };
}

// Answers given on the parent to questions the child raised, copied onto the child
// before it is picked up again: the child reads its own ledger, and nothing else.
async function carryAnswers(
  harness: Harness<Kinds>,
  child: string,
  childHeld: readonly { kind: string; payload: unknown }[],
  parentHeld: readonly { kind: string; payload: unknown }[],
): Promise<void> {
  const open = new Set(childHeld.filter((one) => one.kind === "checkpoint").map((one) => (one.payload as CheckpointPayload).checkpoint_id));
  for (const one of childHeld) if (one.kind === "resolution") open.delete((one.payload as ResolutionPayload).checkpoint_id);
  if (open.size === 0) return;
  const answers = parentHeld
    .filter((one) => one.kind === "resolution")
    .map((one) => one.payload as ResolutionPayload)
    .filter((one) => open.has(one.checkpoint_id));
  if (answers.length === 0) return;
  await harness.state.append(child, answers.map((payload) => ({ run_id: child, run_kind: CHILD_KIND, kind: "resolution", payload }) as unknown as NewEvent<Kinds>));
}

// The harness as the run was handed it, before its own tools were added: a child is
// equipped by its own plugin, and reads no other run's findings mid-flight.
function baseOf(ctx: PluginContext): Harness<Kinds> {
  const { shared: _shared, ...rest } = ctx.harness;
  return rest;
}

// What the child may spend: its share of what the parent has left, fixed when it
// starts and journaled on its run event, so a resume holds it to the same figure.
function shareOf(parent: Budget, share: number): number {
  const limit = parent.limits.max_cost_usd;
  if (!Number.isFinite(limit)) return limit;
  return Number((Math.max(0, limit - parent.spent.cost_usd) * share).toFixed(6));
}

// What a child has spent, read off the parent's ledger, where its calls are journaled.
export function spentBy(events: readonly { kind: string; payload: unknown }[], child: string): number {
  return events
    .filter((one) => one.kind === "spend" && (one.payload as SpendPayload).spent_by === child)
    .reduce((sum, one) => sum + ((one.payload as SpendPayload).cost_usd ?? 0), 0);
}

// The parent's pool, held to a ceiling of the child's own. Every call still counts
// against the parent, so the parent's own ceilings hold whatever the slice says.
export function slicedBudget(parent: Budget, cap_usd: number, already_usd = 0): Budget {
  let cost = already_usd;
  let calls = 0;
  let tokens = ZERO_TOKENS;
  return {
    get limits() {
      return { ...parent.limits, max_cost_usd: cap_usd };
    },
    get spent(): Spend {
      return { calls, cost_usd: cost, tokens };
    },
    async beginCall(): Promise<Refusal | null> {
      if (cost >= cap_usd) return { reason: "cost_exhausted", used_usd: cost, limit_usd: cap_usd };
      return parent.beginCall();
    },
    raise: (limits) => parent.raise(limits),
    record(payload) {
      parent.record(payload);
      calls += 1;
      cost += payload.cost_usd ?? 0;
      tokens = addTokens(tokens, payload.tokens);
    },
    release: () => parent.release(),
    priceOf: (modelId, providerType, counts) => parent.priceOf(modelId, providerType, counts),
  };
}

function keysOf(sections: Record<string, unknown>): string[] {
  const held = sections["recall_keys"];
  return Array.isArray(held) ? held.filter((key): key is string => typeof key === "string" && key !== "") : [];
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}
