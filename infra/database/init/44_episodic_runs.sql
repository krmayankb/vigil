-- Memory from every agent run, not only hunts. A kernel run (an investigation, a
-- root-cause trace) is distilled as investigation_kind 'run', keyed by its run id;
-- like a hunt it names the terminal it was derived from.
--
-- Every row also carries how it came to be (provenance): the plugin and run kind,
-- how the run ended, what its review said, the answer it gave against the one that
-- stood, whether it rested on other runs' findings, and the model. Recall returns it,
-- so what memory is trusted for can be tuned later without re-distilling.
--
-- 26 and 29 spell the same vocabularies for a new database; this widens an existing one.

ALTER TABLE episodic_sightings DROP CONSTRAINT IF EXISTS episodic_sightings_investigation_kind_check;
ALTER TABLE episodic_sightings ADD CONSTRAINT episodic_sightings_investigation_kind_check
    CHECK (investigation_kind IN ('hunt', 'case', 'analyst', 'run'));
ALTER TABLE episodic_verdicts DROP CONSTRAINT IF EXISTS episodic_verdicts_investigation_kind_check;
ALTER TABLE episodic_verdicts ADD CONSTRAINT episodic_verdicts_investigation_kind_check
    CHECK (investigation_kind IN ('hunt', 'case', 'analyst', 'run'));
ALTER TABLE episodic_gaps DROP CONSTRAINT IF EXISTS episodic_gaps_investigation_kind_check;
ALTER TABLE episodic_gaps ADD CONSTRAINT episodic_gaps_investigation_kind_check
    CHECK (investigation_kind IN ('hunt', 'case', 'analyst', 'run'));
ALTER TABLE episodic_distil_markers DROP CONSTRAINT IF EXISTS episodic_distil_markers_investigation_kind_check;
ALTER TABLE episodic_distil_markers ADD CONSTRAINT episodic_distil_markers_investigation_kind_check
    CHECK (investigation_kind IN ('hunt', 'case', 'analyst', 'run'));
ALTER TABLE episodic_distil_failures DROP CONSTRAINT IF EXISTS episodic_distil_failures_investigation_kind_check;
ALTER TABLE episodic_distil_failures ADD CONSTRAINT episodic_distil_failures_investigation_kind_check
    CHECK (investigation_kind IN ('hunt', 'case', 'analyst', 'run'));

ALTER TABLE episodic_distil_markers DROP CONSTRAINT IF EXISTS episodic_distil_markers_origin_matches_kind;
ALTER TABLE episodic_distil_markers ADD CONSTRAINT episodic_distil_markers_origin_matches_kind CHECK (
    (investigation_kind IN ('hunt', 'run')) = (origin_run_id IS NOT NULL)
    AND (origin_run_id IS NULL) = (origin_seq IS NULL)
);
ALTER TABLE episodic_distil_failures DROP CONSTRAINT IF EXISTS episodic_distil_failures_seq_matches_kind;
ALTER TABLE episodic_distil_failures ADD CONSTRAINT episodic_distil_failures_seq_matches_kind CHECK (
    (investigation_kind IN ('hunt', 'run')) = (origin_seq IS NOT NULL)
);

ALTER TABLE episodic_sightings ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE episodic_verdicts  ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE episodic_gaps      ADD COLUMN IF NOT EXISTS provenance jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN episodic_verdicts.provenance IS
    'How the row came to be: plugin, run kind and outcome, review stance, the answer given and the one that stood, whether it rested on other runs, model. Empty on rows written before it existed.';
