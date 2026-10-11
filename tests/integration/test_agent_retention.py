"""Run ledgers and shared findings age out, and nothing else does
(``45_agent_retention.sql``, ``core/agents/ledger_retention.py``)."""

from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from core.agents.ledger_retention import expire_runs, expire_shared_findings

pytestmark = [pytest.mark.integration, pytest.mark.database, pytest.mark.external_service]

REPO_ROOT = Path(__file__).resolve().parents[2]
DDL = ("19_agent_ledger.sql", "31_agent_ledger_hash_chain.sql", "20_agent_directives.sql", "21_agent_run_leases.sql", "42_entity_findings.sql", "45_agent_retention.sql")


@pytest.fixture(scope="module")
def engine():
    url = os.environ.get("DATABASE_URL", "postgresql://vigil:vigil@localhost:5432/vigil_test")
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg2://", 1))
    with engine.connect() as conn:
        for name in DDL:
            conn.execute(text((REPO_ROOT / "infra" / "database" / "init" / name).read_text()))
        conn.commit()
    yield engine
    engine.dispose()


def event(session, run, seq, kind, days_ago):
    session.execute(
        text(
            "INSERT INTO agent_events (run_id, seq, ts, run_kind, kind, payload, schema_version) "
            "VALUES (CAST(:r AS uuid), :s, now() - make_interval(days => :d), 'investigate', :k, '{}'::jsonb, 1)"
        ),
        {"r": str(run), "s": seq, "d": days_ago, "k": kind},
    )


def remaining(session, runs):
    return {
        row.run_id
        for row in session.execute(text("SELECT DISTINCT run_id FROM agent_events WHERE run_id = ANY(CAST(:r AS uuid[]))"), {"r": [str(r) for r in runs]})
    }


def test_retires_whole_ended_runs_past_retention_and_nothing_else(engine):
    old, recent, unfinished, revived = (uuid.uuid4() for _ in range(4))
    with Session(engine) as session:
        for seq, kind in enumerate(["run", "call", "terminal"]):
            event(session, old, seq, kind, 200)
            event(session, recent, seq, kind, 10)
        event(session, unfinished, 0, "run", 300)
        event(session, unfinished, 1, "call", 290)
        # Ended long ago, then picked up again yesterday: still in use.
        event(session, revived, 0, "run", 300)
        event(session, revived, 1, "terminal", 290)
        event(session, revived, 2, "resumed", 1)
        session.commit()

        assert expire_runs(180, session=session) >= 1
        session.commit()
        assert remaining(session, [old, recent, unfinished, revived]) == {recent, unfinished, revived}
        session.execute(text("DELETE FROM agent_events WHERE run_id = ANY(CAST(:r AS uuid[]))"), {"r": [str(r) for r in (recent, unfinished, revived)]})
        session.commit()


def test_refuses_a_retention_under_the_floor(engine):
    with Session(engine) as session, pytest.raises(DBAPIError, match="floor is 7"):
        session.execute(text("SELECT expire_agent_runs(3, 10)"))


def test_zero_keeps_everything(engine):
    with Session(engine) as session:
        assert expire_runs(0, session=session) == 0
        assert expire_shared_findings(0, session=session) == 0


def test_shared_findings_past_retention_are_deleted(engine):
    key = f"host:test-{uuid.uuid4()}"
    with Session(engine) as session:
        for seq, days in ((1, 40), (2, 5)):
            session.execute(
                text(
                    "INSERT INTO entity_findings (entity_key, seq, run_id, run_kind, source_seq, kind, statement, recorded_at) "
                    "VALUES (:k, :s, gen_random_uuid(), 'investigate', :s, 'claim', 'x', now() - make_interval(days => :d))"
                ),
                {"k": key, "s": seq, "d": days},
            )
        session.commit()
        assert expire_shared_findings(30, session=session) >= 1
        session.commit()
        assert [row.seq for row in session.execute(text("SELECT seq FROM entity_findings WHERE entity_key = :k"), {"k": key})] == [2]
        session.execute(text("DELETE FROM entity_findings WHERE entity_key = :k"), {"k": key})
        session.commit()
