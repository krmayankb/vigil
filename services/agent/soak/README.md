# Soak

Runs many investigate runs through real worker processes, real Postgres and real
Redis, against a stub that plays the model gateway and the backend's tool, recall
and pricing endpoints (`stub.ts`). It measures the agent layer at load: queue wait,
run time, throughput, what fails, and what Postgres and the ledger carry. The stub
answers like a model working an alert in three turns, priced as Gemini 2.5 Pro, so
per-run calls and dollars read like a real run's.

## Containers

The soak empties its database and Redis first, so it refuses anything but its own:

```sh
docker run -d --name vigil-soak-postgres -e POSTGRES_PASSWORD=soak -e POSTGRES_USER=soak \
  -e POSTGRES_DB=soak -p 127.0.0.1:55433:5432 postgres:16-alpine -c max_connections=400
docker run -d --name vigil-soak-redis -p 127.0.0.1:56379:6379 redis:7-alpine
for f in 19_agent_ledger 20_agent_directives 21_agent_run_leases 31_agent_ledger_hash_chain 41_agent_run_leases_lane; do
  docker exec -i vigil-soak-postgres psql -q -U soak -d soak < ../../infra/database/init/$f.sql
done
```

## Running

```sh
npx tsx soak/soak.ts --label w4c50 --runs 1000 --workers 4 --concurrency 50 --model-ms 3000
```

| Flag | Meaning |
|---|---|
| `--runs`, `--rate` | How many runs, and how many enqueued per second (0 = all at once) |
| `--workers`, `--concurrency` | Worker processes, and runs each takes at once (`VIGIL_RUN_CONCURRENCY`) |
| `--llm-concurrency`, `--llm-rpm`, `--llm-tpm` | The worker's model limiter, per process (`VIGIL_LLM_*`; defaults 4, 500, 400k) |
| `--pg-pool` | Postgres pool per worker (`VIGIL_PG_POOL_MAX`; default 10) |
| `--model-ms`, `--tool-ms` | Mean stub latency for a model call and a tool call |
| `--p429`, `--p-tool-error` | Fraction of model calls answered 429, and of tool calls answered unavailable |
| `--benign` | Fraction of runs that conclude benign and go through the reviewer |

Each run writes `soak/results/<label>.md`, `<label>.json` (with a sample every 2s)
and each worker's log under `soak/results/<label>/`.

## What it does not cover

The backend is not in the loop: run mirroring (`VIGIL_RUNS_URL`), the daemon's
intake and distil, and real tool backends are stubbed or off. A real model's
latency varies far more than the stub's.

## Findings, 2026-10-10

Measured on one laptop (8 CPUs shared by the workers, the stub and Postgres),
investigate runs, stub model at 3s a call. Results in `soak/results/`.

| Run | Setup | Throughput | Run time p50 | What it showed |
|---|---|---|---|---|
| a | 2 workers × 4 (today's default) | 40/min | 12s | Healthy, but only 8 slots: a burst of 100 waited up to 2.4 min |
| b | 4 × 50, limiter default | 109/min | 113s | The model limiter (4 calls per process) is the first ceiling: 200 runs share 16 slots |
| c | 4 × 50, limiter 50 | 901/min | 12.5s | Limiter raised: run time back to normal, no errors |
| d | 8 × 100, limiter 100 | 1,259/min | 31s | Next ceiling: runs wait on Postgres |
| e | 8 × 100, pg pool 40 | 537/min | 75s | More connections made it worse: Postgres itself saturates |
| g | 8 × 100, CPU sampled | 1,071/min | 41s | Postgres 500-670% CPU, workers 100-190% |
| h | 4 × 50, 20% 429s, 10% tool errors | 785/min | 13s | 15 of 600 runs failed for good on a 429; tool errors cost nothing |

Every run completed in every configuration except h. No lost runs, no stuck
leases, no BullMQ failures, at up to 800 concurrent runs.

**What breaks first, in order**

1. The model limiter, 4 calls in flight per worker process, whatever
   `VIGIL_RUN_CONCURRENCY` says. Now configurable (`VIGIL_LLM_CONCURRENCY`), and
   per process, so it multiplies with replicas: it must become a shared limit.
2. Postgres CPU, at roughly 1,100-1,250 runs a minute on this box. About 190ms of
   database time per run: 38 single-row inserts at ~3.3ms (each its own commit,
   each hashing its whole payload in the trigger) and ~20 full re-reads of the
   run's ledger at ~3.1ms. Batching appends and reading incrementally are the
   levers; a bigger pool is not.
3. A transient 429 that outlasts the limiter's 3 attempts fails the run
   permanently (2.5% of runs at a 20% 429 rate). It should park or requeue.

**Sizes**: 36 ledger events and about 42 KB per investigate run, so a million
runs is about 42 GB of ledger before indexes.
