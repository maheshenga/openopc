ALTER TABLE kortix.developer_module_artifact_uploads
  ADD COLUMN IF NOT EXISTS staging_deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleanup_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleanup_last_error varchar(1024);

ALTER TABLE kortix.developer_module_artifact_uploads
  DROP CONSTRAINT IF EXISTS developer_module_artifact_uploads_cleanup_attempts_check;
ALTER TABLE kortix.developer_module_artifact_uploads
  ADD CONSTRAINT developer_module_artifact_uploads_cleanup_attempts_check
  CHECK (cleanup_attempts >= 0);

ALTER TABLE kortix.developer_module_artifact_uploads
  DROP CONSTRAINT IF EXISTS developer_module_artifact_uploads_cleanup_error_check;
ALTER TABLE kortix.developer_module_artifact_uploads
  ADD CONSTRAINT developer_module_artifact_uploads_cleanup_error_check
  CHECK (
    cleanup_last_error IS NULL
    OR (
      length(BTRIM(cleanup_last_error)) BETWEEN 1 AND 1024
      AND cleanup_last_error !~ '[[:cntrl:]]'
    )
  );

ALTER TABLE kortix.developer_module_artifact_uploads
  DROP CONSTRAINT IF EXISTS developer_module_artifact_uploads_cleanup_state_check;
ALTER TABLE kortix.developer_module_artifact_uploads
  ADD CONSTRAINT developer_module_artifact_uploads_cleanup_state_check
  CHECK (
    staging_deleted_at IS NULL
    OR (
      cleanup_next_attempt_at IS NULL
      AND cleanup_last_error IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_developer_module_artifact_uploads_cleanup_due
  ON kortix.developer_module_artifact_uploads(
    cleanup_next_attempt_at,
    expires_at,
    upload_id
  )
  WHERE staging_deleted_at IS NULL;

DO $developer_artifact_retention$
BEGIN
  CREATE TYPE kortix.developer_artifact_retention_run_state AS ENUM (
    'queued',
    'running',
    'succeeded',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_artifact_retention$;

CREATE TABLE IF NOT EXISTS kortix.developer_artifact_retention_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acceptance_run_id varchar(128),
  state kortix.developer_artifact_retention_run_state NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  cursor varchar(2048),
  last_error varchar(1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT developer_artifact_retention_runs_acceptance_run_id_check
    CHECK (
      acceptance_run_id IS NULL
      OR acceptance_run_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    ),
  CONSTRAINT developer_artifact_retention_runs_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT developer_artifact_retention_runs_cursor_check
    CHECK (
      cursor IS NULL
      OR (
        octet_length(cursor) BETWEEN 1 AND 2048
        AND BTRIM(cursor) = cursor
        AND cursor !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT developer_artifact_retention_runs_error_check
    CHECK (
      last_error IS NULL
      OR (
        length(BTRIM(last_error)) BETWEEN 1 AND 1024
        AND last_error !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT developer_artifact_retention_runs_lease_owner_check
    CHECK (
      lease_owner IS NULL
      OR (
        length(BTRIM(lease_owner)) BETWEEN 1 AND 128
        AND BTRIM(lease_owner) = lease_owner
        AND lease_owner !~ '[[:cntrl:]]'
      )
    ),
  CONSTRAINT developer_artifact_retention_runs_state_check
    CHECK (
      (
        state = 'queued'
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
        AND finished_at IS NULL
      )
      OR (
        state = 'running'
        AND lease_owner IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND finished_at IS NULL
      )
      OR (
        state = 'succeeded'
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
        AND finished_at IS NOT NULL
        AND last_error IS NULL
      )
      OR (
        state = 'failed'
        AND lease_owner IS NULL
        AND lease_expires_at IS NULL
        AND finished_at IS NOT NULL
        AND last_error IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS developer_artifact_retention_runs_acceptance_unique
  ON kortix.developer_artifact_retention_runs(acceptance_run_id)
  WHERE acceptance_run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS developer_artifact_retention_runs_scheduled_active_unique
  ON kortix.developer_artifact_retention_runs((1))
  WHERE acceptance_run_id IS NULL
    AND state IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_developer_artifact_retention_runs_claim
  ON kortix.developer_artifact_retention_runs(
    state,
    available_at,
    lease_expires_at,
    created_at,
    run_id
  );

CREATE OR REPLACE FUNCTION kortix.protect_developer_artifact_retention_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'developer artifact retention runs are durable';
  END IF;

  IF ROW(NEW.run_id, NEW.acceptance_run_id, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.run_id, OLD.acceptance_run_id, OLD.created_at)
  THEN
    RAISE EXCEPTION 'developer artifact retention run identity is immutable';
  END IF;

  IF OLD.state IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'terminal developer artifact retention runs are immutable';
  END IF;

  IF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('queued', 'running'))
    OR (OLD.state = 'running' AND NEW.state IN ('queued', 'running', 'succeeded', 'failed'))
  ) THEN
    RAISE EXCEPTION 'invalid developer artifact retention state transition';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS developer_artifact_retention_runs_protected
  ON kortix.developer_artifact_retention_runs;
CREATE TRIGGER developer_artifact_retention_runs_protected
BEFORE UPDATE OR DELETE ON kortix.developer_artifact_retention_runs
FOR EACH ROW EXECUTE FUNCTION kortix.protect_developer_artifact_retention_run();

DO $developer_artifact_retention_role$
BEGIN
  CREATE ROLE developer_artifact_retention_worker NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_artifact_retention_role$;

REVOKE ALL
  ON TABLE kortix.developer_artifact_retention_runs
  FROM PUBLIC, anon, authenticated, service_role, developer_trust_worker,
    developer_artifact_retention_worker;

GRANT SELECT, INSERT
  ON TABLE kortix.developer_artifact_retention_runs
  TO service_role, developer_artifact_retention_worker;

GRANT UPDATE (
  state,
  attempts,
  available_at,
  lease_owner,
  lease_expires_at,
  cursor,
  last_error,
  updated_at,
  finished_at
)
  ON TABLE kortix.developer_artifact_retention_runs
  TO service_role, developer_artifact_retention_worker;

REVOKE ALL
  ON TABLE kortix.developer_module_artifact_uploads
  FROM developer_artifact_retention_worker;

GRANT SELECT
  ON TABLE kortix.developer_module_artifact_uploads
  TO developer_artifact_retention_worker;

GRANT UPDATE (
  state,
  staging_deleted_at,
  cleanup_attempts,
  cleanup_next_attempt_at,
  cleanup_last_error,
  updated_at
)
  ON TABLE kortix.developer_module_artifact_uploads
  TO service_role, developer_artifact_retention_worker;

GRANT USAGE ON SCHEMA kortix TO developer_artifact_retention_worker;

REVOKE ALL
  ON FUNCTION kortix.protect_developer_artifact_retention_run()
  FROM PUBLIC, anon, authenticated, service_role, developer_trust_worker,
    developer_artifact_retention_worker;
