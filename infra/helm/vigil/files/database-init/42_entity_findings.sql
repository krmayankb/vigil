-- What runs have found about each entity, shared with every other run while it is
-- still in flight (fleet plan, phase 3). Append-only: a finding is never edited,
-- only superseded or retracted by a later one.
--
-- seq is per entity, taken under an advisory lock on the entity for the length of
-- the inserting transaction, so a reader that has seen up to seq N of an entity has
-- seen every row below it -- a reader asking "what is newer than N" misses nothing.
-- One row per entity per source ledger event (the unique index), so a publish that
-- is retried writes nothing twice.
CREATE TABLE IF NOT EXISTS entity_findings (
    entity_key             text        NOT NULL,
    seq                    bigint      NOT NULL,
    finding_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
    run_id                 uuid        NOT NULL,
    run_kind               text        NOT NULL,
    source_seq             integer     NOT NULL,
    kind                   text        NOT NULL CHECK (kind IN ('claim', 'observation', 'conclusion', 'retraction')),
    status                 text        NOT NULL DEFAULT 'provisional' CHECK (status IN ('provisional', 'final', 'superseded')),
    statement              text        NOT NULL,
    detail                 jsonb       NOT NULL DEFAULT '{}'::jsonb,
    attacker_influenceable boolean     NOT NULL DEFAULT true,
    derived_from           uuid[]      NOT NULL DEFAULT '{}',
    recorded_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_key, seq)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_entity_findings_source
    ON entity_findings (entity_key, run_id, source_seq);

CREATE INDEX IF NOT EXISTS idx_entity_findings_run
    ON entity_findings (run_id);

CREATE INDEX IF NOT EXISTS idx_entity_findings_recorded
    ON entity_findings (recorded_at);

COMMENT ON TABLE entity_findings IS
    'Findings runs have published about entities, read by other runs mid-flight. Provisional until the post-run distil confirms or supersedes them.';

COMMENT ON COLUMN entity_findings.attacker_influenceable IS
    'True when the finding carries text from a tool result, which an attacker may have written. A reader treats it as data, never as instruction.';

COMMENT ON COLUMN entity_findings.derived_from IS
    'Findings of other runs this one was built on, so a reader counts one observation once however many runs repeat it.';

-- Event time beside record time: when the run saw what it shared (the ledger
-- event's own time), where recorded_at is when the shared table got it.
ALTER TABLE entity_findings ADD COLUMN IF NOT EXISTS observed_at timestamptz;
