"""Fleet Wall and Pulse reads: cells, bands, the day's spine, and what waits."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from core.monitor.common import rate_level, usage_level
from core.monitor.pulse import spine, summary, throughput, work
from core.monitor.wall import wall_payload
from core.storage.models import (
    ApprovalAction,
    Case,
    CaseClosureInfo,
    Finding,
    WorkflowRun,
    case_findings,
)
from core.storage.unit_of_work import unit_of_work

pytestmark = [pytest.mark.unit, pytest.mark.external_service, pytest.mark.database]

NOW = datetime(2098, 3, 3, 14, 30, 0)
P = "mw-"


@pytest.fixture(autouse=True)
def _clean(throwaway_database):
    def purge():
        with unit_of_work() as session:
            session.query(ApprovalAction).filter(ApprovalAction.action_id.like(f"{P}%")).delete(synchronize_session=False)
            session.query(WorkflowRun).filter(WorkflowRun.run_id.like(f"{P}%")).delete(synchronize_session=False)
            session.query(CaseClosureInfo).filter(CaseClosureInfo.case_id.like(f"{P}%")).delete(synchronize_session=False)
            session.execute(case_findings.delete().where(case_findings.c.finding_id.like(f"{P}%")))
            session.query(Case).filter(Case.case_id.like(f"{P}%")).delete(synchronize_session=False)
            session.query(Finding).filter(Finding.finding_id.like(f"{P}%")).delete(synchronize_session=False)

    purge()
    yield
    purge()


def _case(case_id: str, status: str = "open", created_at: datetime = NOW - timedelta(hours=2)) -> Case:
    return Case(case_id=case_id, title=f"title {case_id}", status=status, created_at=created_at, updated_at=created_at)


def _run(run_id: str, case_id: str, status: str, started_at: datetime, finished_at=None, cost=None) -> WorkflowRun:
    return WorkflowRun(
        run_id=run_id,
        workflow_id="full-investigation",
        workflow_name="Full Investigation",
        status=status,
        trigger_context={"case_id": case_id},
        started_at=started_at,
        finished_at=finished_at,
        total_cost_usd=cost,
    )


def _finding(finding_id: str, at: datetime) -> Finding:
    return Finding(finding_id=finding_id, data_source="mw-src", created_at=at, status="new", severity="high")


def _seed():
    with unit_of_work() as session:
        session.add_all(
            [
                _case(f"{P}run"),
                _case(f"{P}ask"),
                _case(f"{P}wait"),
                _case(f"{P}done", "closed"),
                _case(f"{P}done2", "closed"),
                _case(f"{P}yday", "closed", NOW - timedelta(days=1, hours=3)),
            ]
            + [_finding(f"{P}f{index}", NOW - timedelta(hours=1, minutes=index)) for index in range(6)]
        )
        session.flush()
        for index in range(6):
            session.execute(case_findings.insert().values(case_id=f"{P}run", finding_id=f"{P}f{index}", added_at=NOW))
        session.add_all(
            [
                _run(f"{P}r-run", f"{P}run", "running", NOW - timedelta(hours=1)),
                _run(f"{P}r-ask", f"{P}ask", "paused", NOW - timedelta(minutes=40)),
                _run(f"{P}r-done", f"{P}done", "completed", NOW - timedelta(hours=3), NOW - timedelta(hours=2), 0.40),
                ApprovalAction(
                    action_id=f"{P}a1", action_type="isolate_host", title="Isolate host ws-17", description="d", target="ws-17",
                    confidence=0.8, reason="beaconing", evidence=[], created_by="pytest", requires_approval=True, status="pending",
                    parameters={"case_id": f"{P}ask"}, created_at=NOW - timedelta(minutes=20),
                ),
                ApprovalAction(
                    action_id=f"{P}a2", action_type="block_ip", title="Block", description="d", target="x", confidence=0.8,
                    reason="r", evidence=[], created_by="pytest", requires_approval=True, status="approved",
                    parameters={}, created_at=NOW - timedelta(hours=2, minutes=10), approved_at=NOW - timedelta(hours=2), approved_by="ada",
                ),
                CaseClosureInfo(case_id=f"{P}done", closure_category="resolved", closed_by="agent", closed_by_kind="agent", closed_at=NOW - timedelta(hours=2)),
                CaseClosureInfo(case_id=f"{P}done2", closure_category="false_positive", closed_by="ada", closed_by_kind="analyst", closed_at=NOW - timedelta(minutes=5)),
                CaseClosureInfo(case_id=f"{P}yday", closure_category="resolved", closed_by="agent", closed_by_kind="agent", closed_at=NOW - timedelta(days=1, hours=2)),
            ]
        )


def _ours(payload):
    return {cell["case_id"]: cell for band in payload["bands"] for cell in band["cells"] if cell["case_id"].startswith(P)}


def test_levels_follow_the_prd():
    assert usage_level(70, 100) == "good"
    assert usage_level(75, 100) == "fair"
    assert usage_level(91, 100) == "poor"
    assert usage_level(5, None) is None
    assert rate_level(0.95) == "good" and rate_level(0.9) == "fair" and rate_level(0.5) == "poor" and rate_level(None) is None


def test_the_wall_shows_every_open_case_in_its_state_and_workflow():
    _seed()
    payload = wall_payload(NOW)
    cells = _ours(payload)
    assert set(cells) == {f"{P}run", f"{P}ask", f"{P}wait"}
    assert cells[f"{P}run"]["state"] == "running" and cells[f"{P}run"]["workflow_id"] == "full-investigation"
    assert cells[f"{P}run"]["alerts"] == 6 and cells[f"{P}run"]["heavy"] is True
    assert cells[f"{P}ask"]["state"] == "needs_you"
    assert cells[f"{P}ask"]["decision"]["title"] == "Isolate host ws-17"
    assert cells[f"{P}wait"]["state"] == "waiting" and cells[f"{P}wait"]["workflow_id"] == "unassigned"
    assert payload["next_action"]["count"] >= 1
    # Closed today: one by agents, one by a person; yesterday by this time: one.
    assert payload["closed_today"]["value"] >= 2 and payload["closed_today"]["yesterday"] >= 1
    assert [row["case_id"] for row in payload["just_closed"] if row["case_id"].startswith(P)] == [f"{P}done2"]
    # What Vigil does not record is said, not guessed.
    facets = {facet["key"]: facet for facet in payload["facets"]}
    assert facets["stuck"]["count"] is None and facets["on_hold"]["count"] is None
    assert payload["incidents_today"]["unmeasured_text"] == "Not measured yet"


def test_needs_you_comes_first_in_its_band():
    _seed()
    band = next(band for band in wall_payload(NOW)["bands"] if band["workflow_id"] == "full-investigation")
    states = [cell["state"] for cell in band["cells"] if cell["case_id"].startswith(P)]
    assert states == ["needs_you", "running"]


def test_the_spine_counts_each_hour():
    _seed()
    day = spine(NOW)
    assert len(day["hours"]) == 24 and day["hours"][-1].startswith("2098-03-03T14:00")
    assert sum(day["alerts_in"]) >= 6
    assert day["running"][-1] >= 2
    assert sum(day["closed_by_person"]) >= 1 and sum(day["closed_by_agents"]) >= 1
    assert day["dropped"]["value"] is None


def test_summary_gauges_carry_their_limit_and_level():
    _seed()
    gauges = {gauge["key"]: gauge for gauge in summary(NOW)["gauges"]}
    assert gauges["time_to_decide"]["value"] is not None
    assert gauges["closed_today"]["level"] is None
    assert {"without_person", "closed_today", "time_to_decide", "spend_today"} <= set(gauges)


def test_work_ages_what_waits_and_names_the_oldest():
    _seed()
    rows = {row["key"]: row for row in work(NOW)["rows"]}
    assert rows["needs_you"]["count"]["value"] >= 1
    assert sum(bucket["count"] for bucket in rows["needs_you"]["ages"]) == rows["needs_you"]["count"]["value"]
    assert rows["stuck"]["count"]["unmeasured_text"] == "Not measured yet"


def test_throughput_lists_workflows_without_their_cells():
    _seed()
    kinds = throughput(NOW)["kinds"]
    investigation = next(kind for kind in kinds if kind["workflow_id"] == "full-investigation")
    assert "cells" not in investigation and investigation["open"] >= 2


def test_the_routes_answer():
    from services.api.routers import monitor

    app = FastAPI()
    app.include_router(monitor.router, prefix=monitor.ROUTER_META.prefix)
    client = TestClient(app)
    assert client.get("/api/fleet-wall").status_code == 200
    for tab in ("summary", "throughput", "work"):
        assert client.get(f"/api/pulse/{tab}").status_code == 200
    assert client.get("/api/pulse/nope").status_code == 404
