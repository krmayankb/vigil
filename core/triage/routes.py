"""Where each activity class goes: the route table.

A route names a workflow, and the workflow names the plugin the agent runs it on.
The defaults reproduce the routing the daemon has always done, so nothing moves
until someone edits the table. Overrides live in one SystemConfig row,
``triage.routes``, keyed by activity class; a class with no route, a route that is
off, a classification below its route's confidence floor, or a workflow that is
turned off all land on the fallback workflow.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass
from typing import Any, Dict, Mapping, Optional

from core.storage.config_service import get_config_service
from core.triage import classify as c
from core.triage.classify import Classification
from core.workflows.enablement import is_enabled
from core.workflows.routing import FALLBACK_WORKFLOW

logger = logging.getLogger(__name__)

ROUTES_KEY = "triage.routes"

# The plugin each run kind runs on, in services/agent/plugins/kinds.ts. A ratchet
# holds the two equal.
RUN_KIND_PLUGINS: Mapping[str, str] = {
    "hunt": "hunt",
    "adjudicate": "adjudicate",
    "investigate": "investigate",
    "root_cause": "rootcause",
    "compose": "compose",
    "chat": "chat",
}


@dataclass(frozen=True)
class Route:
    workflow_id: str
    enabled: bool = True
    # Below this, the item goes to the fallback rather than trusting the class.
    min_confidence: float = 0.0


DEFAULT_ROUTES: Mapping[str, Route] = {
    c.CONTAINMENT_ASKED: Route(FALLBACK_WORKFLOW),
    c.CRITICAL: Route(FALLBACK_WORKFLOW),
    c.MALWARE: Route("forensic-analysis"),
    c.MULTI_TECHNIQUE: Route("full-investigation"),
    c.HIGH_SEVERITY: Route("full-investigation"),
    c.UNCLASSIFIED: Route(FALLBACK_WORKFLOW),
}


def routes() -> Dict[str, Route]:
    """The defaults with whatever the table's row overrides. A bad row is ignored."""
    table = dict(DEFAULT_ROUTES)
    try:
        stored = get_config_service().get_system_config(ROUTES_KEY)
    except Exception as exc:  # noqa: BLE001 -- the defaults route everything
        logger.warning("could not read the triage route table: %s", exc)
        return table
    if not isinstance(stored, dict):
        return table
    for activity, raw in stored.items():
        if not isinstance(raw, dict) or not isinstance(raw.get("workflow_id"), str):
            logger.warning("ignoring the triage route for %r: no workflow_id", activity)
            continue
        table[str(activity)] = Route(
            workflow_id=raw["workflow_id"],
            enabled=raw.get("enabled", True) is not False,
            min_confidence=float(raw.get("min_confidence") or 0.0),
        )
    return table


@dataclass(frozen=True)
class RouteDecision:
    workflow_id: str
    # Set when the item did not go where its class pointed, and why.
    fell_back: Optional[str] = None

    def to_record(self) -> Dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v is not None}


def route(
    classification: Classification, table: Optional[Mapping[str, Route]] = None
) -> RouteDecision:
    held = routes() if table is None else table
    chosen = held.get(classification.activity_class)
    if chosen is None:
        return RouteDecision(FALLBACK_WORKFLOW, f"no route for {classification.activity_class}")
    if not chosen.enabled:
        return RouteDecision(FALLBACK_WORKFLOW, f"the route for {classification.activity_class} is off")
    if classification.confidence < chosen.min_confidence:
        return RouteDecision(
            FALLBACK_WORKFLOW,
            f"confidence {classification.confidence:.2f} is under the route's {chosen.min_confidence:.2f}",
        )
    if chosen.workflow_id != FALLBACK_WORKFLOW and not is_enabled(chosen.workflow_id):
        return RouteDecision(FALLBACK_WORKFLOW, f"workflow {chosen.workflow_id} is turned off")
    return RouteDecision(chosen.workflow_id)


def plugin_for(run_kind: str) -> Optional[str]:
    return RUN_KIND_PLUGINS.get(run_kind)


__all__ = [
    "DEFAULT_ROUTES",
    "ROUTES_KEY",
    "RUN_KIND_PLUGINS",
    "Route",
    "RouteDecision",
    "plugin_for",
    "route",
    "routes",
]
