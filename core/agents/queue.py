# Enqueue agent runs onto the queue the TypeScript agent layer consumes. The
# backend enqueues plain JSON and never writes agent_events.

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional
from weakref import WeakKeyDictionary

from bullmq import Queue

from core.config import get_settings
from core.telemetry import get_meter

logger = logging.getLogger(__name__)

# No colon: the Node library refuses a queue name containing one, while the
# Python library accepts it and writes the keys anyway. Keys are bull:agent-runs:*.
RUN_QUEUE = "agent-runs"
# Work a person is waiting on has a queue of its own, drained by worker slots kept
# for it, so a backlog of automated runs never stands between a person and an
# answer. services/agent/contracts/job.ts names the same two.
RUN_QUEUE_HUMAN = "agent-runs-human"
LANES = ("human", "automated")

# BullMQ priority for an automated run, by severity band: lower runs first. A resume
# carries none, and BullMQ runs unprioritised jobs ahead of prioritised ones, so
# work already under way finishes before new work starts.
SEVERITY_PRIORITY = {"critical": 1, "high": 2, "medium": 3, "low": 4, "unknown": 5}

JOB_SCHEMA_VERSION = 1

DEFAULT_REDIS_URL = "redis://localhost:6379/0"

RUN_KINDS = ("hunt", "root_cause", "adjudicate", "investigate", "compose", "chat")

# BullMQ defaults to one attempt, so a job that throws is permanently failed and
# nothing rescues it: the watchdog sweeps lapsed lease rows, and a job that died on
# its way into leases.claim never wrote one. On a dev box a transient Postgres or
# Redis failure is rare; under Kubernetes -- rolling upgrades, evictions, failover --
# it is routine, and the run would be lost with nothing reaching the console.
#
# Retrying is safe rather than merely tolerable: advance() checks terminal first and
# leases.claim is a conditional UPDATE, so a second attempt takes exactly the path a
# watchdog resume takes -- reachable because a failed attempt hands its lease back
# (services/agent/worker.ts::forget).
#
# The consumer reads these off the job, so the Node worker honours what is set here.
RUN_ATTEMPTS = 3
RUN_BACKOFF = {"type": "exponential", "delay": 5000}


def _redis_url() -> str:
    return get_settings().redis_url or DEFAULT_REDIS_URL


# The reason="start" arm of the RunJob union in the agent layer's job contract.
def build_start_job(
    run_id: str,
    run_kind: str,
    request: Dict[str, Any],
    enqueued_by: str,
    tenant_id: Optional[str] = None,
    lane: str = "automated",
) -> Dict[str, Any]:
    return {
        "schema_version": JOB_SCHEMA_VERSION,
        "run_id": run_id,
        "run_kind": run_kind,
        "tenant_id": tenant_id,
        "enqueued_at": datetime.now(timezone.utc).isoformat(),
        "enqueued_by": enqueued_by,
        "reason": "start",
        "request": request,
        "lane": _lane(lane),
    }


# A resume carries no request: the ledger holds the spec, and what unblocks the
# run is the decision the agent layer reads back, not anything said here.
def build_resume_job(
    run_id: str,
    run_kind: str,
    enqueued_by: str,
    tenant_id: Optional[str] = None,
    lane: str = "automated",
) -> Dict[str, Any]:
    return {
        "schema_version": JOB_SCHEMA_VERSION,
        "run_id": run_id,
        "run_kind": run_kind,
        "tenant_id": tenant_id,
        "enqueued_at": datetime.now(timezone.utc).isoformat(),
        "enqueued_by": enqueued_by,
        "reason": "resume",
        "lane": _lane(lane),
    }


def _lane(lane: str) -> str:
    if lane not in LANES:
        raise ValueError(f"lane must be one of {', '.join(LANES)}, not {lane!r}")
    return lane


def priority_for(severity: Optional[str]) -> int:
    """BullMQ priority for an automated run of this severity band."""
    return SEVERITY_PRIORITY.get((severity or "unknown").strip().lower(), SEVERITY_PRIORITY["unknown"])


_queues: "WeakKeyDictionary[asyncio.AbstractEventLoop, Dict[str, Queue]]" = WeakKeyDictionary()

_runs_started: Any = None


# Lazy, not at import: get_meter before init_telemetry hands back a permanent no-op.
def _runs_started_counter() -> Any:
    global _runs_started
    if _runs_started is None:
        _runs_started = get_meter("vigil.agents.queue").create_counter(
            "vigil.runs.started",
            description="Agent runs enqueued to start, by run_kind",
            unit="1",
        )
    return _runs_started


# One per event loop, not per call: a Queue per enqueue costs a Redis connection.
# Keyed by loop because its connection is bound to the one that made it.
def _run_queue(lane: str = "automated") -> Queue:
    loop = asyncio.get_running_loop()
    held = _queues.setdefault(loop, {})
    name = RUN_QUEUE_HUMAN if lane == "human" else RUN_QUEUE
    queue = held.get(name)
    if queue is None:
        queue = Queue(name, {"connection": _redis_url()})
        held[name] = queue
    return queue


# Called on shutdown, so the connection does not outlive the loop that made it.
async def close_run_queue() -> None:
    held = _queues.pop(asyncio.get_running_loop(), None) or {}
    for queue in held.values():
        await queue.close()


async def enqueue_run(
    job: Dict[str, Any], job_id: Optional[str] = None, priority: Optional[int] = None
) -> str:
    lane = job.get("lane") or "automated"
    queue = _run_queue(lane)
    options: Dict[str, Any] = {
        # jobId is the run id for a start, so a double POST dedupes in BullMQ. A
        # resume takes a fresh id: any derived one repeats, and the queue drops it.
        "jobId": job_id or _default_job_id(job),
        "attempts": RUN_ATTEMPTS,
        "backoff": RUN_BACKOFF,
    }
    # Only the automated queue is ordered: a person's runs are taken as they come.
    if priority is not None and lane == "automated":
        options["priority"] = priority
    try:
        enqueued = await queue.add("run", job, options)
        logger.info("enqueued agent run %s (%s)", job["run_id"], job["run_kind"])
        # A resume re-enters a run that was already counted when it started.
        if job.get("reason") == "start":
            _runs_started_counter().add(1, {"run_kind": job["run_kind"]})
        return str(enqueued.id)
    except Exception:
        # A queue that failed is not reused: the next call builds a fresh one
        # rather than inheriting a connection that may already be gone.
        await close_run_queue()
        raise


async def automated_backlog() -> Optional[int]:
    """Automated runs waiting to start, or None when the queue cannot be read."""
    try:
        counts = await _run_queue("automated").getJobCounts("waiting", "prioritized", "delayed")
        return sum(int(value) for value in counts.values())
    except Exception as exc:  # noqa: BLE001 -- unknown is answered by the caller
        logger.warning("could not read the run queue's depth: %s", exc)
        await close_run_queue()
        return None


def _default_job_id(job: Dict[str, Any]) -> str:
    if job.get("reason") == "start":
        return str(job["run_id"])
    return f"{job['run_id']}:{uuid.uuid4()}"


def new_run_id() -> str:
    return str(uuid.uuid4())
