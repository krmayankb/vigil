-- Retention for the run ledger, which the app role can never delete from
-- (30_vigil_app_role.sql): the append-only guarantee is what makes a ledger
-- evidence. Ageing out is the one exception, and it goes through this function
-- only, so the app can retire runs past retention but never remove a particular
-- one. It deletes whole runs, never part of one: a run whose last event is older
-- than the retention period and that has ended. A run still going, or parked, is
-- kept however old. A retention under 7 days is refused, so a misconfiguration
-- cannot empty the ledger.
--
-- Episodic memory distilled from a retired run stays: what it concluded is
-- memory's; the steps that led there go with the ledger.

CREATE OR REPLACE FUNCTION expire_agent_runs(retention_days integer, batch integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retired uuid[];
BEGIN
  IF retention_days IS NULL OR retention_days < 7 THEN
    RAISE EXCEPTION 'agent run retention of % days is refused; the floor is 7', retention_days;
  END IF;
  SELECT coalesce(array_agg(run_id), ARRAY[]::uuid[]) INTO retired
    FROM (
      SELECT t.run_id
        FROM agent_events t
       WHERE t.kind = 'terminal'
         AND t.ts < now() - make_interval(days => retention_days)
         AND NOT EXISTS (
               SELECT 1 FROM agent_events l
                WHERE l.run_id = t.run_id
                  AND l.ts >= now() - make_interval(days => retention_days))
       GROUP BY t.run_id
       LIMIT greatest(batch, 1)
    ) AS old;
  IF array_length(retired, 1) IS NULL THEN
    RETURN 0;
  END IF;
  DELETE FROM agent_directives WHERE run_id = ANY(retired);
  DELETE FROM agent_run_leases WHERE run_id = ANY(retired);
  DELETE FROM agent_events WHERE run_id = ANY(retired);
  RETURN array_length(retired, 1);
END;
$$;

COMMENT ON FUNCTION expire_agent_runs(integer, integer) IS
    'Deletes whole ended runs whose every event is older than retention_days (floor 7), at most batch per call; returns how many runs. The only delete path the app role has on agent_events.';

REVOKE ALL ON FUNCTION expire_agent_runs(integer, integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vigil_app') THEN
    GRANT EXECUTE ON FUNCTION expire_agent_runs(integer, integer) TO vigil_app;
  END IF;
END
$$;
