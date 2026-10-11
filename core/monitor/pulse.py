"""The Pulse read: the day's spine, the gauges, work by workflow, and what waits.

Every series is folded from rows Vigil already writes: ``findings`` (alerts in),
``cases`` (formed), ``case_closure_info`` (closed, by agents or a person),
``workflow_runs`` (running each hour), ``approval_actions`` (decisions) and
``intake_triggers`` (waiting to start, attached to open cases). Dropped alerts,
an "approved by you" close, stuck cases, holds and incidents are not recorded
yet and are sent as unmeasured.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from statistics import median
from typing import Optional

from core.monitor.common import (
    concurrency_cap,
    daily_spend_cap,
    day_start,
    intake_high_water,
    metric,
    rate_level,
    same_time_yesterday,
    usage_level,
)
from core.monitor.wall import wall_payload
from core.storage.models import ApprovalAction, Case, CaseClosureInfo, Finding, IntakeTrigger, WorkflowRun
from core.storage.unit_of_work import unit_of_work
from core.time import utcnow

HOURS = 24
# Age buckets for paused and waiting work (PulseWork): upper bounds in minutes.
AGE_BUCKETS = ((15, "under 15 min"), (60, "15 min to 1 h"), (240, "1 to 4 h"), (1440, "4 h to 1 day"), (None, "over 1 day"))

DAY_INFO = (
    "Per hour, the last 24 hours (UTC). Alerts in: findings created. Closed: cases "
    "closed, by agents or a person (case_closure_info). Running: workflow runs active "
    "at any point in the hour. The cap line is the fleet's concurrency cap."
)
WITHOUT_PERSON_INFO = "Of the cases closed today (UTC), the share closed by agents. Good at 95% or better, fair from 85%, poor below."
CLOSED_INFO = "Cases closed since midnight UTC, against yesterday by this time. No limit is set, so no level."
DECIDE_INFO = (
    "Median minutes from a decision being asked to a person answering it, over decisions "
    "answered today (approval_actions). No goal is configured, so no level."
)
SPEND_INFO = (
    "Cost of workflow runs started today (UTC), against the fleet's daily cap "
    "(VIGIL_FLEET_BUDGET_DAILY_USD). Good under 75%, fair to 90%, poor above."
)
WORK_INFO = (
    "How many are waiting and for how long. Needs you: decisions waiting on a person, "
    "aged from when they were asked. Paused: cases whose run is paused, aged from "
    "their last activity. The oldest opens its case."
)
QUEUE_INFO = (
    "Alerts queued at intake at the end of each hour, rebuilt from when each arrived "
    "and when it was launched, merged or expired. The line is the high-water mark past "
    "which the daemon stops launching."
)


def _hours(now: datetime) -> list[datetime]:
    top = now.replace(minute=0, second=0, microsecond=0)
    return [top - timedelta(hours=HOURS - 1 - index) for index in range(HOURS)]


def _bucket(stamps: list[datetime], hours: list[datetime]) -> list[int]:
    counts = [0] * len(hours)
    first = hours[0]
    for stamp in stamps:
        if stamp is None or stamp < first:
            continue
        index = int((stamp - first).total_seconds() // 3600)
        if 0 <= index < len(hours):
            counts[index] += 1
    return counts


def spine(now: Optional[datetime] = None) -> dict:
    """The day's shape, hour by hour: what arrived, what ran, what closed, what waited."""
    now = now or utcnow()
    hours = _hours(now)
    since = hours[0]
    with unit_of_work() as session:
        alerts = [row[0] for row in session.query(Finding.created_at).filter(Finding.created_at >= since).all()]
        formed = [row[0] for row in session.query(Case.created_at).filter(Case.created_at >= since).all()]
        closes = session.query(CaseClosureInfo.closed_at, CaseClosureInfo.closed_by_kind).filter(CaseClosureInfo.closed_at >= since).all()
        runs = (
            session.query(WorkflowRun.started_at, WorkflowRun.finished_at)
            .filter(WorkflowRun.deleted_at.is_(None))
            .filter((WorkflowRun.finished_at.is_(None)) | (WorkflowRun.finished_at >= since))
            .filter(WorkflowRun.started_at <= now)
            .all()
        )
        decided = (
            session.query(ApprovalAction.approved_at)
            .filter(ApprovalAction.approved_at >= since, ApprovalAction.approved_by.isnot(None))
            .all()
        )
        intake = (
            session.query(IntakeTrigger.created_at, IntakeTrigger.decided_at, IntakeTrigger.state)
            .filter((IntakeTrigger.decided_at.is_(None)) | (IntakeTrigger.decided_at >= since))
            .all()
        )
        merged = [row[0] for row in session.query(IntakeTrigger.decided_at).filter(IntakeTrigger.state == "merged", IntakeTrigger.decided_at >= since).all()]

    running = []
    queued = []
    for hour in hours:
        end = min(hour + timedelta(hours=1), now)
        running.append(sum(1 for started, finished in runs if started is not None and started < end and (finished is None or finished >= hour)))
        queued.append(sum(1 for created, decided_at, _ in intake if created is not None and created <= end and (decided_at is None or decided_at > end)))

    by_agents = _bucket([at for at, kind in closes if (kind or "agent") == "agent"], hours)
    by_person = _bucket([at for at, kind in closes if (kind or "agent") != "agent"], hours)
    peak = max(running) if running else 0
    peak_at = hours[running.index(peak)].isoformat() + "Z" if running and peak > 0 else None
    cap = concurrency_cap()
    return {
        "hours": [hour.isoformat() + "Z" for hour in hours],
        "alerts_in": _bucket(alerts, hours),
        "cases_formed": _bucket(formed, hours),
        "attached": _bucket(merged, hours),
        "closed_by_agents": by_agents,
        "closed_by_person": by_person,
        "running": running,
        "queued": queued,
        "decisions": _bucket([row[0] for row in decided], hours),
        "cap": cap,
        "high_water": intake_high_water(),
        "peak": {"running": peak, "at": peak_at, "free": (cap - peak) if cap else None},
        "dropped": metric(None, info="Alerts are not dropped by score yet, so none are counted.", unmeasured="There is no drop line yet."),
        "approved_by_person": metric(None, info="A close a person approved is not told apart from one agents made alone.", unmeasured="Approved closes are not recorded apart yet."),
        "info": DAY_INFO,
        "queue_info": QUEUE_INFO,
    }


def summary(now: Optional[datetime] = None) -> dict:
    now = now or utcnow()
    midnight = day_start(now)
    yesterday_from, yesterday_to = same_time_yesterday(now)
    with unit_of_work() as session:
        closes = session.query(CaseClosureInfo.closed_at, CaseClosureInfo.closed_by_kind).filter(CaseClosureInfo.closed_at >= yesterday_from).all()
        answered = (
            session.query(ApprovalAction.created_at, ApprovalAction.approved_at)
            .filter(ApprovalAction.approved_at >= midnight, ApprovalAction.approved_by.isnot(None))
            .all()
        )
        spent = [row[0] for row in session.query(WorkflowRun.total_cost_usd).filter(WorkflowRun.started_at >= midnight).all()]

    today = [row for row in closes if row.closed_at >= midnight]
    yesterday = [row for row in closes if yesterday_from <= row.closed_at < yesterday_to]
    alone = sum(1 for row in today if (row.closed_by_kind or "agent") == "agent")
    share = alone / len(today) if today else None
    waits = [(approved - asked).total_seconds() / 60 for asked, approved in answered if asked and approved and approved >= asked]
    spend = round(sum(float(cost) for cost in spent if cost is not None), 4)
    cap = daily_spend_cap()

    wall = wall_payload(now)
    gauges = [
        metric(round(share, 4) if share is not None else None, info=WITHOUT_PERSON_INFO, level=rate_level(share), key="without_person", label="Handled without a person", sample=len(today)),
        metric(len(today), info=CLOSED_INFO, key="closed_today", label="Cases closed today", yesterday=len(yesterday)),
        metric(round(median(waits), 1) if waits else None, info=DECIDE_INFO, key="time_to_decide", label="Median time to decide", sample=len(waits)),
        metric(spend, info=SPEND_INFO, limit=cap, level=usage_level(spend, cap), key="spend_today", label="AI spend today"),
    ]
    return {
        "now": now.isoformat() + "Z",
        "gauges": gauges,
        "attention": _attention(wall, spend, cap),
        "day": spine(now),
        "adjustments": _adjustments(),
    }


def _attention(wall: dict, spend: float, cap: Optional[float]) -> list[dict]:
    """What a person should look at now, from conditions the read can see. Never invented."""
    items = []
    asking = wall["next_action"]
    if asking:
        items.append(
            {
                "level": "poor",
                "title": f"{asking['count']} decision{'s' if asking['count'] != 1 else ''} waiting on a person",
                "why": asking.get("title") or "A case stopped to ask before acting.",
                "action": "Open Needs you",
                "door": "needs_you",
            }
        )
    slots = wall["slots"]
    if slots["level"] in ("fair", "poor"):
        items.append(
            {
                "level": slots["level"],
                "title": "The fleet is near its concurrency cap",
                "why": f"{slots['value']} of {slots['limit']} slots in use. New cases wait for a free slot.",
                "action": "See throughput",
                "door": "throughput",
            }
        )
    level = usage_level(spend, cap)
    if level in ("fair", "poor"):
        items.append(
            {
                "level": level,
                "title": "AI spend is near today's cap",
                "why": f"${spend:,.2f} of ${cap:,.2f}. Past the cap, new automated work waits.",
                "action": "See throughput",
                "door": "throughput",
            }
        )
    load = wall["load"]
    if load["level"] in ("fair", "poor"):
        items.append(
            {
                "level": load["level"],
                "title": "Alerts are piling up at intake",
                "why": f"{load['value']} queued against the high-water mark of {load['limit']}.",
                "action": "See what waits",
                "door": "work",
            }
        )
    return items


def _adjustments() -> list[dict]:
    """The fleet-wide settings Pulse would turn (PL3). Read-only until adjustments are typed events."""
    cap = concurrency_cap()
    spend = daily_spend_cap()
    high = intake_high_water()
    note = "Read here; change it in Settings. Changing it from Pulse is not built yet."
    return [
        {"key": "concurrency", "label": "Cases running at once · fleet", "current": str(cap) if cap else "No cap", "note": note},
        {"key": "daily_spend", "label": "AI spend per day · fleet", "current": f"${spend:,.2f}" if spend else "No cap", "note": note},
        {"key": "high_water", "label": "Stop launching above, queued alerts", "current": str(high) if high else "No limit", "note": note},
        {"key": "drop_line", "label": "Drop alerts scoring under", "current": None, "note": "There is no drop line yet.", "unmeasured_text": "Not measured yet"},
    ]


def throughput(now: Optional[datetime] = None) -> dict:
    now = now or utcnow()
    wall = wall_payload(now)
    kinds = [{key: value for key, value in band.items() if key != "cells"} for band in wall["bands"]]
    return {"now": now.isoformat() + "Z", "day": spine(now), "kinds": kinds, "info": wall["info"]["kind"]}


def _ages(minutes: list[float]) -> list[dict]:
    counts = [0] * len(AGE_BUCKETS)
    for value in minutes:
        for index, (upper, _) in enumerate(AGE_BUCKETS):
            if upper is None or value < upper:
                counts[index] += 1
                break
    return [{"label": label, "count": count} for (_, label), count in zip(AGE_BUCKETS, counts)]


def work(now: Optional[datetime] = None) -> dict:
    now = now or utcnow()
    wall = wall_payload(now)
    cells = [cell for band in wall["bands"] for cell in band["cells"]]

    def row(key: str, label: str, what: str, picked: list[tuple[float, str]]) -> dict:
        oldest = max(picked, default=None)
        return {
            "key": key,
            "label": label,
            "what": what,
            "count": metric(len(picked), info=WORK_INFO),
            "ages": _ages([age for age, _ in picked]),
            "oldest": {"minutes": round(oldest[0], 1), "case_id": oldest[1]} if oldest else None,
        }

    asking = []
    for cell in cells:
        if cell["state"] == "needs_you" and cell["decision"] and cell["decision"].get("since"):
            asked = datetime.fromisoformat(cell["decision"]["since"].rstrip("Z"))
            asking.append(((now - asked).total_seconds() / 60, cell["case_id"]))
    day = spine(now)
    paused = []
    with unit_of_work() as session:
        from core.storage.case_repository import CaseRepository  # noqa: PLC0415 - same read as the wall

        rows, _ = CaseRepository(session).queue(limit=2_000, now=now, state="paused")
        for item in rows:
            seen = item.last_activity or (now - timedelta(seconds=item.age_seconds or 0))
            paused.append(((now - seen).total_seconds() / 60, item.case_id))

    return {
        "now": now.isoformat() + "Z",
        "rows": [
            row("needs_you", "Needs you", "A decision waits on a person", asking),
            row("paused", "Paused", "Its run waits; it resumes on its own", paused),
            {"key": "stuck", "label": "Stuck", "what": "No explanation moved in 6 or more steps", "count": metric(None, info=WORK_INFO, unmeasured="Stuck detection is not recorded yet."), "ages": None, "oldest": None},
            {"key": "on_hold", "label": "On hold", "what": "A person put them on hold", "count": metric(None, info=WORK_INFO, unmeasured="Holds are not recorded yet."), "ages": None, "oldest": None},
        ],
        "queue": {key: day[key] for key in ("hours", "queued", "high_water", "queue_info")},
        "info": WORK_INFO,
    }
