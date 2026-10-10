-- Which queue a run belongs on: "human" for work a person is waiting on, else
-- "automated". Set by the run's first claim and never changed, so the watchdog
-- resumes a parked or crashed run in the lane it started in.
ALTER TABLE agent_run_leases ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'automated';

COMMENT ON COLUMN agent_run_leases.lane IS
    'human or automated: the queue a resume of this run is enqueued on. Set on the first claim only.';
