import type { CallPayload, ConclusionPayload, FramePayload, LinkPayload, ReviewPayload, RunPayload, TerminalPayload } from "../contracts/events.js";
import { CONCLUDE_TOOL, isAgentRun, SKILL_TOOL } from "../core/agent.js";
import { LINK_TOOL, PROPOSE_TOOL, QUESTION_TOOL, recordOf } from "../core/record.js";
import { SHARED_TOOL, sharedKeysOf, UNREAD_MARK } from "../core/shared-findings.js";
import { entityKeysOf } from "../ledger/publish.js";
import { DISTIL_SCHEMA_VERSION } from "./hunt/distil.js";

// What episodic memory is told about a finished kernel run of any plugin but the
// hunt, which keeps a record of its own (hunt/distil.ts). Filed as investigation
// kind `run`, keyed by the run, in the hunt's payload shape so one Python writer
// maps both (core/memory/distil.py).
//
// Two kinds of row. The run's conclusion: what it said, and whether that stood --
// a guarded answer its review held back is filed inconclusive, never as the answer
// it gave. And each claim on its record, which a plain kernel run never resolves,
// so it files as inconclusive with whatever bore on it, or as a gap if nothing did.
//
// Every row carries the run's provenance -- plugin, how the run ended, what its
// review said, the answer given and the one that stood, whether it rested on other
// runs' findings, the model -- so what memory is trusted for can be tuned later
// without distilling again.

type Envelope = { kind: string; payload: unknown; ts: string; run_kind: string };

interface Entity {
  type: string;
  value: string;
}

export interface KernelDistilPayload {
  investigation_kind: "run";
  investigation_id: string;
  outcome: string | null;
  concluded_at: string;
  distil_schema_version: number;
  provenance: Record<string, unknown>;
  sightings: {
    entity: Entity;
    source_system: string;
    hit_count: number;
    attacker_influenceable: boolean;
    first_seen: string;
    last_seen: string;
  }[];
  conclusions: {
    hypothesis_id: string;
    statement: string;
    status: string;
    rationale: string;
    subject_entities: Entity[];
    evidence_count: number;
    attacker_influenceable_only: boolean;
    sources: { source_system: string; stance: LinkPayload["relation"] }[];
    techniques: string[];
    first_seen: string;
    last_seen: string;
    window_observed: boolean;
    provenance: Record<string, unknown>;
  }[];
}

// The kernel's own tools: what they answer is the run talking to itself, not the
// estate, so it is neither a sighting nor ground for an answer.
const OWN = new Set([CONCLUDE_TOOL, SKILL_TOOL, SHARED_TOOL, PROPOSE_TOOL, LINK_TOOL, QUESTION_TOOL]);

// What a run's answer says when it did not settle anything.
const UNSETTLED = new Set(["needs_review", "inconclusive", "undetermined", "unknown"]);

export function kernelDistil(runId: string, events: readonly Envelope[]): KernelDistilPayload {
  const terminalAt = events.findLastIndex((event) => event.kind === "terminal");
  const terminal = terminalAt === -1 ? null : (events[terminalAt]!.payload as TerminalPayload);
  const empty: KernelDistilPayload = {
    investigation_kind: "run",
    investigation_id: runId,
    outcome: terminal?.outcome ?? null,
    concluded_at: terminalAt === -1 ? "" : events[terminalAt]!.ts,
    distil_schema_version: DISTIL_SCHEMA_VERSION,
    provenance: {},
    sightings: [],
    conclusions: [],
  };
  // A run the kernel did not write, or one still going, says nothing to memory.
  // Answered rather than refused, so the writer marks it done and stops asking.
  if (terminal === null || !isAgentRun(events)) return empty;

  const opened = events.find((event) => event.kind === "run");
  const run = opened?.payload as RunPayload | undefined;
  const startedAt = opened?.ts ?? empty.concluded_at;
  const keys = sharedKeysOf(events, run === undefined ? [] : entityKeysOf(run));
  const subjects = keys.map(entityOf).filter((entity): entity is Entity => entity !== null);
  const calls = events.filter((event) => event.kind === "call").map((event) => ({ call: event.payload as CallPayload, ts: event.ts }));
  const byRef = new Map(calls.map((one) => [one.call.ref, one]));
  const shared = new Set(calls.filter(({ call }) => call.tool === SHARED_TOOL || (call.tool === "conclude" && call.result.includes(UNREAD_MARK))).map(({ call }) => call.ref));
  const served = (ref: string) => {
    const held = byRef.get(ref);
    return held !== undefined && held.call.ok && held.call.class === "served" && !shared.has(ref) && !OWN.has(held.call.tool) ? held : undefined;
  };

  const conclusionAt = events.findLastIndex((event) => event.kind === "conclusion");
  const conclusion = conclusionAt === -1 ? null : (events[conclusionAt]!.payload as ConclusionPayload);
  const review = conclusionAt === -1 ? undefined : (events.slice(conclusionAt).find((event) => event.kind === "review")?.payload as ReviewPayload | undefined);
  const guarded = review?.guarded;
  const held = guarded !== undefined && guarded.asked !== guarded.final;
  const record = recordOf(events);
  const linked = record.links.map((link) => link.evidence_id);
  const cited = conclusion === null ? [] : refsIn(conclusion.value);
  const resting = [...new Set([...cited, ...linked])].some((ref) => shared.has(ref));
  const models = [...new Set(events.filter((event) => event.kind === "frame").map((event) => (event.payload as FramePayload).model_id))].sort();

  const provenance: Record<string, unknown> = {
    source: "kernel",
    // The plugin the run was stamped with when it opened (core/agent.ts, stamped).
    plugin: pluginOf(run) ?? conclusion?.plugin ?? null,
    run_kind: opened?.run_kind ?? null,
    run_outcome: terminal.outcome,
    review: review?.stance ?? null,
    ...(guarded === undefined ? {} : { guarded: { field: guarded.field, asked: guarded.asked, final: guarded.final } }),
    held,
    rests_on_other_runs: resting,
    read_other_runs: shared.size > 0,
    models,
    trust: "agent",
  };

  const window = { first_seen: startedAt, last_seen: empty.concluded_at, window_observed: false };
  const conclusions: KernelDistilPayload["conclusions"] = [];
  if (conclusion !== null) {
    const value = guarded === undefined ? conclusion.value : { ...conclusion.value, [guarded.field]: guarded.final };
    const said = summaryOf(value);
    const final = guarded?.final ?? (typeof value["disposition"] === "string" ? (value["disposition"] as string) : null);
    const settled = terminal.outcome === "completed" && !held && (final === null || !UNSETTLED.has(final));
    const grounds = cited.map(served).filter((one) => one !== undefined);
    conclusions.push({
      hypothesis_id: "conclusion",
      statement: final === null ? said : `${said} (${guarded?.field ?? "disposition"}: ${final})`,
      // The run's own answer, filed as holding only when it ended on it unchallenged.
      status: settled ? "proven" : "inconclusive",
      rationale: held ? `it answered ${guarded.asked}; its review did not let that stand (${review?.stance ?? "no review"}): ${review?.reasons ?? ""}`.trim() : (review?.reasons ?? ""),
      subject_entities: subjects,
      evidence_count: grounds.length,
      attacker_influenceable_only: false,
      sources: sourcesOf(grounds.map((one) => ({ tool: one.call.tool, stance: "supports" as const }))),
      techniques: [],
      ...window,
      provenance: { row: "conclusion", ...(final === null ? {} : { answer: final }), ...(guarded === undefined ? {} : { asked: guarded.asked }) },
    });
  }

  for (const claim of record.hypotheses.values()) {
    const bearing = record.links.filter((link) => link.hypothesis_id === claim.hypothesis_id).map((link) => ({ link, call: served(link.evidence_id) })).filter((one) => one.call !== undefined);
    conclusions.push({
      hypothesis_id: claim.hypothesis_id,
      statement: claim.statement,
      status: claim.status,
      rationale: claim.resolution_reason ?? "",
      subject_entities: subjects,
      evidence_count: bearing.length,
      attacker_influenceable_only: false,
      sources: sourcesOf(bearing.map((one) => ({ tool: one.call!.call.tool, stance: one.link.relation }))),
      techniques: [],
      ...window,
      provenance: { row: "claim", provenance: claim.provenance },
    });
  }

  return { ...empty, provenance, sightings: sightingsOf(subjects, calls.filter(({ call }) => served(call.ref) !== undefined)), conclusions };
}

// An entity a run is about, from its key: `host:ws-17` is a host named ws-17.
function entityOf(key: string): Entity | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { type: key.slice(0, at), value: key.slice(at + 1) };
}

// One sighting per entity and tool: the served results that name the entity.
function sightingsOf(subjects: readonly Entity[], calls: readonly { call: CallPayload; ts: string }[]): KernelDistilPayload["sightings"] {
  const groups = new Map<string, KernelDistilPayload["sightings"][number]>();
  for (const entity of subjects) {
    const needle = entity.value.toLowerCase();
    for (const { call, ts } of calls) {
      if (!`${call.arguments}\n${call.result}`.toLowerCase().includes(needle)) continue;
      const key = `${entity.type}:${entity.value}\n${call.tool}`;
      const held = groups.get(key);
      if (held === undefined) {
        // A tool's result is text from outside, which an attacker may have written.
        groups.set(key, { entity, source_system: call.tool, hit_count: 1, attacker_influenceable: true, first_seen: ts, last_seen: ts });
      } else {
        held.hit_count += 1;
        held.last_seen = ts;
      }
    }
  }
  return [...groups.values()];
}

// One stance per tool: one that ever weakened the claim is not a clean corroborator.
function sourcesOf(bearing: readonly { tool: string; stance: LinkPayload["relation"] }[]): KernelDistilPayload["conclusions"][number]["sources"] {
  const rank = { weakens: 2, supports: 1, neither: 0 } as const;
  const byTool = new Map<string, LinkPayload["relation"]>();
  for (const one of bearing) {
    const held = byTool.get(one.tool);
    if (held === undefined || rank[one.stance] > rank[held]) byTool.set(one.tool, one.stance);
  }
  return [...byTool].map(([source_system, stance]) => ({ source_system, stance }));
}

function summaryOf(value: Record<string, unknown>): string {
  for (const field of ["summary", "text", "conclusion"]) if (typeof value[field] === "string" && (value[field] as string).trim() !== "") return value[field] as string;
  return JSON.stringify(value).slice(0, 600);
}

function refsIn(value: unknown): string[] {
  if (typeof value === "string") return /^r\d+$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(refsIn);
  return [];
}

function pluginOf(run: RunPayload | undefined): string | null {
  const plugin = (run?.spec as { sections?: Record<string, unknown> } | undefined)?.sections?.["plugin"];
  return typeof plugin === "string" ? plugin : null;
}
