import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChildPayload, ConclusionPayload, RunPayload } from "../../contracts/events.js";
import type { PluginManifest } from "../../contracts/plugin.js";
import { defineTool, type RegisteredTool, type ToolResult } from "../../contracts/tool.js";
import { callsIn, CHILD_KIND, pluginGrants, runAgent, skillTool, type AgentKinds, type LoadedPlugin } from "../../core/agent.js";
import { budgetOf, unmeteredQuota } from "../../core/budget.js";
import { slicedBudget, spentBy } from "../../core/delegation.js";
import { localDispatch } from "../../core/dispatch.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import { registryOf } from "../../core/registry.js";
import { buildSpec, SpecError, type RunSpec } from "../../core/spec.js";
import { InProcessState } from "../../core/state.js";
import { archFor } from "../../plugins/kinds.js";
import { delegablePlugin } from "../../plugins/index.js";
import { parsePlugin, pluginFor } from "../../plugins/registry.js";
import { quiet } from "../support/plugins.js";
import { scriptedProvider, type ScriptedTurn } from "../support/scripted-provider.js";

// One run hands a piece of its work to another plugin. The child runs on a ledger
// of its own, its spend lands on the parent, its answer comes back as the call's
// result, and a question it raises parks the parent until a person answers.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const PARENT = "7d3c2d3e-0000-4000-8000-0000000006a1";
const HOST = "host:ws-17";

// A plugin that is a file and nothing else: what "a new plugin needs no code" means.
const HELPER: PluginManifest = parsePlugin(
  [
    "id: helper",
    "description: Answers one narrow question about a host.",
    "needs: [case_records, get_finding, telemetry_search]",
    "system: You answer the question you are given, briefly, from what the tools show.",
    "conclusion: prose",
    "record: off",
  ].join("\n"),
  [],
);

const plugins = (id: string): LoadedPlugin => {
  if (id === "helper") return { manifest: HELPER };
  throw new SpecError(`no plugin ${id}`);
};

function parentPlugin(share = 0.5): PluginManifest {
  return {
    ...quiet(pluginFor("investigate")),
    delegates: [{ verb: "ask_helper", plugin: "helper", description: "Ask the helper one narrow question about a host.", budget_share: share }],
  };
}

function specOf(approvals: string[] = []): RunSpec {
  const entry = archFor("investigate");
  const spec = buildSpec({ arch: entry.arch, playbook: join(FIXTURES, "case.playbook.yaml"), config: join(FIXTURES, "case.config.yaml") });
  return { ...spec, approvals, budgets: { ...spec.budgets, max_calls: 50, max_cost_usd: 2 } };
}

// Counts how many of its calls are in flight at once.
let inflight = 0;
let peak = 0;
function estateTool(id: string): RegisteredTool {
  return defineTool(
    {
      id,
      description: `stand-in for ${id}`,
      parameters: { type: "object", additionalProperties: true, properties: {} },
      execute: async (): Promise<ToolResult> => {
        inflight += 1;
        peak = Math.max(peak, inflight);
        await new Promise((done) => setTimeout(done, 40));
        inflight -= 1;
        return { ok: true, rows: [{ id, seen: "10.0.4.17 -> 198.51.100.7 every 300s" }], rowCount: 1, capped: false, sourceSystem: id };
      },
    },
    { maxRows: 10, timeoutMs: 1_000 },
  );
}

const call = (tool: string, args: unknown = {}) => ({ tool, args: JSON.stringify(args) });
const conclude = (disposition: string, citations: string[]) =>
  call("conclude", { summary: `ws-17 is ${disposition}`, disposition, confidence: "medium", citations, gaps: [], next_steps: [] });
// A million input tokens at a dollar a million: one call, one dollar.
const tokens = { input: 1_000_000 };

function harnessOf(spec: RunSpec, plugin: PluginManifest, script: ScriptedTurn[], state: InProcessState<AgentKinds>) {
  const provider = scriptedProvider(script);
  const tools = spec.tools.map((one) => estateTool(one.id));
  const harness: Harness<AgentKinds> = {
    provider,
    registry: registryOf([...tools, skillTool(plugin)], pluginGrants(plugin, spec.tools)),
    dispatch: localDispatch,
    // A dollar a call, so what the child spent is a number the test can read.
    budget: budgetOf(spec.budgets, unmeteredQuota, undefined, undefined, async () => ({ input: 1e-6, output: 0, cache_read: 0, cache_write: 0, source: "test", fetched_at: null })),
    memory: nullMemory,
    state,
  };
  return { harness, provider, tools };
}

describe("handing work to another plugin", () => {
  it("runs the child on its own ledger, linked both ways, and answers with what it concluded", async () => {
    const state = new InProcessState<AgentKinds>();
    const spec = specOf();
    const plugin = parentPlugin();
    const { harness, tools } = harnessOf(
      spec,
      plugin,
      [
        { calls: [call("ask_helper", { task: "Does ws-17 beacon?" })] },
        { content: "ws-17 beacons to 198.51.100.7 every 300s.", tokens },
        { calls: [conclude("malicious", ["r1"])] },
      ],
      state,
    );
    const report = await runAgent(harness, { run_id: PARENT, run_kind: "investigate", spec, plugin, tools, plugins, recall_keys: [HOST] });
    expect(report.status).toBe("completed");

    const parent = await state.read(PARENT);
    const handed = callsIn(parent).find((one) => one.tool === "ask_helper")!;
    expect(handed.ok).toBe(true);
    expect(handed.result).toContain("ws-17 beacons to 198.51.100.7");
    const link = parent.find((one) => one.kind === "child")!.payload as ChildPayload;
    expect(link).toMatchObject({ role: "ask_helper", outcome: "completed" });

    const child = await state.read(link.child_run_id);
    const opened = child[0]!.payload as RunPayload;
    expect(child[0]!.run_kind).toBe(CHILD_KIND);
    expect(opened.parent).toMatchObject({ run_id: PARENT, role: "ask_helper" });
    expect((opened.spec as RunSpec).prompt).toBe("Does ws-17 beacon?");
    expect((child.find((one) => one.kind === "conclusion")!.payload as ConclusionPayload).plugin).toBe("helper");
    // The child's model call is billed on the parent, marked as the child's.
    expect(child.some((one) => one.kind === "spend")).toBe(false);
    expect(spentBy(parent, link.child_run_id)).toBe(1);
    expect(link.cost_usd).toBe(1);
    // A child is never handed delegation of its own.
    expect(callsIn(child).some((one) => one.tool === "ask_helper")).toBe(false);
  });

  it("runs several hand-offs in one turn at once", async () => {
    inflight = 0;
    peak = 0;
    const state = new InProcessState<AgentKinds>();
    const spec = specOf();
    const plugin = parentPlugin(0.25);
    const { harness, tools } = harnessOf(
      spec,
      plugin,
      [
        { calls: [call("ask_helper", { task: "Does ws-17 beacon?" }), call("ask_helper", { task: "Who logged on to ws-17?" })] },
        // Each child's first turn queries; both are in flight before either answers.
        { calls: [call("get_finding", { finding_id: "f-1" })] },
        { calls: [call("get_finding", { finding_id: "f-1" })] },
        { content: "answered" },
        { content: "answered" },
        { calls: [conclude("malicious", ["r1", "r2"])] },
      ],
      state,
    );
    const report = await runAgent(harness, { run_id: PARENT, run_kind: "investigate", spec, plugin, tools, plugins, recall_keys: [HOST] });
    expect(report.status).toBe("completed");
    expect(peak).toBe(2);
    const handed = callsIn(await state.read(PARENT)).filter((one) => one.tool === "ask_helper");
    expect(handed.map((one) => one.ref)).toEqual(["r1", "r2"]);
    expect((await state.read(PARENT)).filter((one) => one.kind === "child")).toHaveLength(2);
  });

  it("parks the parent on a question the child raises, and carries the answer down", async () => {
    const state = new InProcessState<AgentKinds>();
    const spec = specOf(["get_finding"]);
    const plugin = parentPlugin();
    const ask = call("ask_helper", { task: "Pull finding f-1 and say what it shows." });
    const first = harnessOf(spec, plugin, [{ calls: [ask] }, { calls: [call("get_finding", { finding_id: "f-1" })] }], state);
    const parked = await runAgent(first.harness, { run_id: PARENT, run_kind: "investigate", spec, plugin, tools: first.tools, plugins, recall_keys: [HOST] });
    expect(parked.status).toBe("waiting_approval");
    const checkpoint = (await state.read(PARENT)).find((one) => one.kind === "checkpoint")!.payload as { checkpoint_id: string; question: string };
    expect(checkpoint.question).toContain("ask_helper");
    expect(parked.pending?.checkpoint_id).toBe(checkpoint.checkpoint_id);

    const answers = async () => [{ checkpoint_id: checkpoint.checkpoint_id, actor: "analyst", answer: "approve" as const, text: "", resolved_at: new Date().toISOString() }];
    const second = harnessOf(
      spec,
      plugin,
      [{ calls: [ask] }, { calls: [call("get_finding", { finding_id: "f-1" })] }, { content: "f-1 shows beaconing." }, { calls: [conclude("malicious", ["r2"])] }],
      state,
    );
    const done = await runAgent(second.harness, { run_id: PARENT, run_kind: "investigate", spec, plugin, tools: second.tools, plugins, recall_keys: [HOST], answers });
    expect(done.status).toBe("completed");
    const handed = callsIn(await state.read(PARENT)).filter((one) => one.tool === "ask_helper");
    expect(handed.at(-1)!.result).toContain("f-1 shows beaconing.");
    const link = (await state.read(PARENT)).find((one) => one.kind === "child")!.payload as ChildPayload;
    const child = await state.read(link.child_run_id);
    expect(child.some((one) => one.kind === "resolution")).toBe(true);
    expect(callsIn(child).some((one) => one.tool === "get_finding" && one.ok)).toBe(true);
  });

  it("offers nothing to hand off when the deployment gives the run no plugins", async () => {
    const state = new InProcessState<AgentKinds>();
    const spec = specOf();
    const plugin = parentPlugin();
    const { harness, tools, provider } = harnessOf(spec, plugin, [{ calls: [conclude("malicious", [])] }], state);
    await runAgent(harness, { run_id: PARENT, run_kind: "investigate", spec, plugin, tools, recall_keys: [HOST] });
    expect(provider.requests[0]!.tools.map((one) => one.id)).not.toContain("ask_helper");
  });
});

describe("a child's share of the budget", () => {
  it("refuses a call once the share is spent, and charges every call to the parent too", async () => {
    const parent = budgetOf({ ...specOf().budgets, max_cost_usd: 10 }, unmeteredQuota);
    const slice = slicedBudget(parent, 2, 1.5);
    expect(slice.limits.max_cost_usd).toBe(2);
    expect(await slice.beginCall()).toBeNull();
    slice.record({ model_id: "m", provider_type: "p", role: "agent", tokens: { input: 1, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.6, pricing_source: "t", rates: null, fetched_at: null });
    expect(parent.spent.cost_usd).toBeCloseTo(0.6);
    expect(await slice.beginCall()).toMatchObject({ reason: "cost_exhausted", limit_usd: 2 });
  });
});

describe("delegates in plugin.yaml", () => {
  const base = ["id: lead", "description: d", "system: s", "conclusion: prose"];
  it("reads a delegate, with a default share", () => {
    const plugin = parsePlugin([...base, "delegates:", "  - verb: trace_root_cause", "    plugin: rootcause", "    description: Trace it."].join("\n"), []);
    expect(plugin.delegates).toEqual([{ verb: "trace_root_cause", plugin: "rootcause", description: "Trace it.", budget_share: 0.25 }]);
  });
  it.each([
    ["a verb that is not a tool name", "  - verb: Trace It\n    plugin: rootcause\n    description: x"],
    ["a verb the kernel already offers", "  - verb: conclude\n    plugin: rootcause\n    description: x"],
    ["delegating to itself", "  - verb: again\n    plugin: lead\n    description: x"],
    ["a share above one", "  - verb: trace\n    plugin: rootcause\n    description: x\n    budget_share: 2"],
  ])("refuses %s", (_name, entry) => {
    expect(() => parsePlugin([...base, "delegates:", entry].join("\n"), [])).toThrow(SpecError);
  });
  it("names only plugins another run can hand work to", () => {
    expect(() => delegablePlugin("hunt")).toThrow(SpecError);
    expect(delegablePlugin("rootcause").manifest.id).toBe("rootcause");
  });
});
