"""The Fleet Wall read: every open case as a cell, grouped by workflow.

One cell per open case, from the same queue the Cases page reads
(``CaseRepository.queue`` through ``queue_item``), so the wall and the queue
cannot disagree about a case's state. The bands and the strip are folded from
``workflow_runs``, ``investigations``, ``case_closure_info`` and
``intake_triggers``. On hold, stuck, incidents and a per-workflow concurrency
cap are not recorded by Vigil yet; they are sent as unmeasured, never guessed.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta
from statistics import mean
from typing import Any, Optional

from sqlalchemy import func

from core.cases.combined_state import QueueItem, queue_item
from core.monitor.common import (
    concurrency_cap,
    day_start,
    intake_high_water,
    metric,
    rate_level,
    same_time_yesterday,
    usage_level,
)
from core.response.approval_service import needs_you
from core.storage.case_repository import CaseRepository
from core.storage.models import CaseClosureInfo, IntakeTrigger, WorkflowRun
from core.storage.unit_of_work import unit_of_work
from core.time import utcnow
from core.workflows.workflows_service import WorkflowsService

# Open cases fetched for the wall. Past this the wall says how many it left out.
WALL_LIMIT = 2_000
# How long a closed case stays in the just-closed strip (FWR6: configurable, short).
JUST_CLOSED_MINUTES = 15
# Thick outline from this many alerts (FW2).
COMBINED_HEAVY = 5
UNASSIGNED = "unassigned"

STATES = ("needs_you", "running", "paused", "waiting")
_RUNNING = {"executing", "assigned"}
_ASKING = {"waiting_approval", "review_submitted"}

CELL_INFO = (
    "One square per open case, from the case queue. Colour is its state: needs you "
    "when a decision waits on a person, running when a run is working it, paused "
    "when its run waits, waiting when no run has picked it up. A thick outline is 5 "
    "or more alerts combined into the case; the fill is how much of its budget it "
    "has spent."
)
KIND_INFO = (
    "Per workflow. Without a person: of the cases closed today whose newest run "
    "ran this workflow, the share closed by agents. Good at 95% or better, fair "
    "from 85%. Today: runs of this workflow started since midnight UTC. Cost per "
    "case: mean cost of this workflow's runs finished today."
)
SLOTS_INFO = (
    "Cases with a run working them, against the fleet's concurrency cap "
    "(orchestrator.settings max_concurrent_agents). Good under 75%, fair to 90%, "
    "poor above. Near their limit: open cases that have spent 75% or more of "
    "their budget."
)
CLOSED_INFO = (
    "Cases closed since midnight UTC (case_closure_info), against yesterday by "
    "this time. Without a person: the share closed by agents."
)
LOAD_INFO = (
    "Alerts queued at intake, waiting to start, against the high-water mark past "
    "which the daemon stops launching (ORCHESTRATOR_INTAKE_HIGH_WATER)."
)


def display_name(name: str) -> str:
    """A workflow's name as the console shows it: sentence case, words not ids."""
    words = name.replace("-", " ").replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else name


def cell_state(item: QueueItem) -> str:
    """The wall's state for one case, from the queue's combined state."""
    if item.needs_you or item.combined_state in _ASKING:
        return "needs_you"
    if item.combined_state in _RUNNING:
        return "running"
    if item.combined_state == "paused":
        return "paused"
    return "waiting"


def _limit_used(item: QueueItem) -> Optional[float]:
    if item.cost_usd is None or not item.max_cost_usd:
        return None
    return round(item.cost_usd / item.max_cost_usd, 4)


def _cell(item: QueueItem, workflow: str, asks: dict[str, dict]) -> dict:
    state = cell_state(item)
    ask = asks.get(item.case_id)
    if state == "needs_you":
        reason = (ask or {}).get("title") or "A decision waits on a person"
    elif state == "running":
        reason = "A run is working this case"
    elif state == "paused":
        reason = "Its run is paused"
    else:
        reason = "Waiting for a run to pick it up"
    used = _limit_used(item)
    return {
        "case_id": item.case_id,
        "title": item.title,
        "description": item.description,
        "workflow_id": workflow,
        "severity": item.priority,
        "state": state,
        "reason": reason,
        "alerts": item.findings_count,
        "combined": item.findings_count >= 2,
        "heavy": item.findings_count >= COMBINED_HEAVY,
        "limit_used": used,
        "limit_level": usage_level(item.cost_usd, item.max_cost_usd),
        "near_limit": used is not None and used >= 0.75,
        "steps": item.iteration_count,
        "owner": item.assignee,
        "sla_seconds_left": item.sla_seconds_left,
        "decision": (
            {"title": ask.get("title"), "reason": ask.get("reason"), "since": _iso(ask.get("created_at"))}
            if ask
            else None
        ),
        "incident": None,
    }


def _iso(value: Any) -> Optional[str]:
    if isinstance(value, datetime):
        return value.isoformat() + "Z"
    return value if isinstance(value, str) else None


def _asks() -> tuple[dict[str, dict], list[dict]]:
    items = [item for item in needs_you()["items"] if isinstance(item, dict)]
    by_case: dict[str, dict] = {}
    for item in items:
        case_id = item.get("case_id")
        if isinstance(case_id, str) and case_id and case_id not in by_case:
            by_case[case_id] = item
    return by_case, items


def wall_payload(now: Optional[datetime] = None, just_closed_minutes: int = JUST_CLOSED_MINUTES) -> dict:
    now = now or utcnow()
    asks, ask_items = _asks()
    workflows = {w["id"]: w for w in WorkflowsService().list_workflows()}
    midnight = day_start(now)
    yesterday_from, yesterday_to = same_time_yesterday(now)

    with unit_of_work() as session:
        rows, total = CaseRepository(session).queue(limit=WALL_LIMIT, now=now, needs_you_ids=set(asks))
        items = [queue_item(row, now, needs_you=row.case_id in asks) for row in rows]

        closures = (
            session.query(CaseClosureInfo.case_id, CaseClosureInfo.closed_at, CaseClosureInfo.closed_by_kind)
            .filter(CaseClosureInfo.closed_at >= yesterday_from)
            .all()
        )
        runs_today = (
            session.query(WorkflowRun.workflow_id, WorkflowRun.status, WorkflowRun.total_cost_usd, WorkflowRun.finished_at)
            .filter(WorkflowRun.started_at >= midnight, WorkflowRun.deleted_at.is_(None))
            .all()
        )
        queued = session.query(func.count(IntakeTrigger.id)).filter(IntakeTrigger.state == "queued").scalar() or 0
        queued_by_workflow = dict(
            session.query(IntakeTrigger.triage_decision["workflow_id"].astext, func.count(IntakeTrigger.id))
            .filter(IntakeTrigger.state == "queued")
            .group_by(IntakeTrigger.triage_decision["workflow_id"].astext)
            .all()
        )
        closed_ids = [row.case_id for row in closures if row.closed_at and row.closed_at >= midnight]
        closed_workflow = _workflow_of_cases(session, closed_ids)

    cells_by_workflow: dict[str, list[dict]] = defaultdict(list)
    for item in items:
        workflow = item.workflow_id or UNASSIGNED
        cells_by_workflow[workflow].append(_cell(item, workflow, asks))

    # Needs you first, then running, paused, waiting: the cases that need a person come first.
    order = {state: index for index, state in enumerate(STATES)}
    for cells in cells_by_workflow.values():
        cells.sort(key=lambda cell: (order[cell["state"]], -(cell["alerts"] or 0)))

    closed_today = [row for row in closures if row.closed_at and row.closed_at >= midnight]
    closed_yesterday = [row for row in closures if row.closed_at and yesterday_from <= row.closed_at < yesterday_to]
    by_agent_today = sum(1 for row in closed_today if (row.closed_by_kind or "agent") == "agent")

    runs_by_workflow: dict[str, list] = defaultdict(list)
    for run in runs_today:
        runs_by_workflow[run.workflow_id].append(run)
    closes_by_workflow: dict[str, list] = defaultdict(list)
    for row in closed_today:
        closes_by_workflow[closed_workflow.get(row.case_id, UNASSIGNED)].append(row)

    bands = []
    for workflow_id in sorted(cells_by_workflow, key=lambda w: (w == UNASSIGNED, -len(cells_by_workflow[w]), w)):
        cells = cells_by_workflow[workflow_id]
        definition = workflows.get(workflow_id, {})
        runs = runs_by_workflow.get(workflow_id, [])
        finished = [run for run in runs if run.finished_at is not None and run.total_cost_usd is not None]
        closes = closes_by_workflow.get(workflow_id, [])
        alone = sum(1 for row in closes if (row.closed_by_kind or "agent") == "agent")
        share = alone / len(closes) if closes else None
        steps = [cell["steps"] for cell in cells if cell["steps"]]
        bands.append(
            {
                "workflow_id": workflow_id,
                "name": "Not yet assigned to a workflow" if workflow_id == UNASSIGNED else display_name(definition.get("name") or workflow_id),
                "open": len(cells),
                "running": metric(
                    sum(1 for cell in cells if cell["state"] == "running"),
                    info="Cases of this workflow with a run working them.",
                    unmeasured=None,
                    cap_text="No per-workflow cap is recorded yet",
                ),
                "today": len(runs),
                "cost_per_case": round(mean(float(run.total_cost_usd) for run in finished), 4) if finished else None,
                "mean_steps": round(mean(steps), 1) if steps else None,
                "waiting": sum(1 for cell in cells if cell["state"] == "waiting") + int(queued_by_workflow.get(workflow_id, 0) or 0),
                "without_person": metric(round(share, 4) if share is not None else None, info=KIND_INFO, level=rate_level(share), sample=len(closes)),
                "cells": cells,
            }
        )

    states = {state: sum(1 for band in bands for cell in band["cells"] if cell["state"] == state) for state in STATES}
    cap = concurrency_cap()
    near = sum(1 for band in bands for cell in band["cells"] if cell["near_limit"])
    high_water = intake_high_water()
    just_closed_since = now - timedelta(minutes=just_closed_minutes)
    first = next((item for item in ask_items if item.get("case_id")), ask_items[0] if ask_items else None)

    return {
        "now": now.isoformat() + "Z",
        "next_action": (
            {"count": len(ask_items), "case_id": first.get("case_id"), "title": first.get("title"), "reason": first.get("reason")}
            if first
            else None
        ),
        "slots": metric(states["running"], info=SLOTS_INFO, limit=cap, level=usage_level(states["running"], cap), near_limit=near),
        "closed_today": metric(
            len(closed_today),
            info=CLOSED_INFO,
            yesterday=len(closed_yesterday),
            without_person=round(by_agent_today / len(closed_today), 4) if closed_today else None,
        ),
        "incidents_today": metric(None, info="Incident declarations are not recorded by Vigil yet.", unmeasured="Incidents are not recorded."),
        "load": metric(int(queued), info=LOAD_INFO, limit=high_water, level=usage_level(float(queued), high_water)),
        "facets": [
            {"key": "all", "label": "All open", "count": sum(states.values())},
            {"key": "needs_you", "label": "Needs you", "count": states["needs_you"]},
            {"key": "near_limit", "label": "Near its limit", "count": near},
            {"key": "running", "label": "Running", "count": states["running"]},
            {"key": "paused", "label": "Paused", "count": states["paused"]},
            {"key": "waiting", "label": "Waiting", "count": states["waiting"]},
            {"key": "combined", "label": "Combined", "count": sum(1 for band in bands for cell in band["cells"] if cell["combined"])},
            {"key": "single", "label": "Single alert", "count": sum(1 for band in bands for cell in band["cells"] if not cell["combined"])},
            {"key": "on_hold", "label": "On hold", "count": None, "unmeasured_reason": "Holds are not recorded yet."},
            {"key": "stuck", "label": "Stuck", "count": None, "unmeasured_reason": "Stuck detection is not recorded yet."},
            {"key": "incident", "label": "Incident declared", "count": None, "unmeasured_reason": "Incidents are not recorded yet."},
        ],
        "bands": bands,
        "omitted": max(0, total - len(items)),
        "just_closed": [
            {
                "case_id": row.case_id,
                "closed_at": row.closed_at.isoformat() + "Z",
                "by": "agents" if (row.closed_by_kind or "agent") == "agent" else "a person",
            }
            for row in sorted(closed_today, key=lambda r: r.closed_at, reverse=True)
            if row.closed_at >= just_closed_since
        ],
        "just_closed_minutes": just_closed_minutes,
        "info": {"cell": CELL_INFO, "kind": KIND_INFO},
    }


def _workflow_of_cases(session, case_ids: list[str]) -> dict[str, str]:
    """The workflow of each case's newest run, by trigger_context.case_id."""
    if not case_ids:
        return {}
    rows = (
        session.query(WorkflowRun.trigger_context["case_id"].astext, WorkflowRun.workflow_id, WorkflowRun.started_at)
        .filter(WorkflowRun.trigger_context["case_id"].astext.in_(case_ids))
        .all()
    )
    newest: dict[str, tuple[datetime, str]] = {}
    for case_id, workflow_id, started_at in rows:
        held = newest.get(case_id)
        if held is None or (started_at or datetime.min) > held[0]:
            newest[case_id] = (started_at or datetime.min, workflow_id)
    return {case_id: workflow for case_id, (_, workflow) in newest.items()}
