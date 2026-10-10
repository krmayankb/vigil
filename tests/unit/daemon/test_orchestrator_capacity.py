"""How much the daemon launches, once the agent layer bounds its own load.

ORCHESTRATOR_MAX_AGENTS caps the investigations running at once; 0 is no cap of
the daemon's own. Either way it stops launching from the triage queue while the
automated run queue already holds its high-water mark, since queueing work faster
than workers drain it only ages it.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from services.daemon.config import OrchestratorConfig
from services.daemon.orchestrator import Orchestrator

pytestmark = pytest.mark.unit


def _orchestrator(cap: int, running: int, high_water: int = 500) -> Orchestrator:
    orch = object.__new__(Orchestrator)
    orch.config = OrchestratorConfig(max_concurrent_agents=cap, intake_high_water=high_water)
    orch._running = MagicMock(return_value=running)
    return orch


def test_a_cap_stops_launches_once_reached():
    assert _orchestrator(cap=3, running=3)._at_capacity()
    assert not _orchestrator(cap=3, running=2)._at_capacity()


def test_a_cap_of_zero_is_no_cap():
    orch = _orchestrator(cap=0, running=10_000)
    assert not orch._at_capacity()
    orch._running.assert_not_called()


async def test_the_daemon_holds_off_while_the_run_queue_is_full(empty_run_queue):
    orch = _orchestrator(cap=0, running=0, high_water=100)
    empty_run_queue.return_value = 100
    assert not await orch._room_on_the_run_queue()
    empty_run_queue.return_value = 99
    assert await orch._room_on_the_run_queue()


async def test_an_unreadable_run_queue_does_not_starve_intake(empty_run_queue):
    empty_run_queue.return_value = None
    assert await _orchestrator(cap=0, running=0)._room_on_the_run_queue()


async def test_a_full_run_queue_leaves_every_row_queued(empty_run_queue):
    orch = _orchestrator(cap=0, running=0, high_water=10)
    empty_run_queue.return_value = 10
    orch._queued_intake_triggers = MagicMock(return_value=[{"id": 1, "kind": "human_ask", "payload": {}}])
    orch._resolve_intake_row = MagicMock(side_effect=lambda row, now: row)
    orch._hourly_budget_exhausted = MagicMock(return_value=False)
    orch._process_intake_row = AsyncMock()
    orch._queued_intake_depth = MagicMock(return_value=1)
    orch._record_intake_depth = MagicMock()
    orch.config.intake_ttl_seconds = 3600
    orch.config.intake_ttl_promote_fraction = 0.25
    await orch._drain_intake(MagicMock())
    orch._process_intake_row.assert_not_awaited()
