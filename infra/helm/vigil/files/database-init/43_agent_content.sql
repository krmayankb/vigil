-- What model calls were shown, stored once across every run: system prompts, tasks,
-- tool schemas, skill bodies. A run's frame events name each piece by its hash; the
-- text behind a hash lives here, not on every run's ledger, where the same prompt
-- used to be written once per run and was a third of the ledger's bytes.
--
-- Self-verifying: a row whose text does not hash to its key is refused, so a replay
-- that reads text from here checks exactly what it would have checked on the ledger.
-- Insert-only for the app role. Runs written before this table carry their text as
-- content events on their own ledger, and replay reads both.

CREATE TABLE IF NOT EXISTS agent_content (
    hash       text        PRIMARY KEY,
    text       text        NOT NULL,
    first_seen timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT agent_content_hash_matches
        CHECK (hash = 'sha256:' || encode(sha256(convert_to(text, 'UTF8')), 'hex'))
);

COMMENT ON TABLE agent_content IS
    'Content-addressed text that frame events name by hash; written once across all runs, never updated.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigil_app') THEN
    GRANT SELECT, INSERT ON agent_content TO vigil_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON agent_content FROM vigil_app;
  END IF;
END
$$;
