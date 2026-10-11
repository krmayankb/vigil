"""What runs shared is settled by memory: final once written, superseded when a
person's closure of the Case contradicts it (core/memory/shared_findings.py).

Integration rather than unit: entity_findings is the agent layer's table, which
the unit tests' create_all database does not have.
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session

from core.memory.shared_findings import retract_contradicted, settle_run

pytestmark = [pytest.mark.integration, pytest.mark.database, pytest.mark.external_service]

REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def engine():
    url = os.environ.get("DATABASE_URL", "postgresql://vigil:vigil@localhost:5432/vigil_test")
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg2://", 1))
    with engine.connect() as conn:
        conn.execute(text((REPO_ROOT / "infra/database/init/42_entity_findings.sql").read_text()))
        conn.execute(text("CREATE TABLE IF NOT EXISTS workflow_runs (run_id varchar(80) PRIMARY KEY, trigger_context jsonb NOT NULL DEFAULT '{}'::jsonb)"))
        conn.commit()
    yield engine
    engine.dispose()


@pytest.fixture
def world(engine):
    host = f"host:test-{uuid.uuid4()}"
    case_id = f"case-{uuid.uuid4().hex[:8]}"
    runs = [uuid.uuid4(), uuid.uuid4()]
    yield host, case_id, runs
    with engine.connect() as conn:
        conn.execute(text("DELETE FROM entity_findings WHERE entity_key = :k"), {"k": host})
        conn.execute(text("DELETE FROM workflow_runs WHERE run_id = ANY(:r)"), {"r": [str(r) for r in runs]})
        conn.commit()


def finding(session, host, run, seq, answer, kind="conclusion"):
    session.execute(
        text(
            "INSERT INTO entity_findings (entity_key, seq, run_id, run_kind, source_seq, kind, statement, detail) "
            "VALUES (:k, :seq, CAST(:r AS uuid), 'investigate', :seq, :kind, :st, CAST(:d AS jsonb))"
        ),
        {"k": host, "seq": seq, "r": str(run), "kind": kind, "st": f"ws is {answer}", "d": json.dumps({"answer": {"disposition": answer}})},
    )


def on_case(session, run, case_id):
    session.execute(
        text(
            "INSERT INTO workflow_runs (run_id, workflow_id, workflow_name, status, trigger_context) "
            "VALUES (:r, 'investigate', 'Full Investigation', 'completed', CAST(:c AS jsonb)) ON CONFLICT DO NOTHING"
        ),
        {"r": str(run), "c": json.dumps({"case_id": case_id})},
    )


def rows(session, host):
    return session.execute(
        text("SELECT run_id, kind, status, seq, statement, derived_from FROM entity_findings WHERE entity_key = :k ORDER BY seq"),
        {"k": host},
    ).all()


class TestSettled:
    def test_a_runs_findings_become_final_once_its_memory_is_written(self, engine, world):
        host, _, (run, other) = world
        with Session(engine) as session:
            finding(session, host, run, 1, "malicious", kind="claim")
            finding(session, host, other, 2, "malicious")
            assert settle_run(session, str(run)) == 1
            assert [(r.run_id, r.status) for r in rows(session, host)] == [(run, "final"), (other, "provisional")]
            session.rollback()

    def test_a_closure_that_contradicts_a_dismissal_supersedes_it_and_says_so(self, engine, world):
        host, case_id, (dismissed, escalated) = world
        with Session(engine) as session:
            finding(session, host, dismissed, 1, "benign")
            finding(session, host, escalated, 2, "malicious")
            on_case(session, dismissed, case_id)
            on_case(session, escalated, case_id)

            assert retract_contradicted(session, case_id, "proven", "resolved", "nestor") == {"superseded": 1, "retractions": 1}
            held = rows(session, host)
            assert [(r.run_id, r.kind, r.status) for r in held] == [
                (dismissed, "conclusion", "superseded"),
                (escalated, "conclusion", "provisional"),
                (dismissed, "retraction", "final"),
            ]
            retraction = held[-1]
            assert retraction.seq == 3 and f"Case {case_id} was closed by nestor as resolved" in retraction.statement
            # Retracting again files nothing twice.
            assert retract_contradicted(session, case_id, "proven", "resolved", "nestor")["retractions"] == 0
            session.rollback()

    def test_an_unsettled_answer_or_an_inconclusive_case_contradicts_nothing(self, engine, world):
        host, case_id, (run, _) = world
        with Session(engine) as session:
            finding(session, host, run, 1, "needs_review")
            on_case(session, run, case_id)
            assert retract_contradicted(session, case_id, "proven", "resolved", "nestor")["superseded"] == 0
            assert retract_contradicted(session, case_id, "inconclusive", "unable_to_resolve", "nestor")["superseded"] == 0
            session.rollback()
