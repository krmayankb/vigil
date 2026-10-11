import type { AgentEvent, CallPayload, ConclusionPayload, HypothesisPayload, LinkPayload, NewEvent, ReviewPayload, RunPayload, TerminalPayload } from "../contracts/events.js";
import { errorFields, logger } from "../core/log.js";
import type { ReadOptions, State } from "../core/seams.js";
import { SHARED_TOOL, sharedKeysOf, UNREAD_MARK, type Publication, type SharedFindings } from "../core/shared-findings.js";

const log = logger("agent.publish");

// The worker's ledger, publishing as it writes: a run's claims and what bears on them
// go to the shared findings under every entity the run is about, marked provisional,
// the moment they land on the run's own ledger. Another run on the same entity can
// then read them while both are still working.
//
// Its conclusion goes once the run has ended, not when the agent gave it: a guarded
// answer is only an answer once its review has ruled, and a dismissal the review held
// back must not reach other runs as a dismissal. And a conclusion that rests on what
// other runs found says so, naming them, so a reader can tell a second opinion from
// an echo of the first.
//
// Publishing never fails a run: the ledger is the record, and a finding that did
// not reach the shared table is one other runs did not hear about, not one lost.
// A child run (a judge, a subagent) publishes nothing; its parent's record is the
// run's.
const EXCERPT = 400;

export class PublishingLedger<Kinds extends Record<string, unknown> = Record<never, never>> implements State<Kinds> {
  constructor(
    private readonly inner: State<Kinds>,
    private readonly shared: SharedFindings,
  ) {}

  latestSeq(runId: string): Promise<number | null> {
    return this.inner.latestSeq(runId);
  }

  terminal(runId: string): Promise<TerminalPayload | null> {
    return this.inner.terminal(runId);
  }

  read(runId: string, opts?: ReadOptions): Promise<AgentEvent<Kinds>[]> {
    return this.inner.read(runId, opts);
  }

  async append(runId: string, events: readonly NewEvent<Kinds>[]): Promise<number> {
    const next = await this.inner.append(runId, events);
    if (events.some((event) => PUBLISHED.has(event.kind))) {
      await this.publish(runId, events.length, next).catch((error: unknown) =>
        log.warn("could not publish to the shared findings", { run_id: runId, ...errorFields(error) }),
      );
    }
    return next;
  }

  private async publish(runId: string, count: number, next: number): Promise<void> {
    const held = (await this.inner.read(runId)) as readonly { kind: string; seq: number; run_kind: string; payload: unknown }[];
    const opened = held.find((event) => event.kind === "run");
    if (opened === undefined || opened.run_kind === "subagent") return;
    const keys = sharedKeysOf(held, entityKeysOf(opened.payload as RunPayload));
    if (keys.length === 0) return;

    const written = held.filter((event) => event.seq >= next - count && event.seq < next && PUBLISHED.has(event.kind));
    const claims = new Map<string, string>();
    for (const event of held) {
      if (event.kind === "hypothesis") {
        const claim = event.payload as HypothesisPayload;
        claims.set(claim.hypothesis_id, claim.statement);
      }
    }
    const calls = new Map(held.filter((event) => event.kind === "call").map((event) => [(event.payload as CallPayload).ref, event.payload as CallPayload]));
    // What the run was shown of other runs' findings: each read, and each conclude the
    // kernel refused with the unread findings in it.
    const sharedRefs = new Set(
      [...calls.values()].filter((call) => (call.tool === SHARED_TOOL && call.ok) || (call.tool === "conclude" && !call.ok && call.result.includes(UNREAD_MARK))).map((call) => call.ref),
    );

    const rows: Publication[] = written.flatMap((event): Publication[] => {
      const base = { entity_keys: keys, run_id: runId, run_kind: opened.run_kind, source_seq: event.seq };
      if (event.kind === "hypothesis") {
        const claim = event.payload as HypothesisPayload;
        return [{ ...base, kind: "claim", statement: claim.statement, detail: { claim_id: claim.hypothesis_id, status: claim.status }, attacker_influenceable: false, derived_from: [] }];
      }
      if (event.kind === "link") {
        const link = event.payload as LinkPayload;
        const call = calls.get(link.evidence_id);
        const from = call?.tool === SHARED_TOOL ? findingIdsIn(call.result) : [];
        const claim = claims.get(link.hypothesis_id) ?? link.hypothesis_id;
        return [
          {
            ...base,
            kind: "observation",
            statement: `${link.relation} "${claim}"${call === undefined ? "" : `, from ${call.tool}`}`,
            detail: {
              claim_id: link.hypothesis_id,
              relation: link.relation,
              ref: link.evidence_id,
              ...(call === undefined ? {} : { tool: call.tool, arguments: call.arguments.slice(0, EXCERPT), excerpt: call.result.slice(0, EXCERPT) }),
            },
            // A tool's result is text from outside, which an attacker may have written.
            attacker_influenceable: call !== undefined,
            derived_from: from,
          },
        ];
      }
      return concluded(held, event.payload as TerminalPayload, base, calls, sharedRefs);
    });
    if (rows.length > 0) await this.shared.publish(rows);
  }
}

const PUBLISHED = new Set(["hypothesis", "link", "terminal"]);

type Held = readonly { kind: string; seq: number; payload: unknown }[];
type Base = Pick<Publication, "entity_keys" | "run_id" | "run_kind" | "source_seq">;

// The run's conclusion as it stood when the run ended: the guarded field set to what
// the review let stand, and whether it rests on other runs' findings.
function concluded(held: Held, terminal: TerminalPayload, base: Base, calls: ReadonlyMap<string, CallPayload>, sharedRefs: ReadonlySet<string>): Publication[] {
  const at = held.findLastIndex((event) => event.kind === "conclusion");
  if (at === -1) return [];
  const conclusion = held[at]!.payload as ConclusionPayload;
  const review = held.slice(at).find((event) => event.kind === "review")?.payload as ReviewPayload | undefined;
  const guarded = review?.guarded;
  const changed = guarded !== undefined && guarded.asked !== guarded.final;
  const value = guarded === undefined ? conclusion.value : { ...conclusion.value, [guarded.field]: guarded.final };
  const said = typeof value["summary"] === "string" ? value["summary"] : typeof value["text"] === "string" ? value["text"] : JSON.stringify(value).slice(0, EXCERPT);

  // Rests on another run's finding when it cites a read of them, or its record links
  // one to a claim.
  const linked = held.filter((event) => event.kind === "link").map((event) => (event.payload as LinkPayload).evidence_id);
  const resting = [...new Set([...refsIn(conclusion.value), ...linked])].filter((ref) => sharedRefs.has(ref));
  const derived = [...new Set(resting.flatMap((ref) => findingIdsIn(calls.get(ref)?.result ?? "")))];
  const notes = [
    changed ? `it answered ${guarded.field} ${guarded.asked}; its review did not let that stand, and it ended ${guarded.final}` : "",
    resting.length > 0 ? "it rests on other runs' findings, so it is not an independent source for them" : "",
  ].filter((note) => note !== "");
  return [
    {
      ...base,
      // Filed at the conclusion, so a retry of the terminal's publish writes nothing twice.
      source_seq: held[at]!.seq,
      kind: "conclusion",
      statement: notes.length === 0 ? said : `${said} (${notes.join("; ")})`,
      detail: {
        answer: value,
        plugin: conclusion.plugin,
        outcome: terminal.outcome,
        ...(review === undefined ? {} : { review: review.stance }),
        ...(changed ? { asked: guarded.asked } : {}),
        rests_on_other_runs: resting.length > 0,
      },
      // What it rests on came from outside this run, where an attacker may have written it.
      attacker_influenceable: resting.length > 0,
      derived_from: derived,
    },
  ];
}

// Every result ref a conclusion names, wherever in it.
function refsIn(value: unknown): string[] {
  if (typeof value === "string") return /^r\d+$/.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(refsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(refsIn);
  return [];
}

// What the run is about when it journaled no recall: the keys its spec opened on,
// and the subjects a person named for its claims. A run that recalled says which
// keys it read on, normalised, and those are the ones the kernel reads updates by.
export function entityKeysOf(run: RunPayload): string[] {
  const sections = ((run.spec as { sections?: Record<string, unknown> } | undefined)?.sections ?? {}) as Record<string, unknown>;
  const keys = new Set<string>();
  for (const key of Array.isArray(sections["recall_keys"]) ? sections["recall_keys"] : []) if (typeof key === "string" && key !== "") keys.add(key);
  const subjects = sections["operator_hypothesis_subjects"];
  if (subjects !== null && typeof subjects === "object") {
    for (const list of Object.values(subjects as Record<string, unknown>)) {
      for (const key of Array.isArray(list) ? list : []) if (typeof key === "string" && key !== "") keys.add(key);
    }
  }
  return [...keys].sort();
}

// The finding ids a read of the shared findings returned, from its journaled text.
function findingIdsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/"finding_id":\s*"([0-9a-f-]{36})"/g)].map((match) => match[1] as string))];
}
