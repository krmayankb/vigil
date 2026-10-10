import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { RECALL_TOOL, emptyRecall } from "../contracts/memory.js";

// Everything a worker reaches over HTTP, in one process, so a soak run measures
// the agent layer and not a provider: the gateway's OpenAI surface (streamed),
// the backend's tool, recall and pricing endpoints. It answers like a model that
// investigates an alert in three turns -- four estate queries, two more and a
// record link, then the conclude call -- so each run makes the calls a real
// investigate run makes, at a latency and failure rate the caller sets.

export interface StubOptions {
  // Mean model-call latency, and the spread either side of it.
  modelMs: number;
  modelJitterMs: number;
  toolMs: number;
  // Fraction of model calls answered 429, and of tool calls answered unavailable.
  p429: number;
  pToolError: number;
  // Fraction of runs that conclude benign, which sends them through the reviewer.
  benign: number;
  // Output tokens a model call reports, the cost driver on a reasoning model.
  outputTokens: number;
}

export const DEFAULTS: StubOptions = { modelMs: 3000, modelJitterMs: 1500, toolMs: 400, p429: 0, pToolError: 0, benign: 0.3, outputTokens: 700 };

// Gemini 2.5 Pro, as eval/prices.yaml carries it, per token.
const CARD = { input: 1.25e-6, output: 10e-6, cache_read: 0.31e-6, cache_write: 0, source: "soak", fetched_at: new Date().toISOString() };

interface Gauge {
  now: number;
  peak: number;
}

export interface StubStats {
  model_calls: number;
  model_429: number;
  model_concurrent: Gauge;
  tool_calls: number;
  tool_errors: number;
  tool_concurrent: Gauge;
  recalls: number;
  started_at: number;
}

export function emptyStats(): StubStats {
  return {
    model_calls: 0,
    model_429: 0,
    model_concurrent: { now: 0, peak: 0 },
    tool_calls: 0,
    tool_errors: 0,
    tool_concurrent: { now: 0, peak: 0 },
    recalls: 0,
    started_at: Date.now(),
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, Math.max(0, ms)));
const jitter = (mean: number, spread: number) => mean + (Math.random() * 2 - 1) * spread;
const enter = (gauge: Gauge) => {
  gauge.now += 1;
  gauge.peak = Math.max(gauge.peak, gauge.now);
};

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

// --- the model -------------------------------------------------------------------

type Message = { role: string; content?: unknown; tool_calls?: unknown[] };
type ToolDef = { type: string; function: { name: string; parameters?: Record<string, unknown> } };
type Call = { name: string; args: Record<string, unknown> };

// Fills a schema with a plausible value: the first enum option, every required field.
function fill(schema: Record<string, unknown>): unknown {
  const options = schema["enum"];
  if (Array.isArray(options)) return options[0];
  const kind = Array.isArray(schema["type"]) ? (schema["type"] as unknown[])[0] : schema["type"];
  if (kind === "object") {
    const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const required = (schema["required"] ?? []) as string[];
    return Object.fromEntries(required.map((key) => [key, fill(properties[key] ?? { type: "string" })]));
  }
  if (kind === "array") return [];
  if (kind === "number" || kind === "integer") return 1;
  if (kind === "boolean") return true;
  return "soak: filled by the stub model";
}

// Stable per run: the alert in the first user message names the run's case.
function seedOf(messages: readonly Message[]): number {
  const first = messages.find((message) => message.role === "user");
  const text = typeof first?.content === "string" ? first.content : JSON.stringify(first?.content ?? "");
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

function investigateTurn(messages: readonly Message[], tools: readonly string[], benign: boolean): { say: string; calls: Call[] } {
  const results = messages.filter((message) => message.role === "tool").length;
  const has = (name: string) => tools.includes(name);
  if (results === 0) {
    return {
      say: "Reading the finding and the case, and checking the host's traffic and indicators.",
      calls: [
        { name: "get_finding", args: { finding_id: "f-soak" } },
        { name: "case_records", args: { case_id: "case-soak" } },
        { name: "splunk_search", args: { sql: "SELECT time, host, event FROM events WHERE host = 'ws-17' LIMIT 50" } },
        { name: "lookup_indicators", args: { values: ["198.51.100.7"] } },
      ].filter((call) => has(call.name)),
    };
  }
  if (results < 6) {
    const statement = benign ? "ws-17 runs a scheduled backup job to a known host" : "ws-17 is beaconing to 198.51.100.7";
    return {
      say: "Widening the window and checking related findings.",
      calls: [
        { name: "splunk_search", args: { sql: "SELECT time, host, detail FROM events WHERE detail LIKE '%198.51.100.7%'" } },
        { name: "search_findings", args: { query: "ws-17" } },
        { name: "link_evidence", args: { links: [{ evidence_id: "r3", statement, stance: "supports" }] } },
      ].filter((call) => has(call.name)),
    };
  }
  return {
    say: "",
    calls: [
      {
        name: "conclude",
        args: {
          summary: benign ? "A scheduled backup job on ws-17 explains the traffic." : "ws-17 is beaconing to 198.51.100.7 every 300s.",
          disposition: benign ? "benign" : "malicious",
          confidence: "medium",
          citations: ["r3"],
          gaps: [],
          next_steps: [benign ? "Close the alert." : "Isolate ws-17."],
        },
      },
    ],
  };
}

function genericTurn(messages: readonly Message[], tools: readonly string[]): { say: string; calls: Call[] } {
  const looked = messages.some((message) => message.role === "tool");
  const estate = tools.find((name) => !["load_skill", "propose_hypothesis", "link_evidence", "open_question"].includes(name));
  if (!looked && estate !== undefined) return { say: "Looking.", calls: [{ name: estate, args: {} }] };
  return { say: "Nothing further to examine; concluding on what was found.", calls: [] };
}

function chunk(model: string, delta: Record<string, unknown>, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

async function completions(req: IncomingMessage, res: ServerResponse, options: StubOptions, stats: StubStats): Promise<void> {
  const body = await bodyOf(req);
  stats.model_calls += 1;
  if (Math.random() < options.p429) {
    stats.model_429 += 1;
    json(res, 429, { error: { message: "soak: rate limited", type: "rate_limit" } }, { "retry-after": "1" });
    return;
  }
  enter(stats.model_concurrent);
  try {
    const model = String(body["model"] ?? "soak");
    const messages = (body["messages"] ?? []) as Message[];
    const tools = ((body["tools"] ?? []) as ToolDef[]).map((tool) => tool.function.name);
    const format = body["response_format"] as { json_schema?: { schema?: Record<string, unknown> } } | undefined;
    const forced = (body["tool_choice"] as { function?: { name?: string } } | undefined)?.function?.name;

    let say = "";
    let calls: Call[] = [];
    if (format?.json_schema?.schema !== undefined) {
      say = JSON.stringify(fill(format.json_schema.schema));
    } else if (forced !== undefined) {
      const def = ((body["tools"] ?? []) as ToolDef[]).find((tool) => tool.function.name === forced);
      calls = [{ name: forced, args: fill(def?.function.parameters ?? { type: "object" }) as Record<string, unknown> }];
    } else if (tools.includes("conclude")) {
      ({ say, calls } = investigateTurn(messages, tools, (seedOf(messages) % 1000) / 1000 < options.benign));
    } else {
      ({ say, calls } = genericTurn(messages, tools));
    }

    const total = jitter(options.modelMs, options.modelJitterMs);
    // First token after a fraction of the call, the rest streamed: a worker holds the
    // connection for the whole call, as it does on a real gateway.
    await sleep(total * 0.3);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(chunk(model, { role: "assistant", content: "" }));
    if (say !== "") {
      for (const part of say.match(/.{1,80}/gs) ?? []) res.write(chunk(model, { content: part }));
    }
    await sleep(total * 0.7);
    calls.forEach((call, index) => {
      res.write(chunk(model, { tool_calls: [{ index, id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));
    });
    res.write(chunk(model, {}, calls.length > 0 ? "tool_calls" : "stop"));
    const prompt = Math.ceil(JSON.stringify(body).length / 4);
    res.write(`data: ${JSON.stringify({ id: "soak", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: options.outputTokens, total_tokens: prompt + options.outputTokens } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } finally {
    stats.model_concurrent.now -= 1;
  }
}

// --- the backend -------------------------------------------------------------------

function rowsFor(tool: string, count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    time: new Date(Date.now() - i * 300_000).toISOString(),
    host: "ws-17",
    user: "svc_backup",
    source: tool,
    event: i % 3 === 0 ? "conn" : "dns",
    detail: `outbound 10.0.4.17 -> 198.51.100.7:443 bytes_out=${900 + i} bytes_in=${300 + i} interval=300s`,
  }));
}

async function invoke(req: IncomingMessage, res: ServerResponse, options: StubOptions, stats: StubStats): Promise<void> {
  const body = await bodyOf(req);
  const tool = String(body["tool"] ?? "");
  if (tool === RECALL_TOOL) {
    stats.recalls += 1;
    const args = (body["args"] ?? {}) as { keys?: string[] };
    json(res, 200, { ok: true, rows: [emptyRecall(args.keys ?? [], new Date().toISOString())], rowCount: 1, capped: false, sourceSystem: "memory" });
    return;
  }
  stats.tool_calls += 1;
  enter(stats.tool_concurrent);
  try {
    await sleep(jitter(options.toolMs, options.toolMs / 2));
    if (Math.random() < options.pToolError) {
      stats.tool_errors += 1;
      json(res, 200, { ok: false, failure: { kind: "unavailable", detail: "soak: backend unavailable" } });
      return;
    }
    const rows = rowsFor(tool, 3 + Math.floor(Math.random() * 6));
    json(res, 200, { ok: true, rows, rowCount: rows.length, capped: false, sourceSystem: tool });
  } finally {
    stats.tool_concurrent.now -= 1;
  }
}

export async function startStub(options: StubOptions = DEFAULTS, port = 0): Promise<{ server: Server; port: number; stats: StubStats }> {
  const stats = emptyStats();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = `${req.method} ${url.pathname}`;
    const fail = (error: unknown) => {
      if (!res.headersSent) json(res, 500, { error: String(error) });
      else res.end();
    };
    if (route === "POST /v1/chat/completions") return void completions(req, res, options, stats).catch(fail);
    if (route === "POST /internal/tools/invoke") return void invoke(req, res, options, stats).catch(fail);
    if (route === "GET /internal/pricing/rates") return json(res, 200, CARD);
    if (route === "GET /internal/pricing/vk") return json(res, 200, { vk: null });
    if (route === "GET /stats") return json(res, 200, stats);
    json(res, 404, { error: `soak stub has no ${route}` });
  });
  // A thousand concurrent runs keep many sockets open; the defaults close idle ones early.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  server.maxConnections = 20_000;
  await new Promise<void>((done) => server.listen(port, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the soak stub did not bind");
  return { server, port: address.port, stats };
}
