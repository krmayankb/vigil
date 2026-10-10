"""Shared fixtures for the daemon's unit tests."""

from unittest.mock import AsyncMock

import pytest


@pytest.fixture(autouse=True)
def empty_run_queue(monkeypatch):
    """The run queue reads as empty, so no test here reaches for Redis.

    A test about the queue's high-water mark patches it again with the depth it needs.
    """
    backlog = AsyncMock(return_value=0)
    monkeypatch.setattr("services.daemon.orchestrator.automated_backlog", backlog)
    return backlog
