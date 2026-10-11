import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { parse as parseYaml } from "yaml";
import type { AgentKinds } from "../core/agent.js";
import { InProcessLeases } from "../core/leases.js";
import type { Memory } from "../core/seams.js";
import { type Publication, type SharedFinding, type SharedFindings } from "../core/shared-findings.js";
import { InProcessState } from "../core/state.js";
import { emptyRecall, type RecalledGap, type RecalledSighting, type RecalledVerdict } from "../contracts/memory.js";
import { PublishingLedger } from "../ledger/publish.js";
import { kernelDistil, type KernelDistilPayload } from "../plugins/kernel-distil.js";
import { estateDispatch, type EvalCase } from "./estate.js";
import { grade, type Graded, type GraderClient } from "./grade.js";

// Which provenance tags on episodic memory are worth filtering recall on.
//
// History: for each pair (pairs/pairs.yaml) the first alert runs and publishes,
// then the second runs and may read it -- as the shared-findings eval does -- and
// both are distilled the way memory files them (plugins/kernel-distil.ts, mapped to
// rows as core/memory/distil.py does). Several histories per pair, pooled, are that
// entity's memory.
//
// Target: the second alert again, fresh, with no shared findings, recalling the
// pool through one arm: none, all, or all less the runs one tag marks as weak.
// An arm whose filter removes nothing is the same input as `all` and is not rerun.
//
//   npx tsx eval/memory-ablation.ts --label ab1 --histories 3 --tries 4
//   npx tsx eval/memory-ablation.ts --label wiring --dry --histories 1 --tries 1

const HERE = dirname(new URL(import.meta.url).pathname);

const { values: flags } = parseArgs({
  options: {
    label: { type: "string" },
    model: { type: "string", default: "vertex/gemini-2.5-pro" },
    "grader-model": { type: "string" },
    pairs: { type: "string", default: join(HERE, "pairs", "pairs.yaml") },
    only: { type: "string" },
    histories: { type: "string", default: "3" },
    tries: { type: "string", default: "4" },
    concurrency: { type: "string", default: "4" },
    dry: { type: "boolean", default: false },
  },
});
if (flags.label === undefined) {
  console.error("usage: tsx eval/memory-ablation.ts --label <name> [--histories n] [--tries n] [--only id,id] [--concurrency n] [--dry]");
  process.exit(2);
}

const LABEL = flags.label;
const MODEL = flags.dry ? "dry/schema-filler" : flags.model!;
const GRADER_MODEL = flags["grader-model"] ?? flags.model!;
const BIFROST = (process.env["BIFROST_URL"] ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const DIR = join(HERE, "results", `ablation-${LABEL}`);
const HISTORY = join(DIR, "history.jsonl");
const OUT = join(DIR, "targets.jsonl");

type Side = EvalCase & { entities: string[] };
interface Pair {
  id: string;
  kind: string;
  first: Side;
  second: Side;
}

// --- the arms ------------------------------------------------------------------

type Tags = Record<string, unknown>;
const ARMS: { id: string; keep: ((tags: Tags) => boolean) | null }[] = [
  { id: "none", keep: null },
  { id: "all", keep: () => true },
  { id: "review", keep: (tags) => tags["review"] !== "overturn" && tags["review"] !== "insufficient" },
  { id: "rests_on_other_runs", keep: (tags) => tags["rests_on_other_runs"] !== true },
  { id: "held", keep: (tags) => tags["held"] !== true },
  { id: "run_outcome", keep: (tags) => tags["run_outcome"] === "completed" },
];

// --- prices, the dry model and the grader: as eval/pairs.ts ---------------------

type Card = { input: number; output: number; cache_read: number; cache_write: number };
const PRICES = parseYaml(readFileSync(join(HERE, "prices.yaml"), "utf8")) as Record<string, Card>;

function cardFor(model: string): Record<string, unknown> {
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  if (flags.dry) return { input: 0, output: 0, cache_read: 0, cache_write: 0, source: "zero", fetched_at: new Date().toISOString() };
  const card = PRICES[bare];
  if (card === undefined) return { source: "unknown" };
  return { input: card.input / 1e6, output: card.output / 1e6, cache_read: card.cache_read / 1e6, cache_write: card.cache_write / 1e6, source: "eval/prices.yaml", fetched_at: new Date().toISOString() };
}

async function priceServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname.endsWith("/vk")) return void res.end(JSON.stringify({ vk: null }));
    res.end(JSON.stringify(cardFor(url.searchParams.get("model_id") ?? "")));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the price server did not bind");
  process.env["VIGIL_PRICING_URL"] = `http://127.0.0.1:${address.port}/internal/pricing`;
  return server;
}

const ZERO = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
function fill(schema: Record<string, unknown>): unknown {
  const options = schema["enum"];
  if (Array.isArray(options)) return options.find((one) => ["inconclusive", "needs_review"].includes(String(one))) ?? options[0];
  if (schema["type"] === "object") {
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(((schema["required"] ?? []) as string[]).map((key) => [key, fill(properties[key] ?? { type: "string" })]));
  }
  if (schema["type"] === "array") return [];
  if (schema["type"] === "number" || schema["type"] === "integer") return 0;
  if (schema["type"] === "boolean") return false;
  return "dry run";
}
const dryProvider = {
  model: MODEL,
  provider_type: "dry",
  stream: async function* (request: { emit?: Record<string, unknown>; tools: readonly { id: string; parameters: Record<string, unknown> }[]; messages: readonly { role: string }[] }) {
    yield { type: "usage" as const, tokens: ZERO };
    if (request.emit !== undefined) return void (yield { type: "text_delta" as const, text: JSON.stringify(fill(request.emit)) });
    const seen = request.messages.filter((message) => message.role === "tool").length;
    const has = (id: string) => request.tools.find((tool) => tool.id === id);
    if (seen === 0 && has("get_finding")) yield { type: "tool_call" as const, call: { id: "dry-1", tool: "get_finding", args: '{"finding_id":"f"}' } };
    else if (has("conclude")) yield { type: "tool_call" as const, call: { id: `dry-${seen + 1}`, tool: "conclude", args: JSON.stringify(fill(has("conclude")!.parameters)) } };
  },
};

function graderClient(): GraderClient {
  const client = new OpenAI({ baseURL: `${BIFROST}/v1`, apiKey: process.env["BIFROST_API_KEY"] ?? "unused", maxRetries: 2 });
  return {
    model: GRADER_MODEL,
    complete: async (system, user) => {
      const response = await client.chat.completions.create({ model: GRADER_MODEL, max_tokens: 2_000, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
      return { text: response.choices[0]?.message?.content ?? "" };
    },
  };
}

// As eval/pairs.ts: one per history, so nothing leaks between them.
class InMemoryShared implements SharedFindings {
  readonly rows: SharedFinding[] = [];
  async publish(rows: readonly Publication[]): Promise<void> {
    for (const row of rows) {
      for (const key of row.entity_keys) {
        if (this.rows.some((held) => held.entity_key === key && held.run_id === row.run_id && held.detail["source_seq"] === row.source_seq)) continue;
        this.rows.push({
          finding_id: randomUUID(),
          entity_key: key,
          seq: this.rows.filter((held) => held.entity_key === key).length + 1,
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

// --- memory rows, as core/memory/distil.py maps a payload ------------------------

interface Filed {
  run_id: string;
  tags: Tags;
  answer: string | null;
  verdicts: RecalledVerdict[];
  gaps: RecalledGap[];
  sightings: RecalledSighting[];
}

const keyOf = (entity: { type: string; value: string }) => `${entity.type}:${entity.value}`.toLowerCase();
const OUTCOMES: Record<string, RecalledVerdict["outcome"]> = { proven: "proven", disproven: "disproven", handed_off: "handed_off", inconclusive: "inconclusive", active: "inconclusive" };

function filed(payload: KernelDistilPayload): Filed {
  const base = (provenance: Tags) => ({ investigation_kind: "run" as const, investigation_id: payload.investigation_id, concluded_at: payload.concluded_at, provenance, recorded_at: payload.concluded_at });
  const verdicts: RecalledVerdict[] = [];
  const gaps: RecalledGap[] = [];
  for (const one of payload.conclusions) {
    const provenance = { investigation_kind: "run", ...payload.provenance, ...one.provenance };
    const outcome = OUTCOMES[one.status];
    const subjects = one.subject_entities.map(keyOf);
    if (outcome === undefined || (outcome === "inconclusive" && one.evidence_count === 0)) {
      gaps.push({ ...base(provenance), hypothesis_id: one.hypothesis_id, statement: one.statement, disposition: payload.outcome === "budget_exhausted" ? "budget_exhausted" : "no_evidence_gathered", reason: one.rationale || "nothing was gathered on it", subject_entities: subjects });
      continue;
    }
    verdicts.push({
      ...base(provenance),
      hypothesis_id: one.hypothesis_id,
      statement: one.statement,
      outcome,
      rationale: one.rationale,
      subject_entities: subjects,
      attacker_influenceable_only: one.attacker_influenceable_only,
      trust: "agent",
      window: { first_seen: one.first_seen, last_seen: one.last_seen },
      window_source: one.window_observed ? "observed" : "asserted",
      sources: one.sources.map((source) => ({ source_system: source.source_system, stance: source.stance, source_tier: "telemetry" as const })),
      contested: false,
    });
  }
  const sightings: RecalledSighting[] = payload.sightings.map((one) => ({
    ...base({ investigation_kind: "run", ...payload.provenance }),
    entity_key: keyOf(one.entity),
    source_system: one.source_system,
    hit_count: one.hit_count,
    attacker_influenceable: one.attacker_influenceable,
    window: { first_seen: one.first_seen, last_seen: one.last_seen },
  }));
  const conclusion = payload.conclusions.find((one) => one.hypothesis_id === "conclusion");
  return { run_id: payload.investigation_id, tags: payload.provenance, answer: (conclusion?.provenance["answer"] as string | undefined) ?? null, verdicts, gaps, sightings };
}

function memoryOf(pool: readonly Filed[] | null): Memory {
  return {
    recall: async () => [],
    remember: async () => {},
    entities: async ({ keys, asOf }) => {
      const empty = emptyRecall(keys, asOf);
      if (pool === null) return empty;
      return {
        ...empty,
        ranking: { order: "eval: every pooled row", per_key_cap: 0, overall_cap: 0 },
        verdicts: pool.flatMap((one) => one.verdicts),
        gaps: pool.flatMap((one) => one.gaps),
        sightings: pool.flatMap((one) => one.sightings),
      };
    },
  };
}

// --- one run -------------------------------------------------------------------

type Worker = typeof import("../worker.js");
type HarnessModule = typeof import("../harness.js");
let engine: { advance: Worker["advance"]; harnessFor: HarnessModule["harnessFor"] };
type Events = { kind: string; payload: unknown; ts: string; run_kind: string }[];

function configFor(dir: string): string {
  const path = join(dir, "investigate.config.yaml");
  writeFileSync(path, readFileSync(join(HERE, "investigate.config.yaml"), "utf8").replace(/^model: MODEL$/m, `model: ${MODEL}`));
  return path;
}

async function runSide(side: Side, state: InProcessState<AgentKinds> | PublishingLedger<AgentKinds>, shared: SharedFindings | undefined, memory: Memory, config: string) {
  const runId = randomUUID();
  const calls: { tool: string; args: string }[] = [];
  const build = (...args: unknown[]) => {
    const [kind, spec, held, , seed, principal] = args as Parameters<HarnessModule["harnessFor"]>;
    const harness = engine.harnessFor(kind, spec, held, memory, seed, principal);
    return { ...harness, memory, dispatch: estateDispatch(side, harness.dispatch, calls), ...(shared === undefined ? {} : { shared }), ...(flags.dry ? { provider: dryProvider } : {}) };
  };
  const job = {
    schema_version: 1,
    run_id: runId,
    run_kind: "investigate",
    tenant_id: null,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "eval",
    reason: "start",
    request: { arch: "", playbook: join(HERE, "investigate.playbook.yaml"), config, prompt: side.alert, recall_keys: side.entities },
  };
  const started = Date.now();
  let error: string | null = null;
  try {
    await engine.advance(state as never, new InProcessLeases() as never, job as never, build as never);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  return { runId, events: (await state.read(runId)) as unknown as Events, error, wall_ms: Date.now() - started };
}

function summarise(events: Events) {
  const terminal = events.findLast((event) => event.kind === "terminal")?.payload as { outcome?: string; reason?: string; summary?: string } | undefined;
  const conclusion = events.findLast((event) => event.kind === "conclusion")?.payload as { value?: Record<string, unknown> } | undefined;
  const spends = events.filter((event) => event.kind === "spend").map((event) => event.payload as { cost_usd: number | null; tokens?: { input?: number } });
  return {
    outcome: terminal?.outcome ?? null,
    report: terminal?.summary ?? terminal?.reason ?? "",
    disposition: typeof conclusion?.value?.["disposition"] === "string" ? (conclusion.value["disposition"] as string) : null,
    cost_usd: Number(spends.reduce((sum, one) => sum + (one.cost_usd ?? 0), 0).toFixed(6)),
    model_calls: spends.length,
  };
}

async function graded(grader: GraderClient | null, report: string): Promise<Graded | null> {
  if (grader === null || report === "") return null;
  try {
    return await grade(grader, report);
  } catch {
    return null;
  }
}

async function pool<T>(items: readonly T[], width: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.max(1, width) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

// --- main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const prices = await priceServer();
  process.env["BIFROST_URL"] = BIFROST;
  const [worker, harness] = await Promise.all([import("../worker.js"), import("../harness.js")]);
  engine = { advance: worker.advance, harnessFor: harness.harnessFor };
  const wanted = flags.only?.split(",").map((one) => one.trim());
  const pairs = (parseYaml(readFileSync(flags.pairs!, "utf8")) as Pair[]).filter((pair) => wanted === undefined || wanted.includes(pair.id));
  for (const pair of pairs) for (const side of [pair.first, pair.second]) side.traps = side.traps ?? [];
  const work = join(tmpdir(), `vigil-ablation-${LABEL}-${process.pid}`);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(DIR, "ledgers"), { recursive: true });
  const config = configFor(work);
  const grader = flags.dry ? null : graderClient();
  const width = Number(flags.concurrency);
  const histories = Math.max(1, Number(flags.histories));
  const tries = Math.max(1, Number(flags.tries));
  console.log(`ablation ${LABEL}: ${pairs.length} pairs, ${histories} histories, ${tries} tries per arm, ${MODEL}`);

  // History, kept across invocations: a rerun reads what is already there.
  const held = existsSync(HISTORY) ? readFileSync(HISTORY, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pair: string; history: number; side: string; truth: string; filed: Filed }) : [];
  const missing = pairs.flatMap((pair) => Array.from({ length: histories }, (_, h) => ({ pair, history: h + 1 }))).filter(({ pair, history }) => !held.some((one) => one.pair === pair.id && one.history === history));
  await pool(missing, width, async ({ pair, history }) => {
    const shared = new InMemoryShared();
    const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);
    const none = memoryOf(null);
    const first = await runSide(pair.first, ledger, shared, none, config);
    const second = await runSide(pair.second, ledger, shared, none, config);
    for (const [name, side, run] of [["first", pair.first, first], ["second", pair.second, second]] as const) {
      const line = { pair: pair.id, history, side: name, truth: side.truth, error: run.error, filed: filed(kernelDistil(run.runId, run.events)) };
      held.push(line);
      appendFileSync(HISTORY, `${JSON.stringify(line)}\n`);
      writeFileSync(join(DIR, "ledgers", `history-${pair.id}-h${history}-${name}.jsonl`), run.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      const t = line.filed.tags;
      console.log(`  history ${pair.id.padEnd(38)} h${history} ${name.padEnd(6)} truth=${side.truth.padEnd(6)} answer=${String(line.filed.answer).padEnd(14)} review=${t["review"]} held=${t["held"]} rests=${t["rests_on_other_runs"]} outcome=${t["run_outcome"]}`);
    }
  });

  // Targets: an arm whose filter keeps every run is `all` again, and not rerun.
  const done = existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { pair: string; arm: string; try: number }) : [];
  const targets = pairs.flatMap((pair) => {
    const runs = held.filter((one) => one.pair === pair.id && one.history <= histories).map((one) => one.filed);
    return ARMS.flatMap((arm) => {
      const kept = arm.keep === null ? null : runs.filter((one) => arm.keep!(one.tags));
      if (arm.id !== "all" && kept !== null && kept.length === runs.length) return [];
      return Array.from({ length: tries }, (_, t) => ({ pair, arm: arm.id, try: t + 1, kept, served: runs.length - (kept?.length ?? runs.length) }));
    });
  }).filter((one) => !done.some((line) => line.pair === one.pair.id && line.arm === one.arm && line.try === one.try));

  await pool(targets, width, async ({ pair, arm, try: attempt, kept, served }) => {
    const run = await runSide(pair.second, new InProcessState<AgentKinds>(), undefined, memoryOf(kept), config);
    const summary = summarise(run.events);
    const verdict = await graded(grader, summary.report);
    const line = {
      label: LABEL,
      model: MODEL,
      pair: pair.id,
      kind: pair.kind,
      arm,
      try: attempt,
      truth: pair.second.truth,
      verdict: verdict?.verdict ?? null,
      grade_reason: verdict?.reason ?? "",
      runs_in_memory: kept?.length ?? 0,
      runs_filtered_out: served,
      ...summary,
      wall_ms: run.wall_ms,
      error: run.error,
    };
    appendFileSync(OUT, `${JSON.stringify(line)}\n`);
    writeFileSync(join(DIR, "ledgers", `target-${pair.id}-${arm}-t${attempt}.jsonl`), run.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    console.log(`  target  ${pair.id.padEnd(38)} ${arm.padEnd(20)} t${attempt} truth=${pair.second.truth.padEnd(6)} got=${String(line.verdict ?? line.disposition ?? "-").padEnd(12)} memory=${line.runs_in_memory} $${summary.cost_usd.toFixed(4)}${run.error ? `  (${run.error.slice(0, 100)})` : ""}`);
  });
  prices.close();
  console.log(`wrote ${HISTORY} and ${OUT}`);
}

await main();
