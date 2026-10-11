import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginManifest } from "../../contracts/plugin.js";
import { defineTool, type RegisteredTool, type ToolResult } from "../../contracts/tool.js";
import { pluginGrants, runAgent, skillTool, type AgentKinds } from "../../core/agent.js";
import { budgetOf, unmeteredQuota } from "../../core/budget.js";
import { localDispatch } from "../../core/dispatch.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import { registryOf } from "../../core/registry.js";
import { buildSpec, type RunSpec } from "../../core/spec.js";
import { InProcessState } from "../../core/state.js";
import { kernelDistil } from "../../plugins/kernel-distil.js";
import { archFor } from "../../plugins/kinds.js";
import { pluginFor } from "../../plugins/registry.js";
import { quiet } from "../support/plugins.js";
import { scriptedProvider, type ScriptedTurn } from "../support/scripted-provider.js";

// What memory is told about a finished investigation: its answer, filed as holding
// only if it stood, its claims, where its entities were seen, and how it came to be.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const RUN = "7d3c2d3e-0000-4000-8000-0000000007a1";
const IP = "ip:198.51.100.7";

function specOf(): RunSpec {
  const entry = archFor("investigate");
  const spec = buildSpec({ arch: entry.arch, playbook: join(FIXTURES, "case.playbook.yaml"), config: join(FIXTURES, "case.config.yaml") });
  return { ...spec, budgets: { ...spec.budgets, max_calls: 50 } };
}

function estateTool(id: string): RegisteredTool {
  return defineTool(
    { id, description: `stand-in for ${id}`, parameters: { type: "object", additionalProperties: true, properties: {} }, execute: async (): Promise<ToolResult> => ({ ok: true, rows: [{ seen: "10.0.4.17 -> 198.51.100.7 every 300s" }], rowCount: 1, capped: false, sourceSystem: id }) },
    { maxRows: 10, timeoutMs: 1_000 },
  );
}

const call = (tool: string, args: unknown = {}) => ({ tool, args: JSON.stringify(args) });
const conclude = (disposition: string, citations: string[]) =>
  call("conclude", { summary: `the traffic is ${disposition}`, disposition, confidence: "medium", citations, gaps: [], next_steps: [] });

async function distilled(script: ScriptedTurn[]) {
  const spec = specOf();
  const plugin: PluginManifest = quiet(pluginFor("investigate"));
  const state = new InProcessState<AgentKinds>();
  const harness: Harness<AgentKinds> = {
    provider: scriptedProvider(script),
    registry: registryOf([...spec.tools.map((one) => estateTool(one.id)), skillTool(plugin)], pluginGrants(plugin, spec.tools)),
    dispatch: localDispatch,
    budget: budgetOf(spec.budgets, unmeteredQuota),
    memory: nullMemory,
    state,
  };
  await runAgent(harness, { run_id: RUN, run_kind: "investigate", spec, plugin, recall_keys: [IP] });
  return kernelDistil(RUN, await state.read(RUN));
}

describe("memory from a kernel run", () => {
  it("files an answer that stood as holding, with what it rests on and how it came to be", async () => {
    const payload = await distilled([
      { calls: [call("get_finding", { finding_id: "f-1" }), call("link_evidence", { links: [{ evidence_id: "r1", statement: "198.51.100.7 is a beacon", stance: "supports" }] })] },
      { calls: [conclude("malicious", ["r1"])] },
    ]);
    expect(payload).toMatchObject({ investigation_kind: "run", investigation_id: RUN, outcome: "completed" });
    expect(payload.provenance).toMatchObject({ source: "kernel", plugin: "investigate", run_kind: "investigate", run_outcome: "completed", held: false, rests_on_other_runs: false, models: ["scripted/model"], trust: "agent" });
    const [answer, claim] = payload.conclusions;
    expect(answer).toMatchObject({ hypothesis_id: "conclusion", status: "proven", evidence_count: 1, sources: [{ source_system: "get_finding", stance: "supports" }], subject_entities: [{ type: "ip", value: "198.51.100.7" }] });
    expect(answer!.statement).toContain("the traffic is malicious");
    expect(claim).toMatchObject({ statement: "198.51.100.7 is a beacon", status: "active", evidence_count: 1 });
    expect(payload.sightings).toEqual([expect.objectContaining({ entity: { type: "ip", value: "198.51.100.7" }, source_system: "get_finding", hit_count: 1, attacker_influenceable: true })]);
  });

  it("files a dismissal its review held back as inconclusive, never as the dismissal", async () => {
    // Benign, citing a result no claim on the record is linked to: held for review.
    // Told once that nothing it cites is linked, and answering the same again.
    const payload = await distilled([{ calls: [call("get_finding", { finding_id: "f-1" })] }, { calls: [conclude("benign", ["r1"])] }, { calls: [conclude("benign", ["r1"])] }]);
    const [answer] = payload.conclusions;
    expect(answer!.status).toBe("inconclusive");
    expect(answer!.statement).toContain("disposition: needs_review");
    expect(answer!.provenance).toMatchObject({ row: "conclusion", answer: "needs_review", asked: "benign" });
    expect(payload.provenance).toMatchObject({ held: true, guarded: { field: "disposition", asked: "benign", final: "needs_review" } });
  });

  it("says nothing of a run the kernel did not write, or one still going", () => {
    expect(kernelDistil(RUN, []).conclusions).toEqual([]);
    expect(kernelDistil(RUN, [{ kind: "run", run_kind: "investigate", ts: "2026-10-11T00:00:00Z", payload: { run_kind: "investigate", spec: {} } }] as never).concluded_at).toBe("");
  });
});
