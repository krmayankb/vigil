"""The triage decision: what an item was taken for, where it went, and why.

Recorded on the intake row as ``triage_decision`` and read back by the Triage
screen, so a person can see, per item, which class it was given, by what, which
workflow and plugin took it, and whether it fell back or merged into open work.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from core.triage.classify import Classification
from core.triage.routes import RouteDecision, plugin_for


def decision_record(
    classification: Classification,
    routed: Optional[RouteDecision] = None,
    *,
    workflow_id: Optional[str] = None,
    run_kind: Optional[str] = None,
    lane: Optional[str] = None,
    priority: Optional[str] = None,
    merged_into: Optional[str] = None,
) -> Dict[str, Any]:
    """One row's decision, every field named even when empty, so a reader can rely on the shape."""
    chosen = workflow_id or (routed.workflow_id if routed is not None else None)
    return {
        **classification.to_record(),
        "workflow_id": chosen,
        "run_kind": run_kind,
        "plugin": plugin_for(run_kind) if run_kind else None,
        "fell_back": routed.fell_back if routed is not None else None,
        "lane": lane,
        "priority": priority,
        "merged_into": merged_into,
    }
