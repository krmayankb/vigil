"""Ageing out the agent layer's run ledger and what runs shared.

The ledger is append-only for the app role, so this calls the one function it may
use to retire runs, ``expire_agent_runs`` (``45_agent_retention.sql``): whole ended
runs past retention, a batch at a time, a floor of seven days. Shared findings
(``entity_findings``) are the app's to delete outright. Episodic memory distilled
from a retired run is kept.

A retention of 0 keeps everything. Either table may be absent where the agent
layer is not deployed, and then nothing is done.
"""

from __future__ import annotations

import logging
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from core.storage.unit_of_work import unit_of_work

logger = logging.getLogger(__name__)

RUN_BATCH = 500
FINDING_BATCH = 5_000
# Batches per sweep, so one sweep over a long backlog stays bounded; the next
# picks up where it stopped.
MAX_BATCHES = 20


def expire_runs(retention_days: int, *, session: Optional[Session] = None) -> int:
    """Retire ended runs past retention; how many runs went."""
    if retention_days <= 0:
        return 0
    retired = 0
    with unit_of_work(session) as db:
        if not db.execute(text("SELECT to_regprocedure('expire_agent_runs(integer, integer)') IS NOT NULL")).scalar():
            return 0
        for _ in range(MAX_BATCHES):
            gone = int(db.execute(text("SELECT expire_agent_runs(:days, :batch)"), {"days": retention_days, "batch": RUN_BATCH}).scalar() or 0)
            retired += gone
            if gone < RUN_BATCH:
                break
    return retired


def expire_shared_findings(retention_days: int, *, session: Optional[Session] = None) -> int:
    """Delete shared findings recorded longer ago than retention; how many went."""
    if retention_days <= 0:
        return 0
    removed = 0
    with unit_of_work(session) as db:
        if not db.execute(text("SELECT to_regclass('entity_findings') IS NOT NULL")).scalar():
            return 0
        for _ in range(MAX_BATCHES):
            result = db.execute(
                text(
                    """
                    DELETE FROM entity_findings
                     WHERE ctid = ANY(ARRAY(
                       SELECT ctid FROM entity_findings
                        WHERE recorded_at < now() - make_interval(days => :days)
                        LIMIT :batch))
                    """
                ),
                {"days": retention_days, "batch": FINDING_BATCH},
            )
            gone = int(result.rowcount or 0)
            removed += gone
            if gone < FINDING_BATCH:
                break
    return removed
