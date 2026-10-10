import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Queue } from "bullmq";
import pg from "pg";
import { JOB_SCHEMA_VERSION, RUN_QUEUE, type RunJob } from "../contracts/job.js";
import { DEFAULTS, startStub, type StubOptions, type StubStats } from "./stub.js";

// A soak run: real workers, real Postgres and Redis, a stub model and estate.
//
//   npx tsx soak/soak.ts --runs 500 --workers 4 --concurrency 8 --label w4c8
//
// Refuses any database or Redis that is not the soak containers, because it
// empties both first. Writes soak/results/<label>.json and <label>.md.

const HERE = dirname(new URL(import.meta.url).pathname);
const AGENT = dirname(HERE);

const { values: flags } = parseArgs({
  options: {
    label: { type: "string" },
    runs: { type: "string", default: "100" },
    workers: { type: "string", default: "2" },
    concurrency: { type: "string", default: "4" },
    // Runs enqueued per second; 0 enqueues them all at once.
    rate: { type: "string", default: "0" },
    "model-ms": { type: "string", default: String(DEFAULTS.modelMs) },
    "tool-ms": { type: "string", default: String(DEFAULTS.toolMs) },
    p429: { type: "string", default: String(DEFAULTS.p429) },
    "p-tool-error": { type: "string", default: String(DEFAULTS.pToolError) },
    benign: { type: "string", default: String(DEFAULTS.benign) },
    "timeout-min": { type: "string", default: "30" },
    // The worker's model limiter, per process; unset keeps the worker's own defaults.
    "llm-concurrency": { type: "string" },
    "llm-rpm": { type: "string" },
    "llm-tpm": { type: "string" },
    // Postgres pool size per worker; unset keeps pg's default of 10.
    "pg-pool": { type: "string" },
    database: { type: "string", default: "postgres://soak:soak@127.0.0.1:55432/soak" },
    redis: { type: "string", default: "redis://127.0.0.1:56379/0" },
  },
});

const LABEL = flags.label ?? `soak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const RUNS = Number(flags.runs);
const WORKERS = Number(flags.workers);
const CONCURRENCY = Number(flags.concurrency);
const RATE = Number(flags.rate);
const DATABASE = flags.database!;
const REDIS = flags.redis!;
const OUT = join(HERE, "results");

// Emptying a database is the first thing this does; make sure it is the soak's.
if (!DATABASE.includes(":55432/soak") || !REDIS.includes(":56379")) {
  console.error("soak refuses to run against anything but the soak containers (postgres :55432/soak, redis :56379)");
  process.exit(2);
}

const stubOptions: StubOptions = {
  ...DEFAULTS,
  modelMs: Number(flags["model-ms"]),
  modelJitterMs: Number(flags["model-ms"]) / 2,
  toolMs: Number(flags["tool-ms"]),
  p429: Number(flags.p429),
  pToolError: Number(flags["p-tool-error"]),
  benign: Number(flags.benign),
};

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const run = promisify(execFile);

// Summed %CPU of a process tree (npx -> tsx -> node), one core = 100.
async function cpuOf(roots: readonly number[]): Promise<number> {
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,%cpu="]);
    const rows = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number) as [number, number, number]);
    const children = new Map<number, number[]>();
    for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    const cpu = new Map(rows.map(([pid, , value]) => [pid, value]));
    let total = 0;
    const stack = [...roots];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      total += cpu.get(pid) ?? 0;
      stack.push(...(children.get(pid) ?? []));
    }
    return Math.round(total);
  } catch {
    return -1;
  }
}

async function postgresCpu(): Promise<number> {
  try {
    const { stdout } = await run("docker", ["stats", "--no-stream", "--format", "{{.CPUPerc}}", "vigil-soak-postgres"]);
    return Math.round(Number.parseFloat(stdout));
  } catch {
    return -1;
  }
}

function redisConnection(url: string): { host: string; port: number; db: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), db: Number(parsed.pathname.slice(1) || 0) };
}

async function reset(pool: pg.Pool, queue: Queue): Promise<void> {
  await pool.query("TRUNCATE agent_events, agent_run_leases, agent_directives");
  await queue.obliterate({ force: true });
}

function startWorkers(stubPort: number, logDir: string): ChildProcess[] {
  const stub = `http://127.0.0.1:${stubPort}`;
  return Array.from({ length: WORKERS }, (_, index) => {
    const log = createWriteStream(join(logDir, `worker-${index}.log`));
    const child = spawn("npx", ["tsx", "worker.ts"], {
      cwd: AGENT,
      env: {
        ...process.env,
        DATABASE_URL: DATABASE,
        REDIS_URL: REDIS,
        BIFROST_URL: stub,
        VIGIL_TOOLS_URL: `${stub}/internal/tools/invoke`,
        VIGIL_PRICING_URL: `${stub}/internal/pricing`,
        VIGIL_PLAYBOOKS_URL: `${stub}/internal/playbooks`,
        AGENT_INTERNAL_TOKEN: "soak",
        VIGIL_RUN_CONCURRENCY: String(CONCURRENCY),
        AGENT_HEALTH_PORT: String(17_000 + index),
        ...(flags["llm-concurrency"] === undefined ? {} : { VIGIL_LLM_CONCURRENCY: flags["llm-concurrency"] }),
        ...(flags["llm-rpm"] === undefined ? {} : { VIGIL_LLM_RPM: flags["llm-rpm"] }),
        ...(flags["llm-tpm"] === undefined ? {} : { VIGIL_LLM_TPM: flags["llm-tpm"] }),
        ...(flags["pg-pool"] === undefined ? {} : { VIGIL_PG_POOL_MAX: flags["pg-pool"] }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    return child;
  });
}

async function workersReady(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let index = 0; index < WORKERS; index += 1) {
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${17_000 + index}/readyz`);
        if (res.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`worker ${index} never became ready; see its log`);
      await sleep(500);
    }
  }
}

function jobFor(runId: string, index: number): RunJob {
  return {
    schema_version: JOB_SCHEMA_VERSION,
    run_id: runId,
    run_kind: "investigate",
    tenant_id: null,
    enqueued_at: new Date().toISOString(),
    enqueued_by: "soak",
    reason: "start",
    request: {
      arch: "",
      playbook: join(AGENT, "eval", "investigate.playbook.yaml"),
      config: join(HERE, "soak.config.yaml"),
      prompt: `Alert soak-${index}: fixed-interval outbound traffic from host ws-17 (10.0.4.17) to 198.51.100.7:443. Finding f-soak, case case-soak-${index}.`,
      recall_keys: ["host:ws-17", "ip:198.51.100.7"],
    },
  };
}

interface Sample {
  t_s: number;
  waiting: number;
  active: number;
  done: number;
  failed_jobs: number;
  model_concurrent: number;
  tool_concurrent: number;
  pg_connections: number;
  workers_cpu: number;
  postgres_cpu: number;
}

interface RunRow {
  run_id: string;
  started: Date | null;
  ended: Date | null;
  outcome: string | null;
  reason: string | null;
  model_calls: number;
  tool_calls: number;
  events: number;
  cost_usd: number;
  children: number;
}

const pct = (values: readonly number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
};

async function main(): Promise<void> {
  mkdirSync(join(OUT, LABEL), { recursive: true });
  const pool = new pg.Pool({ connectionString: DATABASE, max: 4 });
  const queue = new Queue<RunJob>(RUN_QUEUE, { connection: redisConnection(REDIS) });
  await reset(pool, queue);

  const stub = await startStub(stubOptions);
  const workers = startWorkers(stub.port, join(OUT, LABEL));
  const stopAll = () => workers.forEach((child) => child.kill("SIGTERM"));
  process.on("SIGINT", () => {
    stopAll();
    process.exit(130);
  });

  try {
    await workersReady();
    console.log(`soak ${LABEL}: ${RUNS} runs, ${WORKERS} workers x ${CONCURRENCY}, model ${stubOptions.modelMs}ms, p429 ${stubOptions.p429}`);

    const enqueued = new Map<string, number>();
    const t0 = Date.now();
    const samples: Sample[] = [];
    const enqueue = (async () => {
      for (let index = 0; index < RUNS; index += 1) {
        const runId = randomUUID();
        enqueued.set(runId, Date.now());
        await queue.add(RUN_QUEUE, jobFor(runId, index), { jobId: runId, attempts: 3, backoff: { type: "exponential", delay: 5000 } });
        if (RATE > 0) await sleep(1000 / RATE);
      }
    })();

    const deadline = t0 + Number(flags["timeout-min"]) * 60_000;
    let done = 0;
    while (Date.now() < deadline) {
      await sleep(2000);
      const [terminals, active, conns, counts, stats, workersCpu, pgCpu] = await Promise.all([
        pool.query<{ n: string }>("SELECT count(*) AS n FROM agent_events WHERE kind = 'terminal' AND run_kind = 'investigate'"),
        pool.query<{ n: string }>(
          "SELECT (SELECT count(*) FROM agent_events WHERE kind = 'run' AND run_kind = 'investigate') - (SELECT count(*) FROM agent_events WHERE kind = 'terminal' AND run_kind = 'investigate') AS n",
        ),
        pool.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE datname = 'soak'"),
        queue.getJobCounts("waiting", "active", "failed", "delayed"),
        Promise.resolve(stub.stats),
        cpuOf(workers.map((child) => child.pid ?? 0)),
        postgresCpu(),
      ]);
      done = Number(terminals.rows[0]?.n ?? 0);
      samples.push({
        t_s: Math.round((Date.now() - t0) / 1000),
        waiting: (counts["waiting"] ?? 0) + (counts["delayed"] ?? 0),
        active: Number(active.rows[0]?.n ?? 0),
        done,
        failed_jobs: counts["failed"] ?? 0,
        model_concurrent: stats.model_concurrent.now,
        tool_concurrent: stats.tool_concurrent.now,
        pg_connections: Number(conns.rows[0]?.n ?? 0),
        workers_cpu: workersCpu,
        postgres_cpu: pgCpu,
      });
      const last = samples[samples.length - 1]!;
      process.stdout.write(`\r  t=${last.t_s}s done ${done}/${RUNS} active ${last.active} waiting ${last.waiting} failed ${last.failed_jobs} model-inflight ${last.model_concurrent} pg ${last.pg_connections} cpu w${last.workers_cpu}% pg${last.postgres_cpu}%   `);
      if (done + last.failed_jobs >= RUNS) break;
    }
    await enqueue;
    process.stdout.write("\n");
    const wall_s = (Date.now() - t0) / 1000;

    const rows = await pool.query<RunRow>(`
      SELECT r.run_id,
             min(e.ts) FILTER (WHERE e.kind = 'run') AS started,
             max(e.ts) FILTER (WHERE e.kind = 'terminal') AS ended,
             max(e.payload->>'outcome') FILTER (WHERE e.kind = 'terminal') AS outcome,
             max(e.payload->>'reason') FILTER (WHERE e.kind = 'terminal') AS reason,
             count(*) FILTER (WHERE e.kind = 'spend')::int AS model_calls,
             count(*) FILTER (WHERE e.kind = 'call')::int AS tool_calls,
             count(*)::int AS events,
             coalesce(sum((e.payload->>'cost_usd')::numeric) FILTER (WHERE e.kind = 'spend'), 0)::float AS cost_usd,
             count(*) FILTER (WHERE e.kind = 'child')::int AS children
        FROM (SELECT DISTINCT run_id FROM agent_events WHERE run_kind = 'investigate') r
        JOIN agent_events e ON e.run_id = r.run_id
       GROUP BY r.run_id`);
    const size = await pool.query<{ events: string; bytes: string; children: string }>(
      "SELECT count(*) AS events, pg_total_relation_size('agent_events') AS bytes, count(DISTINCT run_id) FILTER (WHERE run_kind = 'subagent') AS children FROM agent_events",
    );
    const counts = await queue.getJobCounts("completed", "failed", "waiting", "active", "delayed");

    const runs = rows.rows;
    const finished = runs.filter((run) => run.ended !== null);
    const waits = runs.filter((run) => run.started !== null && enqueued.has(run.run_id)).map((run) => (run.started!.getTime() - enqueued.get(run.run_id)!) / 1000);
    const durations = finished.map((run) => (run.ended!.getTime() - run.started!.getTime()) / 1000);
    const outcomes: Record<string, number> = {};
    const reasons: Record<string, number> = {};
    for (const run of runs) {
      const key = run.outcome ?? "unfinished";
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      if (run.outcome !== "completed") reasons[(run.reason ?? "unfinished").slice(0, 120)] = (reasons[(run.reason ?? "unfinished").slice(0, 120)] ?? 0) + 1;
    }
    const finishedTimes = finished.map((run) => run.ended!.getTime()).sort((a, b) => a - b);
    const span = finishedTimes.length > 1 ? (finishedTimes[finishedTimes.length - 1]! - finishedTimes[0]!) / 60_000 : 0;
    const stats: StubStats = stub.stats;

    const report = {
      label: LABEL,
      at: new Date().toISOString(),
      config: { runs: RUNS, workers: WORKERS, concurrency: CONCURRENCY, rate: RATE, llm: { concurrency: flags["llm-concurrency"] ?? "4 (default)", rpm: flags["llm-rpm"] ?? "500 (default)", tpm: flags["llm-tpm"] ?? "400000 (default)" }, pg_pool: flags["pg-pool"] ?? "10 (default)", stub: stubOptions },
      wall_s,
      enqueued: enqueued.size,
      started: runs.length,
      finished: finished.length,
      outcomes,
      failure_reasons: reasons,
      bullmq: counts,
      queue_wait_s: { p50: pct(waits, 50), p95: pct(waits, 95), p99: pct(waits, 99), max: pct(waits, 100) },
      run_s: { p50: pct(durations, 50), p95: pct(durations, 95), p99: pct(durations, 99), max: pct(durations, 100) },
      throughput_runs_per_min: span > 0 ? finished.length / span : null,
      per_run: {
        model_calls: finished.length ? finished.reduce((a, r) => a + r.model_calls, 0) / finished.length : 0,
        tool_calls: finished.length ? finished.reduce((a, r) => a + r.tool_calls, 0) / finished.length : 0,
        events: finished.length ? finished.reduce((a, r) => a + r.events, 0) / finished.length : 0,
        cost_usd: finished.length ? finished.reduce((a, r) => a + r.cost_usd, 0) / finished.length : 0,
        children: finished.length ? finished.reduce((a, r) => a + r.children, 0) / finished.length : 0,
      },
      cost_total_usd: runs.reduce((a, r) => a + r.cost_usd, 0),
      ledger: { events: Number(size.rows[0]?.events ?? 0), bytes: Number(size.rows[0]?.bytes ?? 0), child_runs: Number(size.rows[0]?.children ?? 0) },
      stub: {
        model_calls: stats.model_calls,
        model_429: stats.model_429,
        model_peak_inflight: stats.model_concurrent.peak,
        tool_calls: stats.tool_calls,
        tool_errors: stats.tool_errors,
        tool_peak_inflight: stats.tool_concurrent.peak,
        recalls: stats.recalls,
      },
      peak: {
        active_runs: Math.max(0, ...samples.map((s) => s.active)),
        pg_connections: Math.max(0, ...samples.map((s) => s.pg_connections)),
        workers_cpu: Math.max(0, ...samples.map((s) => s.workers_cpu)),
        postgres_cpu: Math.max(0, ...samples.map((s) => s.postgres_cpu)),
      },
      samples,
    };
    writeFileSync(join(OUT, `${LABEL}.json`), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(OUT, `${LABEL}.md`), markdown(report));
    console.log(markdown(report));
  } finally {
    stopAll();
    await sleep(1500);
    await queue.close();
    await pool.end();
    stub.server.close();
  }
}

function markdown(r: ReturnType<typeof JSON.parse>): string {
  const f = (n: number, d = 1) => Number(n).toFixed(d);
  return [
    `## Soak ${r.label}`,
    "",
    `${r.config.runs} runs · ${r.config.workers} workers × ${r.config.concurrency} · model limiter ${r.config.llm.concurrency} in flight, ${r.config.llm.rpm} rpm per worker · pg pool ${r.config.pg_pool} · model ${r.config.stub.modelMs}ms · p429 ${r.config.stub.p429} · tool errors ${r.config.stub.pToolError}`,
    "",
    "| | |",
    "|---|---|",
    `| finished / started / enqueued | ${r.finished} / ${r.started} / ${r.enqueued} |`,
    `| outcomes | ${Object.entries(r.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")} |`,
    `| wall time | ${f(r.wall_s, 0)}s |`,
    `| throughput | ${r.throughput_runs_per_min === null ? "n/a" : f(r.throughput_runs_per_min)} runs/min |`,
    `| queue wait p50 / p95 / max | ${f(r.queue_wait_s.p50)}s / ${f(r.queue_wait_s.p95)}s / ${f(r.queue_wait_s.max)}s |`,
    `| run time p50 / p95 / max | ${f(r.run_s.p50)}s / ${f(r.run_s.p95)}s / ${f(r.run_s.max)}s |`,
    `| per run: model calls / tool calls / events | ${f(r.per_run.model_calls)} / ${f(r.per_run.tool_calls)} / ${f(r.per_run.events, 0)} |`,
    `| per run cost / total | $${f(r.per_run.cost_usd, 4)} / $${f(r.cost_total_usd, 2)} |`,
    `| peak active runs / model calls in flight | ${r.peak.active_runs} / ${r.stub.model_peak_inflight} |`,
    `| peak Postgres connections | ${r.peak.pg_connections} |`,
    `| peak CPU: workers / Postgres (100 = one core) | ${r.peak.workers_cpu}% / ${r.peak.postgres_cpu}% |`,
    `| ledger | ${r.ledger.events} events, ${f(r.ledger.bytes / 1e6)} MB, ${r.ledger.child_runs} child runs |`,
    `| stub | ${r.stub.model_calls} model calls (${r.stub.model_429} × 429), ${r.stub.tool_calls} tool calls (${r.stub.tool_errors} errors) |`,
    `| BullMQ | ${Object.entries(r.bullmq).map(([k, v]) => `${k} ${v}`).join(", ")} |`,
    ...(Object.keys(r.failure_reasons).length === 0 ? [] : ["", "Not completed:", "", ...Object.entries(r.failure_reasons).map(([k, v]) => `- ${v} × ${k}`)]),
    "",
  ].join("\n");
}

await main();
