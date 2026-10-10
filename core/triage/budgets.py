"""A workflow's own share of the fleet budget.

One SystemConfig row, ``workflows.budgets``, holds each workflow's caps in USD:
``{"full-investigation": {"hourly_usd": 20, "daily_usd": 200}}``. A run's job
carries its workflow as the budget scope either way, so the agent workers learn
what runs of each workflow cost; the caps, where a workflow has any, are held the
way the fleet's are (services/agent/core/fleet-budget.ts).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from core.storage.config_service import get_config_service

logger = logging.getLogger(__name__)

BUDGETS_KEY = "workflows.budgets"


def _usd(value: Any) -> Optional[float]:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def budget_for(workflow_id: str) -> Dict[str, Any]:
    """The budget block a run of this workflow carries on its job."""
    block: Dict[str, Any] = {"scope": workflow_id}
    try:
        stored = get_config_service().get_system_config(BUDGETS_KEY)
    except Exception as exc:  # noqa: BLE001 -- a run with no caps still runs
        logger.warning("could not read workflow budgets: %s", exc)
        return block
    caps = stored.get(workflow_id) if isinstance(stored, dict) else None
    if isinstance(caps, dict):
        for field in ("hourly_usd", "daily_usd"):
            value = _usd(caps.get(field))
            if value is not None:
                block[field] = value
    return block
