-- Persist immutable SBOM object coordinates and bind passing verification evidence
-- to the release in the same fenced transaction that terminates the run.

ALTER TABLE kortix.developer_module_verification_runs
  ADD COLUMN IF NOT EXISTS sbom_storage_key text,
  ADD COLUMN IF NOT EXISTS sbom_size_bytes bigint;

DO $developer_trust_evidence_reset$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM kortix.developer_module_verification_runs
    WHERE state = 'passed'
      AND (sbom_storage_key IS NULL OR sbom_size_bytes IS NULL)
  ) THEN
    RAISE EXCEPTION 'OPENOPC_DEVELOPER_TRUST_EVIDENCE_RESET_REQUIRED';
  END IF;
END
$developer_trust_evidence_reset$;

ALTER TABLE kortix.developer_module_verification_runs
  DROP CONSTRAINT IF EXISTS developer_module_verification_runs_sbom_reference_check;
ALTER TABLE kortix.developer_module_verification_runs
  ADD CONSTRAINT developer_module_verification_runs_sbom_reference_check
  CHECK (
    (
      sbom_storage_key IS NULL
      AND sbom_size_bytes IS NULL
    )
    OR (
      sbom_storage_key IS NOT NULL
      AND sbom_size_bytes IS NOT NULL
      AND octet_length(sbom_storage_key) BETWEEN 1 AND 2048
      AND sbom_storage_key !~ '[[:cntrl:]]'
      AND sbom_storage_key NOT LIKE '/%'
      AND position(E'\\' in sbom_storage_key) = 0
      AND NOT ('..' = ANY(string_to_array(sbom_storage_key, '/')))
      AND sbom_size_bytes BETWEEN 1 AND 16777216
    )
  );

ALTER TABLE kortix.developer_module_verification_runs
  DROP CONSTRAINT IF EXISTS developer_module_verification_runs_passed_evidence_check;
ALTER TABLE kortix.developer_module_verification_runs
  ADD CONSTRAINT developer_module_verification_runs_passed_evidence_check
  CHECK (
    state <> 'passed'
    OR (
      sbom_digest IS NOT NULL
      AND sbom_digest ~ '^sha256:[0-9a-f]{64}$'
      AND sbom_storage_key IS NOT NULL
      AND sbom_size_bytes IS NOT NULL
      AND sbom_size_bytes BETWEEN 1 AND 16777216
      AND attestation_digest IS NOT NULL
      AND attestation_digest ~ '^sha256:[0-9a-f]{64}$'
    )
  );

CREATE OR REPLACE FUNCTION kortix.protect_developer_module_verification_run()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM kortix.developer_module_releases
      WHERE release_id = OLD.release_id
        AND account_id = OLD.account_id
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'developer module verification runs are durable';
  END IF;

  IF ROW(
    NEW.release_id,
    NEW.artifact_id,
    NEW.account_id,
    NEW.policy_digest,
    NEW.scanner_set_digest,
    NEW.sandbox_profile_digest,
    NEW.attempt,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.release_id,
    OLD.artifact_id,
    OLD.account_id,
    OLD.policy_digest,
    OLD.scanner_set_digest,
    OLD.sandbox_profile_digest,
    OLD.attempt,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'developer module verification run identity is immutable';
  END IF;

  IF OLD.state IN ('passed', 'failed', 'inconclusive', 'cancelled') THEN
    RAISE EXCEPTION 'terminal developer module verification runs are immutable';
  END IF;

  IF OLD.state = 'running' AND NEW.state = 'running' THEN
    IF ROW(
      NEW.terminal_reason,
      NEW.sbom_digest,
      NEW.sbom_storage_key,
      NEW.sbom_size_bytes,
      NEW.attestation_digest,
      NEW.resource_summary,
      NEW.started_at,
      NEW.finished_at
    ) IS DISTINCT FROM ROW(
      OLD.terminal_reason,
      OLD.sbom_digest,
      OLD.sbom_storage_key,
      OLD.sbom_size_bytes,
      OLD.attestation_digest,
      OLD.resource_summary,
      OLD.started_at,
      OLD.finished_at
    ) THEN
      RAISE EXCEPTION 'running developer module verification runs only accept lease heartbeat updates';
    END IF;
  END IF;

  IF NOT (
    (OLD.state = 'queued' AND NEW.state IN ('queued', 'running', 'cancelled'))
    OR (
      OLD.state = 'running'
      AND NEW.state IN ('running', 'passed', 'failed', 'inconclusive', 'cancelled')
    )
  ) THEN
    RAISE EXCEPTION 'invalid developer module verification state transition';
  END IF;
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

GRANT UPDATE (sbom_storage_key, sbom_size_bytes)
  ON TABLE kortix.developer_module_verification_runs
  TO service_role, developer_trust_worker;

GRANT UPDATE (
  sbom_digest,
  trust_attestation_digest,
  verification_policy_digest
)
  ON TABLE kortix.developer_module_releases
  TO developer_trust_worker;
