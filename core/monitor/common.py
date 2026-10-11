"""What every Monitor number carries: its value, its limit, a level word, and an
``info`` saying where it comes from and how it is counted.

Levels follow the console PRD's vocabulary. Usage against a limit: good under
75%, fair from 75% to 90%, poor over 90%. Rates: good at 95% or better, fair
from 85%, poor under 85%. A number with no limit configured has no level; one
Vigil does not record yet is ``None`` with ``unmeasured`` text, never estimated.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from core.config import get_settings

UNMEASURED = "Not measured yet"
USAGE_FAIR = 0.75
USAGE_POOR = 0.90
RATE_GOOD = 0.95
RATE_FAIR = 0.85


def usage_level(used: Optional[float], limit: Optional[float]) -> Optional[str]:
    if used is None or not limit:
        return None
    share = used / limit
    if share > USAGE_POOR:
        return "poor"
    if share >= USAGE_FAIR:
        return "fair"
    return "good"


def rate_level(rate: Optional[float]) -> Optional[str]:
    if rate is None:
        return None
    if rate >= RATE_GOOD:
        return "good"
    if rate >= RATE_FAIR:
        return "fair"
    return "poor"


def metric(
    value: Any,
    *,
    info: str,
    limit: Any = None,
    level: Optional[str] = None,
    unmeasured: Optional[str] = None,
    **extra: Any,
) -> dict:
    """One number as the console shows it. ``unmeasured`` names why it is absent."""
    return {
        "value": None if unmeasured else value,
        "limit": limit,
        "level": None if unmeasured else level,
        "info": info,
        "unmeasured_text": UNMEASURED if unmeasured else None,
        "unmeasured_reason": unmeasured,
        **extra,
    }


def day_start(now: datetime) -> datetime:
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


def same_time_yesterday(now: datetime) -> tuple[datetime, datetime]:
    """Yesterday from midnight to this time of day: the pace comparison."""
    start = day_start(now) - timedelta(days=1)
    return start, now - timedelta(days=1)


def concurrency_cap() -> Optional[int]:
    """The fleet's investigation cap: orchestrator.settings, else the setting.

    0 means no cap of the daemon's own (docs/agent-fleet.md), which is no limit.
    """
    cap: Optional[int] = None
    try:
        from core.storage.config_service import get_config_service

        configured = get_config_service().get_system_config("orchestrator.settings")
        if isinstance(configured, dict) and configured.get("max_concurrent_agents") is not None:
            cap = int(configured["max_concurrent_agents"])
    except Exception:  # noqa: BLE001 - a config read that fails falls back to the setting
        cap = None
    if cap is None:
        cap = int(getattr(get_settings(), "orchestrator_max_agents", 0) or 0)
    return cap if cap > 0 else None


def daily_spend_cap() -> Optional[float]:
    value = float(getattr(get_settings(), "vigil_fleet_budget_daily_usd", 0) or 0)
    return value if value > 0 else None


def intake_high_water() -> Optional[int]:
    value = int(getattr(get_settings(), "orchestrator_intake_high_water", 0) or 0)
    return value if value > 0 else None
