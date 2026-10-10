"""Every row triage takes says why it went where it did.

The decision goes on the intake row (triage_decision) for the Triage screen: a
finding's class, classifier and route; a merged finding's class and that it
joined open work; a person's ask, on the human lane, with the workflow they named.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.daemon.config import OrchestratorConfig
from services.daemon.orchestrator import Orchestrator

pytestmark = pytest.mark.unit


def _orchestrator(merges: bool = False) -> Orchestrator:
    orch = object.__new__(Orchestrator)
    orch.config = OrchestratorConfig()
    orch._create_investigation = AsyncMock()
    orch._merge_if_overlaps = MagicMock(return_value=merges)
    orch._record_triage = MagicMock()
    orch._workflows = MagicMock()
    orch._workflows.get_workflow.return_value = MagicMock(run_kind="investigate")
    orch._data_service = None
    return orch


async def test_a_routed_finding_records_its_class_route_and_plugin():
    orch = _orchestrator()
    with patch("core.triage.routes.is_enabled", return_value=True), patch(
        "core.triage.routes.get_config_service", side_effect=RuntimeError("no table")
    ):
        await orch._create_investigation_for_finding(
            {"finding_id": "f-1", "severity": "high", "category": "ransomware"}, MagicMock(), trigger_id=7
        )

    trigger_id, record = orch._record_triage.call_args.args
    assert trigger_id == 7
    assert record["activity_class"] == "malware"
    assert record["classifier"] == "rules-v1"
    assert (record["workflow_id"], record["run_kind"], record["plugin"]) == ("forensic-analysis", "investigate", "investigate")
    assert (record["lane"], record["priority"], record["fell_back"]) == ("automated", "high", None)
    assert orch._create_investigation.await_args.kwargs["workflow_id"] == "forensic-analysis"


async def test_a_finding_whose_workflow_is_off_says_where_it_went_instead():
    orch = _orchestrator()
    with patch("core.triage.routes.is_enabled", return_value=False), patch(
        "core.triage.routes.get_config_service", side_effect=RuntimeError("no table")
    ):
        await orch._create_investigation_for_finding({"finding_id": "f-2", "category": "malware"}, MagicMock(), trigger_id=8)

    record = orch._record_triage.call_args.args[1]
    assert record["workflow_id"] == "incident-response"
    assert record["fell_back"] == "workflow forensic-analysis is turned off"


async def test_a_merged_finding_still_says_what_it_was():
    orch = _orchestrator(merges=True)
    await orch._create_investigation_for_finding({"finding_id": "f-3", "severity": "critical"}, MagicMock(), trigger_id=9)

    record = orch._record_triage.call_args.args[1]
    assert record["activity_class"] == "critical"
    assert record["merged_into"] == "open work"
    assert record["workflow_id"] is None
    orch._create_investigation.assert_not_awaited()


async def test_a_persons_ask_goes_on_the_human_lane_with_the_workflow_they_named():
    orch = _orchestrator()
    await orch._create_manual_investigation({"workflow_id": "threat-hunt", "priority": "high"}, MagicMock(), trigger_id=10)

    record = orch._record_triage.call_args.args[1]
    assert (record["activity_class"], record["classifier"]) == ("human-ask", "named")
    assert (record["workflow_id"], record["lane"], record["priority"]) == ("threat-hunt", "human", "high")


async def test_a_schedule_goes_on_the_automated_lane():
    orch = _orchestrator()
    await orch._create_manual_investigation(
        {"workflow_id": "threat-hunt", "trigger_type": "scheduled"}, MagicMock(), trigger_id=11
    )
    record = orch._record_triage.call_args.args[1]
    assert (record["activity_class"], record["lane"]) == ("scheduled", "automated")
