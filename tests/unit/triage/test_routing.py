"""Triage: what an item is, and which workflow takes it.

The rules and the defaults reproduce the routing the daemon always did; the route
table can move a class elsewhere, and an item lands on the fallback when its class
has no route, its route is off, it is below the route's confidence floor, or the
workflow is turned off.
"""

from __future__ import annotations

import itertools
from unittest.mock import MagicMock, patch

import pytest

from core.triage import classify as c
from core.triage.classify import Classification, RulesV1
from core.triage.decision import decision_record
from core.triage.routes import DEFAULT_ROUTES, RUN_KIND_PLUGINS, Route, route, routes
from core.workflows.routing import FALLBACK_WORKFLOW

pytestmark = pytest.mark.unit

ALL_ON = patch("core.triage.routes.is_enabled", return_value=True)


def _old_select_workflow(finding):
    # The rules as they stood before core.triage, kept here as the oracle.
    severity = (finding.get("severity") or "").lower()
    recommended = (finding.get("recommended_action") or "").lower()
    category = (finding.get("category") or "").lower()
    mitre = finding.get("mitre_predictions") or {}
    if recommended in ("isolate", "block") or severity == "critical":
        return FALLBACK_WORKFLOW
    if category in ("malware", "ransomware"):
        return "forensic-analysis"
    if len(mitre) >= 3:
        return "full-investigation"
    if severity == "high":
        return "full-investigation"
    return FALLBACK_WORKFLOW


def test_the_defaults_route_every_finding_where_the_old_rules_did():
    findings = [
        {"severity": s, "recommended_action": a, "category": k, "mitre_predictions": m}
        for s, a, k, m in itertools.product(
            ["critical", "high", "medium", "low", "", None],
            ["isolate", "block", "monitor", ""],
            ["malware", "ransomware", "network", ""],
            [{}, {"T1": 1, "T2": 1}, {"T1": 1, "T2": 1, "T3": 1}],
        )
    ]
    with ALL_ON:
        for finding in findings:
            assert route(RulesV1().classify(finding), DEFAULT_ROUTES).workflow_id == _old_select_workflow(finding)


def test_the_rules_say_what_they_matched():
    found = RulesV1().classify({"severity": "high", "category": "malware"})
    assert (found.activity_class, found.confidence, found.classifier) == (c.MALWARE, 1.0, "rules-v1")
    assert "malware" in found.reason


def test_a_class_with_no_route_lands_on_the_fallback():
    decision = route(Classification("beaconing", 0.9, "x", "model"), {})
    assert decision.workflow_id == FALLBACK_WORKFLOW
    assert decision.fell_back == "no route for beaconing"


def test_a_route_that_is_off_or_a_class_below_its_floor_lands_on_the_fallback():
    table = {"beaconing": Route("full-investigation", enabled=False), "phishing": Route("full-investigation", min_confidence=0.8)}
    with ALL_ON:
        assert "is off" in route(Classification("beaconing", 1.0, "", "m"), table).fell_back
        unsure = route(Classification("phishing", 0.5, "", "m"), table)
        assert unsure.workflow_id == FALLBACK_WORKFLOW and "under the route's 0.80" in unsure.fell_back
        assert route(Classification("phishing", 0.9, "", "m"), table).workflow_id == "full-investigation"


def test_a_workflow_that_is_turned_off_lands_on_the_fallback():
    with patch("core.triage.routes.is_enabled", return_value=False):
        decision = route(Classification(c.MALWARE, 1.0, "", "rules-v1"), DEFAULT_ROUTES)
    assert decision.workflow_id == FALLBACK_WORKFLOW
    assert decision.fell_back == "workflow forensic-analysis is turned off"


def test_the_table_row_overrides_a_class_and_adds_new_ones():
    service = MagicMock()
    service.get_system_config.return_value = {
        c.MALWARE: {"workflow_id": "full-investigation"},
        "beaconing": {"workflow_id": "threat-hunt", "min_confidence": 0.7},
        "broken": {"enabled": True},
    }
    with patch("core.triage.routes.get_config_service", return_value=service):
        table = routes()
    assert table[c.MALWARE].workflow_id == "full-investigation"
    assert table["beaconing"] == Route("threat-hunt", True, 0.7)
    assert "broken" not in table
    assert table[c.HIGH_SEVERITY] == DEFAULT_ROUTES[c.HIGH_SEVERITY]


def test_an_unreadable_table_routes_by_the_defaults():
    with patch("core.triage.routes.get_config_service", side_effect=RuntimeError("db down")):
        assert routes() == dict(DEFAULT_ROUTES)


def test_the_decision_names_every_field_the_screen_reads():
    with ALL_ON:
        routed = route(Classification(c.MALWARE, 1.0, "", "rules-v1"), DEFAULT_ROUTES)
    record = decision_record(
        Classification(c.MALWARE, 1.0, "malware category", "rules-v1"),
        routed,
        run_kind="investigate",
        lane="automated",
        priority="high",
    )
    assert record == {
        "activity_class": "malware",
        "confidence": 1.0,
        "reason": "malware category",
        "classifier": "rules-v1",
        "workflow_id": "forensic-analysis",
        "run_kind": "investigate",
        "plugin": "investigate",
        "fell_back": None,
        "lane": "automated",
        "priority": "high",
        "merged_into": None,
    }


def test_every_run_kind_names_its_plugin():
    from core.agents.queue import RUN_KINDS

    assert set(RUN_KIND_PLUGINS) == set(RUN_KINDS)
