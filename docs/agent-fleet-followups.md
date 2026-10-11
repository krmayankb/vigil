# Agent fleet: what is not done yet

Things the fleet plan left open on purpose, or found along the way, with where
each belongs. Kept current as phases land; remove an item when it ships.

## Decisions waiting on a person

- **Activity classes and routes.** `core/triage` routes by the five rules the daemon
  always used (`RulesV1`). The class list and each class's workflow are data: one
  SystemConfig row, `triage.routes`.
- **Budget values.** Fleet caps (`VIGIL_FLEET_BUDGET_HOURLY_USD`, `_DAILY_USD`) and
  per-workflow caps (SystemConfig `workflows.budgets`) are unset everywhere.
- **Policy boundaries.** What agents may do -- tools, actions, data, and when a
  person must approve -- is parked as a phase of its own.

## Phase 1 (limits, lanes, budget, daemon)

- **Database cost per run.** About 38 single-row inserts per run, each hashed by a
  trigger, and the first whole-ledger read, still dominate database time. "Scales
  with worker count" is unproven: the laptop soak runs out of CPU first. Needs a soak
  against a dedicated Postgres; if inserts still dominate, write fewer, larger
  batches per model turn.
- **The console cannot see `/fleet`.** It is on agent-serve only, not proxied by the
  backend; there are no Prometheus metrics, only log lines for alerts. Phase 5.
- **v1 API runs are always automated.** The v1 contract is frozen, so it has no lane.
- **A deferred run reads as running.** A run waiting out a provider outage shows as
  running with a reason; a distinct status needs a console change.
- **The laptop soak stalls.** Every active run pauses at once for 8-17 minutes, on
  old code and new alike (soak README, Phase 4). Throughput figures need a soak on a
  machine that does not pause.
- **The soak leaves out the backend** (run mirroring, approvals), real tool backends
  and real model latency.
- **Tool limits are concurrency only.** No requests-per-minute limit per tool.
- **A flaky test.** `tests/integration/fleet-status.test.ts` ("names a run that
  failed for good...") failed once in a full suite run and passed alone and in two
  more full runs; likely another suite's leases or jobs in the shared test stores.
- **Redis Cluster.** The fleet gate and budget scripts touch keys not passed to them
  (a workflow's keys are named inside the script), which a single Redis allows and a
  cluster does not.

## Phase 2 (routing)

- **No alert fingerprint.** The intake table already refuses a second queued row for
  one finding, and overlap merging covers the rest; a fingerprint of entities and
  detection in a time bucket would catch repeat alerts on different findings.
- **Routes and budgets are not editable from the console.** The SystemConfig rows
  are ready; the screens are not.
- **A workflow cannot choose another plugin yet.** The worker refuses a plugin its
  run kind does not run, until plugins load per run (the parked user-plugins work).
- **Memory-aware triage** (raise an item's rank when a finding lands on its entity)
  waits until a soak shows alerts waiting in the queue.

## Phase 3 (shared findings)

- **Cost on a busy entity.** The soak's worst case (every run on one entity) costs
  one more model call per run, about 40% more spend (`services/agent/soak/README.md`).
  If that matters on real load, gate the refusal on how many findings are unread or
  how far the run has gone.
- **Off by default, and not yet evaluated with a real model.** The plan's check --
  eval cases where two runs share an entity, comparing verdicts and cost with
  sharing on and off -- needs new labelled cases and a model budget.
- **The distil does not promote or retract provisional findings yet.** Every row
  stays provisional; reads skip rows older than `VIGIL_SHARED_FINDINGS_DAYS`.
  Phase 5, with event time beside record time and contradictions kept.
- **The hunt's frontier does not weight shared findings.** Re-ranking a run's own
  claims when news arrives is the model's, by its guidance; boosting the hunt's
  questions on an entity would need a directive no operator gave.
- **No Redis doorbell.** The check before concluding asks Postgres for the newest seq
  per entity (an indexed read). A Redis counter per entity would spare that read if
  it shows up at load.
- **Hot entities.** A read returns at most 20 findings and how many it left out; a
  distilled summary for entities on hundreds of runs is Phase 5.
- **Corroboration is recorded, not yet counted.** `derived_from` names the findings
  a finding was built on; nothing yet counts independent sources by it.
- **Only plugins that answer by tool are asked to read before concluding**
  (investigate today). A plugin that answers in prose is told findings exist but not
  stopped.
- **No partitioning or retention job** on `entity_findings`.

## Phase 4 (plugins and delegation)

- **No shipped plugin delegates yet, and no eval has run with delegation on.** The
  plan's check -- verdicts and cost with and without a hand-off, on a real model --
  needs a plugin that delegates (investigate handing off a root-cause trace is the
  likely first) and labelled cases.
- **hunt, adjudicate, compose and chat cannot be handed work.** Their hooks are built
  from what only the worker holds, and they need a playbook of their own shape.
- **A child parked on a question waits for the parent's agent to call the verb
  again.** If the agent does something else instead, the child stays parked and
  unlinked. The kernel could resume parked children itself when an answer lands.
- **A new plugin can be handed work without code, but cannot be started on its own
  without a run kind** (`plugins/kinds.ts`) -- the parked user-plugins work.
- **The console has no view of child runs** beyond the kernel's own projection, and
  shows a delegated question as a plain checkpoint on the parent.
- **A parked root-cause trace now reports "paused" to the console** with its reason,
  as every other kind does; before the single run path it reported nothing.
- **A hand-off does not count as looking** for a plugin's `min_results` ask when the
  agent stops early, though it does for the check on `conclude`.

## Parked

- **User-created plugins and skills**, loaded per run so they work without a
  rebuild, and how they are launched and authored.
- **How custom workflows work.** A DB-authored workflow always runs as compose.
