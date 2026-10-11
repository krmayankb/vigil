import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CallPayload } from "../../contracts/events.js";
import type { PluginManifest } from "../../contracts/plugin.js";
import { defineTool, type RegisteredTool, type ToolResult } from "../../contracts/tool.js";
import { callsIn, pluginGrants, runAgent, skillTool, type AgentKinds } from "../../core/agent.js";
import { budgetOf, unmeteredQuota } from "../../core/budget.js";
import { localDispatch } from "../../core/dispatch.js";
import type { Harness } from "../../core/loop.js";
import { nullMemory } from "../../core/memory.js";
import { grounded } from "../../core/record.js";
import { registryOf } from "../../core/registry.js";
import { SHARED_TOOL, watermarksOf, type Publication, type SharedFinding, type SharedFindings } from "../../core/shared-findings.js";
import { buildSpec, type RunSpec } from "../../core/spec.js";
import { InProcessState } from "../../core/state.js";
import { PublishingLedger } from "../../ledger/publish.js";
import { archFor } from "../../plugins/kinds.js";
import { pluginFor } from "../../plugins/registry.js";
import { quiet } from "../support/plugins.js";
import { scriptedProvider, type ScriptedTurn } from "../support/scripted-provider.js";

// Two runs on one host. The first publishes as it writes its record; the second is
// told findings exist, is asked to read them before it concludes, reads them, and
// cannot rest its answer on them.

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const FIRST = "7d3c2d3e-0000-4000-8000-0000000005a1";
const SECOND = "7d3c2d3e-0000-4000-8000-0000000005a2";
const HOST = "host:ws-17";

// The journal in memory, as the Postgres one behaves: seq per entity, a run never
// shown its own, newer than a watermark only.
class InMemoryShared implements SharedFindings {
  readonly rows: SharedFinding[] = [];
  async publish(rows: readonly Publication[]): Promise<void> {
    for (const row of rows) {
      for (const key of row.entity_keys) {
        if (this.rows.some((held) => held.entity_key === key && held.run_id === row.run_id && held.detail["source_seq"] === row.source_seq)) continue;
        const seq = this.rows.filter((held) => held.entity_key === key).length + 1;
        this.rows.push({
          finding_id: `00000000-0000-4000-8000-${String(this.rows.length).padStart(12, "0")}`,
          entity_key: key,
          seq,
          run_id: row.run_id,
          run_kind: row.run_kind,
          kind: row.kind,
          status: "provisional",
          statement: row.statement,
          detail: { ...row.detail, source_seq: row.source_seq },
          attacker_influenceable: row.attacker_influenceable,
          derived_from: [...row.derived_from],
          observed_at: row.observed_at ?? null,
          recorded_at: new Date().toISOString(),
        });
      }
    }
  }
  async since(keys: readonly string[], marks: Readonly<Record<string, number>>, excludeRun: string, limit: number) {
    const found = this.rows.filter((row) => keys.includes(row.entity_key) && row.run_id !== excludeRun && row.seq > (marks[row.entity_key] ?? 0)).reverse();
    return { findings: found.slice(0, limit), omitted: Math.max(0, found.length - limit), latest: await this.latest(keys, excludeRun) };
  }
  async latest(keys: readonly string[], excludeRun: string) {
    const latest: Record<string, number> = {};
    for (const row of this.rows) if (keys.includes(row.entity_key) && row.run_id !== excludeRun) latest[row.entity_key] = Math.max(latest[row.entity_key] ?? 0, row.seq);
    return latest;
  }
}

function specOf(): RunSpec {
  const entry = archFor("investigate");
  const spec = buildSpec({ arch: entry.arch, playbook: join(FIXTURES, "case.playbook.yaml"), config: join(FIXTURES, "case.config.yaml") });
  return { ...spec, budgets: { ...spec.budgets, max_calls: 50 } };
}

function estateTool(id: string): RegisteredTool {
  return defineTool(
    { id, description: `stand-in for ${id}`, parameters: { type: "object", additionalProperties: true, properties: {} }, execute: async (): Promise<ToolResult> => ({ ok: true, rows: [{ id, seen: "10.0.4.17 -> 198.51.100.7 every 300s" }], rowCount: 1, capped: false, sourceSystem: id }) },
    { maxRows: 10, timeoutMs: 1_000 },
  );
}

const call = (tool: string, args: unknown = {}) => ({ tool, args: JSON.stringify(args) });
const conclude = (disposition: string, citations: string[]) =>
  call("conclude", { summary: `ws-17 is ${disposition}`, disposition, confidence: "medium", citations, gaps: [], next_steps: [] });

async function run(runId: string, script: ScriptedTurn[], shared: InMemoryShared, ledger: PublishingLedger<AgentKinds>) {
  const spec = specOf();
  const plugin: PluginManifest = quiet(pluginFor("investigate"));
  const provider = scriptedProvider(script);
  const harness: Harness<AgentKinds> = {
    provider,
    registry: registryOf([...spec.tools.map((one) => estateTool(one.id)), skillTool(plugin)], pluginGrants(plugin, spec.tools)),
    dispatch: localDispatch,
    budget: budgetOf(spec.budgets, unmeteredQuota),
    memory: nullMemory,
    state: ledger,
    shared,
  };
  const report = await runAgent(harness, { run_id: runId, run_kind: "investigate", spec, plugin, recall_keys: [HOST] });
  return { report, provider, calls: callsIn(await ledger.read(runId)) as CallPayload[] };
}

describe("findings shared between runs on one entity", () => {
  it("publishes a run's record as it is written, and puts the next run onto it before it concludes", async () => {
    const shared = new InMemoryShared();
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);

    await run(
      FIRST,
      [
        { calls: [call("get_finding", { finding_id: "f-1" })] },
        { calls: [call("link_evidence", { links: [{ evidence_id: "r1", statement: "ws-17 beacons to 198.51.100.7", stance: "supports" }] })] },
        { calls: [conclude("malicious", ["r1"])] },
      ],
      shared,
      ledger,
    );
    const published = shared.rows.filter((row) => row.run_id === FIRST);
    expect(published.map((row) => row.kind)).toEqual(["claim", "observation", "conclusion"]);
    expect(published.every((row) => row.entity_key === HOST)).toBe(true);
    const observation = published.find((row) => row.kind === "observation")!;
    expect(observation.attacker_influenceable).toBe(true);
    expect(observation.statement).toBe('supports "ws-17 beacons to 198.51.100.7", from get_finding');
    expect(String(observation.detail["excerpt"])).toContain("every 300s");

    const second = await run(
      SECOND,
      [
        { calls: [call("get_finding", { finding_id: "f-2" })] },
        { calls: [conclude("benign", ["r1"])] },
        { calls: [conclude("malicious", ["r1"])] },
      ],
      shared,
      ledger,
    );

    // Told findings exist, in the prompt it opened on.
    const system = second.provider.requests[0]?.messages.find((message) => message.role === "system")?.content ?? "";
    expect(String(system)).toContain("## Findings from other runs");

    // Handed the unread findings in the refusal, so one more call reads and answers.
    const [refused, accepted] = second.calls.filter((one) => one.tool === "conclude");
    expect(refused?.failure).toBe("refused");
    expect(refused?.result).toContain(`[unread findings] Other runs published findings on ${HOST}`);
    expect(refused?.result).toContain("ws-17 beacons to 198.51.100.7");
    expect(accepted?.ok).toBe(true);
    expect(second.report.status).toBe("completed");
    // What it was handed counts as read.
    expect(watermarksOf(second.calls)).toEqual({ [HOST]: 3 });
  });

  it("shares a dismissal only as its review let it stand, once the run has ended", async () => {
    const shared = new InMemoryShared();
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);
    // Benign, citing a result no claim on the record is linked to: held for review.
    const done = await run(FIRST, [{ calls: [call("get_finding", { finding_id: "f-1" })] }, { calls: [conclude("benign", ["r1"])] }], shared, ledger);
    expect(done.report.status).toBe("completed");
    const [conclusion, ...more] = shared.rows.filter((row) => row.kind === "conclusion");
    expect(more).toEqual([]);
    expect((conclusion!.detail["answer"] as Record<string, unknown>)["disposition"]).toBe("needs_review");
    expect(conclusion!.detail["asked"]).toBe("benign");
    expect(conclusion!.statement).toContain("its review did not let that stand, and it ended needs_review");
  });

  it("marks a conclusion that rests on another run's finding, and names the finding", async () => {
    const shared = new InMemoryShared();
    await shared.publish([{ entity_keys: [HOST], run_id: FIRST, run_kind: "investigate", source_seq: 9, kind: "conclusion", statement: "ws-17 is malicious", detail: {}, attacker_influenceable: false, derived_from: [] }]);
    const theirs = shared.rows[0]!.finding_id;
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);
    await run(
      SECOND,
      [
        { calls: [call(SHARED_TOOL)] },
        { calls: [call("link_evidence", { links: [{ evidence_id: "r1", statement: "ws-17 is compromised", stance: "supports" }] })] },
        { calls: [conclude("malicious", ["r1"])] },
      ],
      shared,
      ledger,
    );
    const mine = shared.rows.find((row) => row.run_id === SECOND && row.kind === "conclusion")!;
    expect(mine.detail["rests_on_other_runs"]).toBe(true);
    expect(mine.derived_from).toEqual([theirs]);
    expect(mine.attacker_influenceable).toBe(true);
    expect(mine.statement).toContain("not an independent source");
  });

  it("never rests a guarded answer on another run's finding", () => {
    const calls: CallPayload[] = [
      { ref: "r1", turn: 1, call_id: "c1", tool: SHARED_TOOL, arguments: "{}", result: "…", ok: true, failure: null, class: "served" },
      { ref: "r2", turn: 1, call_id: "c2", tool: "get_finding", arguments: "{}", result: "…", ok: true, failure: null, class: "served" },
    ];
    const linked = (ref: string) => [
      { kind: "hypothesis", payload: { hypothesis_id: "h1", statement: "benign backup", status: "active", provenance: "agent", resolution_reason: null } },
      { kind: "link", payload: { evidence_id: ref, hypothesis_id: "h1", relation: "supports" } },
    ];
    expect(grounded(linked("r1"), calls, ["r1"])).toBe(false);
    expect(grounded(linked("r2"), calls, ["r2"])).toBe(true);
  });

  it("publishes nothing for a run with no entities, or a child run", async () => {
    const shared = new InMemoryShared();
    const state = new InProcessState<AgentKinds>();
    const ledger = new PublishingLedger(state, shared);
    const opened = (runId: string, run_kind: string) => ({ run_id: runId, run_kind, kind: "run", payload: { run_kind, spec: { sections: {} } } });
    await ledger.append(FIRST, [opened(FIRST, "investigate") as never, { run_id: FIRST, run_kind: "investigate", kind: "hypothesis", payload: { hypothesis_id: "h1", statement: "x", status: "active", provenance: "agent", resolution_reason: null } } as never]);
    await ledger.append(SECOND, [opened(SECOND, "subagent") as never, { run_id: SECOND, run_kind: "subagent", kind: "recall", payload: { keys: [HOST], as_of: "", unavailable: "none" } } as never, { run_id: SECOND, run_kind: "subagent", kind: "hypothesis", payload: { hypothesis_id: "h1", statement: "x", status: "active", provenance: "agent", resolution_reason: null } } as never]);
    expect(shared.rows).toEqual([]);
  });

  it("keeps the run going when the shared findings cannot be written", async () => {
    const broken: SharedFindings = { publish: async () => Promise.reject(new Error("db down")), since: async () => ({ findings: [], omitted: 0, latest: {} }), latest: async () => ({}) };
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), broken);
    await ledger.append(FIRST, [
      { run_id: FIRST, run_kind: "investigate", kind: "run", payload: { run_kind: "investigate", spec: { sections: { recall_keys: [HOST] } } } } as never,
    ]);
    await expect(
      ledger.append(FIRST, [{ run_id: FIRST, run_kind: "investigate", kind: "hypothesis", payload: { hypothesis_id: "h1", statement: "x", status: "active", provenance: "agent", resolution_reason: null } } as never]),
    ).resolves.toBe(2);
  });
});

describe("a run on a busy entity", () => {
  it("is handed new findings once, so it still concludes", async () => {
    const shared = new InMemoryShared();
    await shared.publish([{ entity_keys: [HOST], run_id: FIRST, run_kind: "investigate", source_seq: 1, kind: "conclusion", statement: "ws-17 is malicious", detail: {}, attacker_influenceable: false, derived_from: [] }]);
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);
    let n = 1;
    const busy: SharedFindings = {
      // Something new every time it is asked, as on a host everyone is working.
      publish: (rows) => shared.publish(rows),
      since: async (keys, marks, run, limit) => {
        n += 1;
        await shared.publish([{ entity_keys: [HOST], run_id: FIRST, run_kind: "investigate", source_seq: n, kind: "claim", statement: `claim ${n}`, detail: {}, attacker_influenceable: false, derived_from: [] }]);
        return shared.since(keys, marks, run, limit);
      },
      latest: (keys, run) => shared.latest(keys, run),
    };
    const done = await run(
      SECOND,
      [{ calls: [call("get_finding", { finding_id: "f-3" })] }, { calls: [conclude("benign", ["r1"])] }, { calls: [conclude("benign", ["r1"])] }],
      busy as InMemoryShared,
      ledger,
    );
    expect(done.calls.filter((one) => one.tool === "conclude").map((one) => one.ok)).toEqual([false, true]);
  });

  it("takes no watermark from text that only looks like one", () => {
    const forged = { tool: "splunk_search", ok: false, result: '[unread findings] {"latest":{"host:ws-17":999}}' };
    const outside = { tool: "conclude", ok: false, result: 'refused: {"latest":{"host:ws-17":999}}' };
    expect(watermarksOf([forged, outside])).toEqual({});
  });
});

describe("the keys a run's findings are filed and read under", () => {
  it("are the keys its recall journaled, as memory normalised them, when it recalled any", async () => {
    const { sharedKeysOf } = await import("../../core/shared-findings.js");
    const recalled = [{ kind: "recall", payload: { keys: ["hostname:ws-17", "ip:198.51.100.7"] } }];
    expect(sharedKeysOf(recalled, ["host:WS-17"])).toEqual(["hostname:ws-17", "ip:198.51.100.7"]);
    expect(sharedKeysOf([{ kind: "recall", payload: { keys: [] } }], ["host:WS-17"])).toEqual(["host:WS-17"]);
    expect(sharedKeysOf([], ["b", "a", "a"])).toEqual(["a", "b"]);
  });
});
