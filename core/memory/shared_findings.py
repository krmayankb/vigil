"""Settling what runs shared while they worked (``entity_findings``).

Runs publish their claims, observations and conclusions per entity as they write
them, marked ``provisional`` (``services/agent/ledger/publish.ts``). Memory is
where a finding is settled:

- **Final.** Once a run's memory is written, what it shared is no longer in
  progress: its rows become ``final``.
- **Superseded.** When an analyst closes a Case with a determination that
  contradicts what a run on that Case concluded -- the run dismissed it and the
  Case was an attack, or the run called an attack and the Case was a false
  positive -- the run's conclusion is ``superseded``, and a ``retraction`` is
  published on the same entities, so runs still working on them hear it.

Contradiction is kept, never resolved by recency: nothing here deletes or
rewrites what a run said, only marks whether it still stands and why not.

The table is the agent layer's and may be absent where the agent layer is not
deployed; every function here is then a no-op.
"""

from __future__ import annotations

import json
import logging
from typing import Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

# What a run's answer says, against what a Case closure says. A run's
# ``needs_review`` or ``inconclusive`` claimed nothing, so nothing contradicts it.
_DISMISSALS = frozenset({"benign", "false_positive"})
_ESCALATIONS = frozenset({"malicious", "suspicious"})

# Retractions are filed under the run they retract, at a source seq no ledger
# event has, so retracting a run twice files nothing twice.
RETRACTION_SOURCE_SEQ = -1


def _present(session: Session) -> bool:
    return bool(session.execute(text("SELECT to_regclass('entity_findings') IS NOT NULL")).scalar())


def settle_run(session: Session, run_id: str) -> int:
    """Mark what a run shared as final, now that its memory is written."""
    if not _present(session):
        return 0
    result = session.execute(
        text("UPDATE entity_findings SET status = 'final' WHERE run_id = CAST(:run AS uuid) AND status = 'provisional'"),
        {"run": run_id},
    )
    return int(result.rowcount or 0)


def _contradicts(answer: Optional[str], case_outcome: str) -> bool:
    """Whether a Case's determination contradicts a run's answer."""
    if answer is None:
        return False
    if case_outcome == "proven":
        return answer in _DISMISSALS
    if case_outcome == "false_positive":
        return answer in _ESCALATIONS
    return False


def retract_contradicted(session: Session, case_id: str, case_outcome: str, category: str, closed_by: str) -> Dict[str, int]:
    """Supersede the conclusions of runs on this Case that its closure contradicts.

    ``case_outcome`` is the Verdict outcome the Case wrote (``proven`` for an
    attack, ``false_positive``); any other outcome contradicts nothing.
    """
    if case_outcome not in ("proven", "false_positive") or not _present(session):
        return {"superseded": 0, "retractions": 0}

    rows = session.execute(
        text(
            """
            SELECT f.entity_key, f.finding_id, f.run_id, f.statement,
                   f.detail -> 'answer' ->> 'disposition' AS answer
            FROM entity_findings f
            JOIN workflow_runs w ON w.run_id = f.run_id::text
            WHERE w.trigger_context ->> 'case_id' = :case
              AND f.kind = 'conclusion'
              AND f.status <> 'superseded'
            """
        ),
        {"case": case_id},
    ).all()
    contradicted = [row for row in rows if _contradicts(row.answer, case_outcome)]
    if not contradicted:
        return {"superseded": 0, "retractions": 0}

    session.execute(
        text("UPDATE entity_findings SET status = 'superseded' WHERE finding_id = ANY(CAST(:ids AS uuid[]))"),
        {"ids": [str(row.finding_id) for row in contradicted]},
    )

    determination = "an attack" if case_outcome == "proven" else "a false positive"
    retractions = 0
    by_key: Dict[str, List] = {}
    for row in contradicted:
        by_key.setdefault(row.entity_key, []).append(row)
    # The publisher's own lock, per entity and in sorted order, so a retraction
    # takes the entity's next seq exactly as a run's finding would.
    for key in sorted(by_key):
        session.execute(text("SELECT pg_advisory_xact_lock(hashtext(:lock)::bigint)"), {"lock": f"entity_findings:{key}"})
        for row in by_key[key]:
            statement = (
                f"Case {case_id} was closed by {closed_by} as {category} ({determination}). "
                f"Run {row.run_id} concluded {row.answer}; that conclusion does not stand."
            )
            inserted = session.execute(
                text(
                    """
                    INSERT INTO entity_findings
                      (entity_key, seq, run_id, run_kind, source_seq, kind, status, statement, detail, attacker_influenceable, derived_from)
                    SELECT :key, coalesce(max(seq), 0) + 1, CAST(:run AS uuid), 'case', :source_seq, 'retraction', 'final',
                           :statement, CAST(:detail AS jsonb), false, ARRAY[CAST(:finding AS uuid)]
                    FROM entity_findings WHERE entity_key = :key
                    ON CONFLICT (entity_key, run_id, source_seq) DO NOTHING
                    """
                ),
                {
                    "key": key,
                    "run": str(row.run_id),
                    "source_seq": RETRACTION_SOURCE_SEQ,
                    "statement": statement,
                    "detail": json.dumps({"case_id": case_id, "category": category, "case_outcome": case_outcome, "retracted_answer": row.answer}),
                    "finding": str(row.finding_id),
                },
            )
            retractions += int(inserted.rowcount or 0)
    logger.info("Case %s superseded %s shared conclusion(s) of runs on it", case_id, len(contradicted))
    return {"superseded": len(contradicted), "retractions": retractions}
