-- Phase 3.6: replaces the dead setInterval monitoring scheduler
-- (rejected in Phase 3.1 -- state lived in-process, reset on every
-- deploy) with an external-scheduler-driven design. This table backs
-- the idempotency-key check for POST /api/v1/scheduled/monitoring: a
-- retried or duplicate invocation with the same key returns the cached
-- result instead of re-running the cycle.
--
-- Not an audit-integrity table like pcm_agent_activity (Phase 3.5) --
-- this is operational bookkeeping the app fully owns and manages,
-- ordinary pcm_app ownership is appropriate.

CREATE TABLE IF NOT EXISTS pcm_monitoring_runs (
  idempotency_key text PRIMARY KEY,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','error')),
  results         jsonb,
  started_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pcm_monitoring_runs_started ON pcm_monitoring_runs (started_at DESC);
