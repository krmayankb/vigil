# Running the agent fleet

What bounds the agent layer when it runs many investigations at once, and the
settings for each bound. Every setting below is read from the environment of the
process named; unset, each keeps the behaviour it had before the setting existed.

## Lanes

Work a person is waiting on (a run started from the console, an approval just
answered, a human ask from the triage queue) goes on the `agent-runs-human` queue.
Everything else (detections, schedules, root-cause handoffs, the shadow
adjudication) goes on `agent-runs`, ordered by severity, critical first. A run
keeps its lane for life: the watchdog resumes it on the queue it started on.

| Setting | Process | Default | Meaning |
|---|---|---|---|
| `VIGIL_RUN_CONCURRENCY` | worker | 4 | Automated runs one worker drives at once |
| `VIGIL_HUMAN_RUN_CONCURRENCY` | worker | a quarter of the above, at least 1 | Slots each worker keeps for the human lane |

## Model and tool limits

Each worker has its own limiter; the fleet gate is one allowance shared by every
worker through Redis. A slot held by a worker that died comes back when it lapses.
If Redis cannot be reached the gate opens and logs it, and each worker's own limit
still holds.

| Setting | Process | Default | Meaning |
|---|---|---|---|
| `VIGIL_LLM_CONCURRENCY`, `_RPM`, `_TPM` | worker | 4, 500, 400k | One process's model calls in flight, requests and tokens a minute |
| `VIGIL_LLM_HUMAN_CONCURRENCY` | worker | a quarter of `VIGIL_LLM_CONCURRENCY` | Model calls in flight for the human lane, beside the above |
| `VIGIL_LLM_FLEET_CONCURRENCY`, `_RPM`, `_TPM` | worker | none | The same, for the whole fleet |
| `VIGIL_LLM_FLEET_HUMAN_RESERVE` | worker | 0 | Fleet model slots automated runs may not take |
| `VIGIL_TOOL_FLEET_CONCURRENCY` | worker | none | Calls in flight per tool backend, fleet-wide; a tool's `max_inflight` in the config overrides it |

A model provider that still will not answer after the limiter's retries (429, 5xx,
a dead connection) does not fail the run: the worker hands it back, and the
watchdog resumes it after `VIGIL_PROVIDER_RETRY_MS` (default 60000), from its
ledger, re-running nothing it already did.

## Budget

| Setting | Process | Default | Meaning |
|---|---|---|---|
| `VIGIL_FLEET_BUDGET_HOURLY_USD`, `_DAILY_USD` | worker | none | What the whole fleet may spend per hour and per day (UTC) |
| `VIGIL_FLEET_EXPECTED_RUN_USD` | worker | 0.05 | What a run is expected to cost before any of its kind has finished |

A workflow can have caps of its own: one SystemConfig row, `workflows.budgets`,
holds them per workflow (`{"full-investigation": {"hourly_usd": 20}}`), and a run
of that workflow is held against both the fleet's caps and its workflow's. Every
workflow run carries its workflow as its budget scope, so what a run is expected to
cost is learned per workflow. `VIGIL_FLEET_BUDGET_SCOPES=on` holds workflow caps
even with no fleet cap set.

An automated start reserves its expected cost and is admitted only while spend
plus every outstanding reservation fits under the caps; otherwise it waits in the
queue, delayed, for room. A run's calls draw its reservation down, and a run that
ends lets go of what it did not use and moves its kind's expectation toward what it
cost. A person's run and a resume are never held, only counted. Running out of
budget never closes an alert: work waits, or a run that reaches its own budget
parks or ends marked as cut short. Each run's own budget (`max_cost_usd`) and the
gateway's virtual key still apply.

## Findings shared between runs

With `VIGIL_SHARED_FINDINGS=on` (default off), every run publishes its record to the
`entity_findings` table (`infra/database/init/42_entity_findings.sql`) the moment it
writes it: each claim, each link of a result to a claim (with an excerpt of the
result, marked as text an attacker may have written), and its conclusion. They are
filed under the entities the run is about -- the keys its memory read reported --
marked provisional.

A run on the same entities holds a `get_entity_updates` tool that returns what other
runs published since it last asked, and is told in its prompt that another run's
finding is a lead to confirm with its own query, never proof. When a run concludes
while something newer sits unread, the kernel refuses that conclude once, with the
newest five findings (and how many more there are) in the refusal itself, so the
run weighs them and concludes again without a separate read; a busy entity cannot
keep it from finishing. The read and the refusal are on the run's own ledger, so a
replay serves them as they were. Another run's finding never counts as the
cited ground of a guarded answer, and a finding built on another run's names it in
`derived_from`. Findings older than `VIGIL_SHARED_FINDINGS_DAYS` (default 7) are not
read.

Cost, measured on the soak's worst case (every run on the same host and IP, so
every run finds unread findings): one more model call per run (3.3 to 4.3) and
about 40% more spend. A run on entities nobody else is working pays nothing.

## Handing work to another plugin

A plugin may list work it hands off, in its plugin.yaml under `delegates`: a verb,
the plugin that does it, and the share of the run's remaining budget it may spend
(default a quarter). Each verb is a tool. Calling it runs that plugin as a child run
on its own ledger, linked to the parent both ways, and answers with the child's
conclusion. The child's model calls are billed on the parent's ledger, so the
parent's run budget, its cost on the console and the fleet budget all count them. A
question the child raises parks the parent on the same question; once answered, the
agent calls the verb again and the child goes on. Several hand-offs in one turn run
at once. One level only. No shipped plugin declares delegates yet; the format and
rules are in `services/agent/plugins/README.md`.

## The daemon

| Setting | Default | Meaning |
|---|---|---|
| `ORCHESTRATOR_MAX_AGENTS` | 3 | Investigations running at once; 0 is no cap of the daemon's own |
| `ORCHESTRATOR_INTAKE_HIGH_WATER` | 500 | Automated runs already queued past which the daemon stops launching more |
| `VIGIL_DAEMON_LEADER` | true | One daemon leads (a Postgres advisory lock); a second replica waits on standby and takes over if the leader's connection drops |

## Seeing it

`GET /fleet` on the agent's HTTP surface (bearer token, as its other routes)
answers with each lane's queue depth, the last 20 runs that failed for good and
why, runs by lease state (running, waiting, due, and stalled: a claim that lapsed
five minutes ago with no watchdog picking it up), the fleet budget's spend,
reservations and caps, and model calls in flight against the fleet cap. Each worker
also logs an error once a minute when more runs have failed for good, and a warning
when runs have stalled.

`GET /fleet/backlog` answers one number: runs waiting to start on both lanes,
prioritised ones included and held ones not. With `agentWorker.autoscaling.keda`
enabled, the chart scales the workers on it through KEDA's `metrics-api` trigger,
using the same bearer token, and the agent-serve network policy admits KEDA's
namespace (`networkPolicies.agentServe.kedaNamespaceSelector`). A Redis list count
would miss prioritised runs, which BullMQ keeps in a sorted set.


`GET /metrics` on the same surface (same bearer token) answers in Prometheus'
text format: `vigil_agent_queue_jobs{lane,state}`, `vigil_agent_runs{state,lane}`
(running, waiting, due, stalled), `vigil_agent_oldest_waiting_seconds{lane}` (on
the human lane, how long the oldest person's ask has waited),
`vigil_fleet_spend_usd{window}` against `vigil_fleet_budget_cap_usd{window}`,
`vigil_fleet_reserved_usd`, `vigil_fleet_reserved_runs`,
`vigil_fleet_model_calls_in_flight` and `vigil_fleet_part_up{part}`, which is 0
for a part that could not be read rather than reporting zeros.
## Deploying

Every setting above is in the chart's `config` (`infra/helm/vigil/values.yaml`) and
in `infra/docker/docker-compose.yml`, at values that change nothing. Set the two
budget caps on the workers and the daemon alike: the daemon reads them to stand its
own hourly cap down.

## Database

`infra/database/init/41_agent_run_leases_lane.sql` adds the lane to the lease row.
Apply it with the other agent DDL.

## Measuring

`services/agent/soak/` runs many runs through real workers, Postgres and Redis
against a stub model and estate; its README has the method and the findings.
