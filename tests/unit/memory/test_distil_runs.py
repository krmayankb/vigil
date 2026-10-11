"""Memory from every agent run, not only hunts, with how each row came to be.

A kernel run of any plugin but the hunt files as investigation kind ``run``,
keyed by its run id (``services/agent/plugins/kernel-distil.ts``), and every row
carries the run's provenance so recall can be tuned on it later.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from core.memory.distil import (
    DISTILLED_RUN_KINDS,
    Concluded,
    DistilRefused,
    FailureKey,
    Terminal,
    _accept,
    _conclusion_rows,
    _sighting_rows,
    write_distil,
)
from core.memory.recall_contract import InvestigationKind
from core.storage.connection import get_db_session
from core.storage.models import (
    EpisodicDistilMarker,
    EpisodicGap,
    EpisodicSighting,
    EpisodicVerdict,
    EpisodicVerdictSource,
)

RUN = uuid.UUID("7d3c2d3e-0000-4000-8000-0000000008a1")
CONCLUDED_AT = datetime(2026, 10, 11, 12, 0, tzinfo=timezone.utc)

PROVENANCE = {
    "source": "kernel",
    "plugin": "investigate",
    "run_kind": "investigate",
    "run_outcome": "completed",
    "review": "insufficient",
    "guarded": {"field": "disposition", "asked": "benign", "final": "needs_review"},
    "held": True,
    "rests_on_other_runs": False,
    "models": ["vertex/gemini-2.5-pro"],
    "trust": "agent",
}


def _payload(**fields):
    base = {
        "investigation_kind": "run",
        "investigation_id": str(RUN),
        "outcome": "completed",
        "concluded_at": "2026-10-11T12:00:00Z",
        "distil_schema_version": 2,
        "provenance": PROVENANCE,
        "sightings": [
            {
                "entity": {"type": "ip", "value": "198.51.100.7"},
                "source_system": "splunk_search",
                "hit_count": 2,
                "attacker_influenceable": True,
                "first_seen": "2026-10-11T11:58:00Z",
                "last_seen": "2026-10-11T11:59:00Z",
            }
        ],
        "conclusions": [
            {
                "hypothesis_id": "conclusion",
                "statement": "the traffic is a backup job (disposition: needs_review)",
                "status": "inconclusive",
                "rationale": "it answered benign; its review did not let that stand",
                "subject_entities": [{"type": "ip", "value": "198.51.100.7"}],
                "evidence_count": 1,
                "attacker_influenceable_only": False,
                "sources": [{"source_system": "splunk_search", "stance": "supports"}],
                "techniques": [],
                "first_seen": "2026-10-11T11:57:00Z",
                "last_seen": "2026-10-11T12:00:00Z",
                "window_observed": False,
                "provenance": {"row": "conclusion", "answer": "needs_review", "asked": "benign"},
            },
            {
                "hypothesis_id": "h1",
                "statement": "a password spray",
                "status": "active",
                "rationale": "",
                "subject_entities": [{"type": "ip", "value": "198.51.100.7"}],
                "evidence_count": 0,
                "attacker_influenceable_only": False,
                "sources": [],
                "techniques": [],
                "first_seen": "2026-10-11T11:57:00Z",
                "last_seen": "2026-10-11T12:00:00Z",
                "window_observed": False,
                "provenance": {"row": "claim"},
            },
        ],
    }
    return base | fields


TERMINAL = Terminal(RUN, 41, "investigate")


class TestARunFilesAsItsOwnKind:
    pytestmark = pytest.mark.unit

    def test_every_kernel_run_kind_but_the_hunt_files_as_run(self):
        assert set(DISTILLED_RUN_KINDS) >= {"hunt", "investigate", "root_cause"}
        assert _accept(TERMINAL, _payload()).kind is InvestigationKind.RUN
        assert _accept(Terminal(RUN, 3, "hunt"), _payload(investigation_kind="hunt")).kind is InvestigationKind.HUNT

    def test_a_payload_filing_under_another_kind_is_refused(self):
        with pytest.raises(DistilRefused, match="files under 'run'"):
            _accept(TERMINAL, _payload(investigation_kind="hunt"))

    def test_a_run_failure_names_the_terminal_it_failed_on(self):
        key = FailureKey.of(TERMINAL)
        assert (key.kind, key.value, key.seq) == (InvestigationKind.RUN, str(RUN), 41)
        with pytest.raises(ValueError):
            FailureKey(InvestigationKind.RUN, str(RUN))

    def test_every_row_carries_the_runs_provenance_and_its_own(self):
        concluded = _accept(TERMINAL, _payload())
        verdicts, gaps = _conclusion_rows(concluded)
        sightings = _sighting_rows(concluded)

        verdict = verdicts[0]["row"]
        assert verdict["investigation_kind"] == "run"
        assert verdict["outcome"] == "inconclusive"
        assert verdict["provenance"] == {"investigation_kind": "run", **PROVENANCE, "row": "conclusion", "answer": "needs_review", "asked": "benign"}
        assert verdicts[0]["sources"] == [{"source_system": "splunk_search", "stance": "supports", "source_tier": "feed"}]
        # A claim nothing bore on is a question the run never answered.
        assert [gap["hypothesis_id"] for gap in gaps] == ["h1"]
        assert gaps[0]["provenance"]["row"] == "claim"
        assert sightings[0]["investigation_kind"] == "run"
        assert sightings[0]["provenance"]["held"] is True

    def test_a_hunts_rows_say_only_that_they_are_a_hunts(self):
        concluded = Concluded({"conclusions": [], "sightings": []}, "hunt-1", CONCLUDED_AT)
        assert concluded.provenance() == {"investigation_kind": "hunt"}


@pytest.fixture
def session():
    db = get_db_session()
    try:
        _empty(db)
        yield db
    finally:
        db.rollback()
        _empty(db)
        db.close()


def _empty(db):
    db.query(EpisodicVerdictSource).delete()
    for model in (EpisodicVerdict, EpisodicGap, EpisodicSighting, EpisodicDistilMarker):
        db.query(model).filter(model.investigation_id == str(RUN)).delete()
    db.commit()


class TestARunIsWrittenAndRecalledWithItsProvenance:
    pytestmark = [pytest.mark.unit, pytest.mark.database, pytest.mark.external_service]

    def test_writes_rows_under_run_with_provenance_and_marks_the_terminal(self, session):
        counts = write_distil(session, TERMINAL, _payload())
        session.commit()
        assert counts == {"sightings": 1, "verdicts": 1, "gaps": 1, "derived": 1}

        verdict = session.query(EpisodicVerdict).filter_by(investigation_id=str(RUN)).one()
        assert (verdict.investigation_kind, verdict.trust) == ("run", "agent")
        assert verdict.provenance["held"] is True and verdict.provenance["asked"] == "benign"
        marker = session.get(EpisodicDistilMarker, ("run", str(RUN)))
        assert (marker.origin_run_id, marker.origin_seq) == (RUN, 41)
