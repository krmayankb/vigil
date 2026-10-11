import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import OpenAI from "openai";
import { parse as parseYaml } from "yaml";
import type { AgentKinds } from "../core/agent.js";
import { InProcessLeases } from "../core/leases.js";
import { nullMemory } from "../core/memory.js";
import { SHARED_TOOL, UNREAD_MARK, type Publication, type SharedFinding, type SharedFindings } from "../core/shared-findings.js";
import { InProcessState } from "../core/state.js";
import { PublishingLedger } from "../ledger/publish.js";
import { estateDispatch, type EvalCase } from "./estate.js";
import { grade, type Graded, type GraderClient } from "./grade.js";

// The shared-findings eval. Each pair is two alerts on one entity (pairs/pairs.yaml).
// With sharing on, the first runs to its end and publishes what it finds, then the
// second runs on the same entity and may read it. With sharing off, the second runs
// alone. Only the second is graded; the question is what the first's findings did
// to it.
//
//   npx tsx eval/pairs.ts --label shared-v1 --model vertex/gemini-2.5-pro --reps 2
//   npx tsx eval/pairs.ts --label wiring --dry
//
// The first runs to its end before the second starts, so the second always has
// something to read: the case sharing exists for, measured without a race.

const HERE = dirname(new URL(import.meta.url).pathname);

const { values: flags } = parseArgs({
  options: {
    label: { type: "string" },
    model: { type: "string", default: "vertex/gemini-2.5-pro" },
    "grader-model": { type: "string" },
    pairs: { type: "string", default: join(HERE, "pairs", "pairs.yaml") },
    only: { type: "string" },
    reps: { type: "string", default: "2" },
    concurrency: { type: "string", default: "2" },
    dry: { type: "boolean", default: false },
  },
});
if (flags.label === undefined) {
  console.error("usage: tsx eval/pairs.ts --label <name> [--model provider/model] [--reps n] [--only id,id] [--concurrency n] [--dry]");
  process.exit(2);
}

const LABEL = flags.label;
const MODEL = flags.dry ? "dry/schema-filler" : flags.model!;
const GRADER_MODEL = flags["grader-model"] ?? flags.model!;
const BIFROST = (process.env["BIFROST_URL"] ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const OUT = join(HERE, "results", `pairs-${LABEL}.jsonl`);

type Side = EvalCase & { entities: string[] };
interface Pair {
  id: string;
  kind: "helps" | "neutral" | "misleading" | "adversarial";
  expect: string;
  first: Side;
  second: Side;
}

function loadPairs(path: string): Pair[] {
  const parsed = parseYaml(readFileSync(path, "utf8")) as Pair[];
  for (const pair of parsed) {
    for (const side of [pair.first, pair.second]) {
      if (!Array.isArray(side.entities) || side.entities.length === 0) throw new Error(`${pair.id}: ${side.id} names no entities`);
      side.traps = side.traps ?? [];
    }
    if (!pair.first.entities.some((key) => pair.second.entities.includes(key))) throw new Error(`${pair.id}: the two runs share no entity`);
  }
  return parsed;
}

// --- prices, the dry model and the grader: as eval/run.ts ----------------------

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
// Reads the finding, then reads other runs' findings if offered, then concludes.
const dryProvider = {
  model: MODEL,
  provider_type: "dry",
  stream: async function* (request: { emit?: Record<string, unknown>; tools: readonly { id: string; parameters: Record<string, unknown> }[]; messages: readonly { role: string; content?: string }[] }) {
    yield { type: "usage" as const, tokens: ZERO };
    if (request.emit !== undefined) return void (yield { type: "text_delta" as const, text: JSON.stringify(fill(request.emit)) });
    const seen = request.messages.filter((message) => message.role === "tool").length;
    const has = (id: string) => request.tools.find((tool) => tool.id === id);
    if (seen === 0 && has("get_finding")) yield { type: "tool_call" as const, call: { id: "dry-1", tool: "get_finding", args: '{"finding_id":"f"}' } };
    else if (seen === 1 && has(SHARED_TOOL)) yield { type: "tool_call" as const, call: { id: "dry-2", tool: SHARED_TOOL, args: "{}" } };
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

// --- the journal, in this process ----------------------------------------------

// As the Postgres one behaves: seq per entity, a run never shown its own, newer
// than a watermark only. One per pair and repetition, so nothing leaks between them.
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

// --- one run -----------------------------------------------------------------

// Imported once the price server is up: the harness reads where prices come from
// when it loads, and would otherwise ask the backend's address, which is not here.
type Worker = typeof import("../worker.js");
type HarnessModule = typeof import("../harness.js");
let engine: { advance: Worker["advance"]; harnessFor: HarnessModule["harnessFor"] };

type Events = { kind: string; payload: unknown }[];

function configFor(dir: string): string {
  const path = join(dir, "investigate.config.yaml");
  writeFileSync(path, readFileSync(join(HERE, "investigate.config.yaml"), "utf8").replace(/^model: MODEL$/m, `model: ${MODEL}`));
  return path;
}

async function runSide(side: Side, state: InProcessState<AgentKinds> | PublishingLedger<AgentKinds>, shared: SharedFindings | undefined, config: string): Promise<{ events: Events; tool_calls: number; error: string | null; wall_ms: number }> {
  const runId = randomUUID();
  const calls: { tool: string; args: string }[] = [];
  const build = (...args: unknown[]) => {
    const [kind, spec, held, , seed, principal] = args as Parameters<HarnessModule["harnessFor"]>;
    const harness = engine.harnessFor(kind, spec, held, nullMemory, seed, principal);
    return { ...harness, memory: nullMemory, dispatch: estateDispatch(side, harness.dispatch, calls), ...(shared === undefined ? {} : { shared }), ...(flags.dry ? { provider: dryProvider } : {}) };
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
  return { events: (await state.read(runId)) as Events, tool_calls: calls.length, error, wall_ms: Date.now() - started };
}

function summarise(events: Events) {
  const terminal = events.findLast((event) => event.kind === "terminal")?.payload as { outcome?: string; reason?: string; summary?: string } | undefined;
  const conclusion = events.findLast((event) => event.kind === "conclusion")?.payload as { value?: Record<string, unknown> } | undefined;
  const spends = events.filter((event) => event.kind === "spend").map((event) => event.payload as { cost_usd: number | null });
  const calls = events.filter((event) => event.kind === "call").map((event) => event.payload as { tool: string; ok: boolean; result: string });
  return {
    outcome: terminal?.outcome ?? null,
    report: terminal?.summary ?? terminal?.reason ?? "",
    disposition: typeof conclusion?.value?.["disposition"] === "string" ? (conclusion.value["disposition"] as string) : null,
    cost_usd: Number(spends.reduce((sum, one) => sum + (one.cost_usd ?? 0), 0).toFixed(6)),
    model_calls: spends.length,
    shared_reads: calls.filter((call) => call.tool === SHARED_TOOL && call.ok).length,
    handed_unread: calls.some((call) => call.tool === "conclude" && !call.ok && call.result.includes(UNREAD_MARK)),
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

// --- main ----------------------------------------------------------------------

async function main(): Promise<void> {
  const prices = await priceServer();
  process.env["BIFROST_URL"] = BIFROST;
  const [worker, harness] = await Promise.all([import("../worker.js"), import("../harness.js")]);
  engine = { advance: worker.advance, harnessFor: harness.harnessFor };
  const wanted = flags.only?.split(",").map((one) => one.trim());
  const pairs = loadPairs(flags.pairs!).filter((pair) => wanted === undefined || wanted.includes(pair.id));
  const work = join(tmpdir(), `vigil-pairs-${LABEL}-${process.pid}`);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(HERE, "results", "ledgers", `pairs-${LABEL}`), { recursive: true });
  const config = configFor(work);
  const grader = flags.dry ? null : graderClient();
  const reps = Math.max(1, Number(flags.reps));

  const jobs = pairs.flatMap((pair) => Array.from({ length: reps }, (_, rep) => ({ pair, rep: rep + 1 })));
  console.log(`pairs ${LABEL}: ${pairs.length} pairs x ${reps} reps with ${MODEL}, graded by ${grader?.model ?? "nothing (dry)"}`);
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.max(1, Number(flags.concurrency)) }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
        const { pair, rep } = job;
        // On: the first publishes, the second may read. Off: the second alone.
        const shared = new InMemoryShared();
        const ledger = new PublishingLedger(new InProcessState<AgentKinds>(), shared);
        const first = await runSide(pair.first, ledger, shared, config);
        const on = await runSide(pair.second, ledger, shared, config);
        const off = await runSide(pair.second, new InProcessState<AgentKinds>(), undefined, config);
        const firstSummary = summarise(first.events);
        for (const [condition, side] of [["on", on], ["off", off]] as const) {
          const summary = summarise(side.events);
          const verdict = await graded(grader, summary.report);
          const line = {
            label: LABEL,
            model: MODEL,
            pair: pair.id,
            kind: pair.kind,
            rep,
            condition,
            truth: pair.second.truth,
            verdict: verdict?.verdict ?? null,
            grade_reason: verdict?.reason ?? "",
            ...summary,
            tool_calls: side.tool_calls,
            wall_ms: side.wall_ms,
            published: condition === "on" ? shared.rows.length : 0,
            first: { disposition: firstSummary.disposition, outcome: firstSummary.outcome, cost_usd: firstSummary.cost_usd },
            error: side.error ?? first.error,
          };
          appendFileSync(OUT, `${JSON.stringify(line)}\n`);
          writeFileSync(join(HERE, "results", "ledgers", `pairs-${LABEL}`, `${pair.id}-r${rep}-${condition}.jsonl`), side.events.map((event) => JSON.stringify(event)).join("\n") + "\n");
          console.log(`  ${pair.id.padEnd(40)} r${rep} ${condition.padEnd(3)} truth=${pair.second.truth.padEnd(6)} got=${String(line.verdict ?? line.disposition ?? "-").padEnd(12)} $${summary.cost_usd.toFixed(4)} ${summary.model_calls} model, reads ${summary.shared_reads}${summary.handed_unread ? ", handed unread" : ""}${line.error ? `  (${line.error.slice(0, 100)})` : ""}`);
        }
      }
    }),
  );
  prices.close();
  console.log(`wrote ${OUT}`);
}

await main();
