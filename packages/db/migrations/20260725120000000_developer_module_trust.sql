DO $developer_trust$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM kortix.developer_module_releases
    WHERE status IN ('signed', 'published')
       OR signature_payload_digest IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'OPENOPC_DEVELOPER_TRUST_RESET_REQUIRED: schema-1 signed or published developer releases are unsupported; reset the development database before applying this migration';
  END IF;
END
$developer_trust$;

DO $developer_trust$
BEGIN
  CREATE TYPE kortix.developer_artifact_upload_state AS ENUM (
    'created',
    'uploaded',
    'finalized',
    'cancelled',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_trust$;

DO $developer_trust$
BEGIN
  CREATE TYPE kortix.developer_verification_state AS ENUM (
    'queued',
    'running',
    'passed',
    'failed',
    'inconclusive',
    'cancelled'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_trust$;

DO $developer_trust$
BEGIN
  CREATE TYPE kortix.developer_finding_severity AS ENUM (
    'info',
    'low',
    'medium',
    'high',
    'critical'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_trust$;

CREATE TABLE IF NOT EXISTS kortix.developer_module_artifact_uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  state kortix.developer_artifact_upload_state NOT NULL DEFAULT 'created',
  expected_digest varchar(71) NOT NULL,
  expected_size bigint NOT NULL,
  staging_storage_key text NOT NULL,
  artifact_id uuid,
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_artifact_uploads_upload_account_unique
    UNIQUE (upload_id, account_id),
  CONSTRAINT developer_module_artifact_uploads_publisher_account_fk
    FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_module_artifact_uploads_digest_check
    CHECK (expected_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT developer_module_artifact_uploads_size_check
    CHECK (expected_size BETWEEN 1 AND 536870912),
  CONSTRAINT developer_module_artifact_uploads_storage_key_check
    CHECK (octet_length(staging_storage_key) BETWEEN 1 AND 2048),
  CONSTRAINT developer_module_artifact_uploads_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT developer_module_artifact_uploads_finalized_artifact_check
    CHECK (
      (state = 'finalized' AND artifact_id IS NOT NULL)
      OR (state <> 'finalized' AND artifact_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_artifact_uploads_account_state_expiry
  ON kortix.developer_module_artifact_uploads(account_id, state, expires_at);

CREATE TABLE IF NOT EXISTS kortix.developer_module_artifacts (
  artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  artifact_digest varchar(71) NOT NULL,
  envelope_digest varchar(71) NOT NULL,
  storage_key text NOT NULL,
  media_type varchar(128) NOT NULL,
  size_bytes bigint NOT NULL,
  item_snapshot jsonb NOT NULL,
  source_provenance jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_artifacts_artifact_account_unique
    UNIQUE (artifact_id, account_id),
  CONSTRAINT developer_module_artifacts_account_digest_unique
    UNIQUE (account_id, artifact_digest),
  CONSTRAINT developer_module_artifacts_publisher_account_fk
    FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_module_artifacts_digest_check
    CHECK (
      artifact_digest ~ '^sha256:[0-9a-f]{64}$'
      AND envelope_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT developer_module_artifacts_media_type_check
    CHECK (media_type = 'application/vnd.openopc.developer-module.v2+json'),
  CONSTRAINT developer_module_artifacts_size_check
    CHECK (size_bytes BETWEEN 1 AND 536870912),
  CONSTRAINT developer_module_artifacts_storage_key_check
    CHECK (octet_length(storage_key) BETWEEN 1 AND 2048),
  CONSTRAINT developer_module_artifacts_item_snapshot_check
    CHECK (
      jsonb_typeof(item_snapshot) = 'object'
      AND pg_column_size(item_snapshot) <= 1048576
    ),
  CONSTRAINT developer_module_artifacts_source_provenance_check
    CHECK (
      source_provenance IS NULL
      OR (
        jsonb_typeof(source_provenance) = 'object'
        AND pg_column_size(source_provenance) <= 16384
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_artifacts_account_created
  ON kortix.developer_module_artifacts(account_id, created_at, artifact_id);

ALTER TABLE kortix.developer_module_artifact_uploads
  ADD COLUMN IF NOT EXISTS artifact_id uuid;

DO $developer_trust$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_artifact_uploads_artifact_account_fk'
      AND conrelid = 'kortix.developer_module_artifact_uploads'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_artifact_uploads
      ADD CONSTRAINT developer_module_artifact_uploads_artifact_account_fk
      FOREIGN KEY (artifact_id, account_id)
      REFERENCES kortix.developer_module_artifacts(artifact_id, account_id)
      ON DELETE RESTRICT;
  END IF;
END
$developer_trust$;

ALTER TABLE kortix.developer_module_releases
  ADD COLUMN IF NOT EXISTS artifact_id uuid,
  ADD COLUMN IF NOT EXISTS artifact_digest varchar(71),
  ADD COLUMN IF NOT EXISTS sbom_digest varchar(71),
  ADD COLUMN IF NOT EXISTS trust_attestation_digest varchar(71),
  ADD COLUMN IF NOT EXISTS verification_policy_digest varchar(71);

DO $developer_trust$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_artifact_account_fk'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_artifact_account_fk
      FOREIGN KEY (artifact_id, account_id)
      REFERENCES kortix.developer_module_artifacts(artifact_id, account_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_release_account_artifact_unique'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_release_account_artifact_unique
      UNIQUE (release_id, account_id, artifact_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_artifact_digest_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_artifact_digest_check
      CHECK (
        (artifact_id IS NULL AND artifact_digest IS NULL)
        OR (
          artifact_id IS NOT NULL
          AND artifact_digest ~ '^sha256:[0-9a-f]{64}$'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_trust_before_distribution_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_trust_before_distribution_check
      CHECK (
        status NOT IN ('signed', 'published')
        OR (
          artifact_id IS NOT NULL
          AND artifact_digest ~ '^sha256:[0-9a-f]{64}$'
          AND sbom_digest ~ '^sha256:[0-9a-f]{64}$'
          AND trust_attestation_digest ~ '^sha256:[0-9a-f]{64}$'
          AND verification_policy_digest ~ '^sha256:[0-9a-f]{64}$'
        )
      );
  END IF;
END
$developer_trust$;

CREATE OR REPLACE FUNCTION kortix.developer_module_review_evidence_valid(
  input_evidence jsonb
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT
    jsonb_typeof(input_evidence) = 'array'
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input_evidence) AS entries(item)
      WHERE jsonb_typeof(item) <> 'object'
        OR item ->> 'outcome' IS DISTINCT FROM 'passed'
        OR item ->> 'requirement' IS NULL
        OR item ->> 'requirement' NOT IN (
          'source_scan',
          'sandbox_test',
          'manifest_review',
          'permission_review',
          'desktop_security_review',
          'human_review'
        )
        OR (
          item ->> 'requirement' IN ('source_scan', 'sandbox_test')
          AND (
            item ->> 'method' IS DISTINCT FROM 'system_attestation'
            OR item ->> 'run_id' IS NULL
            OR item ->> 'run_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            OR item ->> 'evidence_digest' IS NULL
            OR item ->> 'evidence_digest' !~ '^sha256:[0-9a-f]{64}$'
            OR item ->> 'policy_digest' IS NULL
            OR item ->> 'policy_digest' !~ '^sha256:[0-9a-f]{64}$'
            OR item ?| ARRAY['summary', 'observed_at', 'tool', 'tool_version']
          )
        )
        OR (
          item ->> 'requirement' IN (
            'manifest_review',
            'permission_review',
            'desktop_security_review',
            'human_review'
          )
          AND (
            item ->> 'method' IS DISTINCT FROM 'manual'
            OR item ->> 'summary' IS NULL
            OR length(BTRIM(item ->> 'summary')) NOT BETWEEN 1 AND 1000
            OR octet_length(item ->> 'summary') > 2048
            OR item ->> 'observed_at' IS NULL
            OR item ?| ARRAY['run_id', 'evidence_digest', 'policy_digest']
          )
        )
    )
    AND (
      SELECT COUNT(*) = COUNT(DISTINCT item ->> 'requirement')
      FROM jsonb_array_elements(input_evidence) AS entries(item)
    );
$$;

ALTER TABLE kortix.developer_module_release_review_events
  DROP CONSTRAINT IF EXISTS developer_module_release_review_events_evidence_check;
ALTER TABLE kortix.developer_module_release_review_events
  ADD CONSTRAINT developer_module_release_review_events_evidence_check
  CHECK (
    jsonb_typeof(evidence) = 'array'
    AND jsonb_array_length(evidence) <= 16
    AND pg_column_size(evidence) <= 32768
    AND kortix.developer_module_review_evidence_valid(evidence)
    AND (
      (action = 'approve' AND jsonb_array_length(evidence) BETWEEN 2 AND 16)
      OR (action <> 'approve' AND jsonb_array_length(evidence) = 0)
    )
  );

CREATE TABLE IF NOT EXISTS kortix.developer_module_verification_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL,
  artifact_id uuid NOT NULL,
  account_id uuid NOT NULL,
  policy_digest varchar(71) NOT NULL,
  scanner_set_digest varchar(71) NOT NULL,
  sandbox_profile_digest varchar(71) NOT NULL,
  attempt integer NOT NULL,
  state kortix.developer_verification_state NOT NULL DEFAULT 'queued',
  lease_owner varchar(128),
  lease_token_hash varchar(71),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  terminal_reason varchar(256),
  sbom_digest varchar(71),
  attestation_digest varchar(71),
  resource_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_verification_runs_run_account_unique
    UNIQUE (run_id, account_id),
  CONSTRAINT developer_module_verification_runs_release_policy_attempt_unique
    UNIQUE (release_id, policy_digest, attempt),
  CONSTRAINT developer_module_verification_runs_release_account_fk
    FOREIGN KEY (release_id, account_id, artifact_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id, artifact_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_verification_runs_artifact_account_fk
    FOREIGN KEY (artifact_id, account_id)
    REFERENCES kortix.developer_module_artifacts(artifact_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_module_verification_runs_digest_check
    CHECK (
      policy_digest ~ '^sha256:[0-9a-f]{64}$'
      AND scanner_set_digest ~ '^sha256:[0-9a-f]{64}$'
      AND sandbox_profile_digest ~ '^sha256:[0-9a-f]{64}$'
      AND (sbom_digest IS NULL OR sbom_digest ~ '^sha256:[0-9a-f]{64}$')
      AND (
        attestation_digest IS NULL
        OR attestation_digest ~ '^sha256:[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT developer_module_verification_runs_attempt_check
    CHECK (attempt > 0),
  CONSTRAINT developer_module_verification_runs_lease_check
    CHECK (
      (
        state = 'running'
        AND lease_owner IS NOT NULL
        AND lease_token_hash ~ '^sha256:[0-9a-f]{64}$'
        AND lease_expires_at IS NOT NULL
        AND heartbeat_at IS NOT NULL
        AND started_at IS NOT NULL
      )
      OR state <> 'running'
    ),
  CONSTRAINT developer_module_verification_runs_terminal_check
    CHECK (
      (
        state IN ('passed', 'failed', 'inconclusive', 'cancelled')
        AND terminal_reason IS NOT NULL
        AND finished_at IS NOT NULL
      )
      OR state IN ('queued', 'running')
    ),
  CONSTRAINT developer_module_verification_runs_passed_evidence_check
    CHECK (
      state <> 'passed'
      OR (
        sbom_digest ~ '^sha256:[0-9a-f]{64}$'
        AND attestation_digest ~ '^sha256:[0-9a-f]{64}$'
      )
    ),
  CONSTRAINT developer_module_verification_runs_resource_summary_check
    CHECK (
      jsonb_typeof(resource_summary) = 'object'
      AND pg_column_size(resource_summary) <= 32768
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_module_verification_runs_active_unique
  ON kortix.developer_module_verification_runs(release_id, policy_digest)
  WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_developer_module_verification_runs_claim
  ON kortix.developer_module_verification_runs(state, created_at, run_id);
CREATE INDEX IF NOT EXISTS idx_developer_module_verification_runs_lease_expiry
  ON kortix.developer_module_verification_runs(lease_expires_at)
  WHERE state = 'running';
CREATE INDEX IF NOT EXISTS idx_developer_module_verification_runs_account_release_attempt
  ON kortix.developer_module_verification_runs(account_id, release_id, attempt DESC);

CREATE TABLE IF NOT EXISTS kortix.developer_module_verification_findings (
  finding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  account_id uuid NOT NULL,
  fingerprint varchar(71) NOT NULL,
  scanner varchar(128) NOT NULL,
  rule_id varchar(256) NOT NULL,
  severity kortix.developer_finding_severity NOT NULL,
  path text,
  location jsonb,
  summary text NOT NULL,
  disposition varchar(32) NOT NULL DEFAULT 'blocking',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_verification_findings_run_account_fk
    FOREIGN KEY (run_id, account_id)
    REFERENCES kortix.developer_module_verification_runs(run_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_verification_findings_run_fingerprint_unique
    UNIQUE (run_id, fingerprint),
  CONSTRAINT developer_module_verification_findings_fingerprint_check
    CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT developer_module_verification_findings_scanner_rule_check
    CHECK (
      length(BTRIM(scanner)) BETWEEN 1 AND 128
      AND length(BTRIM(rule_id)) BETWEEN 1 AND 256
    ),
  CONSTRAINT developer_module_verification_findings_path_check
    CHECK (path IS NULL OR octet_length(path) BETWEEN 1 AND 2048),
  CONSTRAINT developer_module_verification_findings_location_check
    CHECK (
      location IS NULL
      OR (
        jsonb_typeof(location) = 'object'
        AND pg_column_size(location) <= 4096
      )
    ),
  CONSTRAINT developer_module_verification_findings_summary_check
    CHECK (
      length(BTRIM(summary)) BETWEEN 1 AND 2000
      AND octet_length(summary) <= 4096
    ),
  CONSTRAINT developer_module_verification_findings_disposition_check
    CHECK (disposition IN ('blocking', 'observed'))
);

CREATE INDEX IF NOT EXISTS idx_developer_module_verification_findings_account_run_severity
  ON kortix.developer_module_verification_findings(account_id, run_id, severity);

CREATE TABLE IF NOT EXISTS kortix.developer_module_trust_attestations (
  attestation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  account_id uuid NOT NULL,
  attestation_digest varchar(71) NOT NULL,
  subject_artifact_digest varchar(71) NOT NULL,
  predicate_type varchar(256) NOT NULL,
  policy_digest varchar(71) NOT NULL,
  result kortix.developer_verification_state NOT NULL,
  sbom_digest varchar(71) NOT NULL,
  dsse_envelope jsonb NOT NULL,
  issuer varchar(256) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_trust_attestations_run_account_fk
    FOREIGN KEY (run_id, account_id)
    REFERENCES kortix.developer_module_verification_runs(run_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_trust_attestations_run_digest_unique
    UNIQUE (run_id, attestation_digest),
  CONSTRAINT developer_module_trust_attestations_digest_check
    CHECK (
      attestation_digest ~ '^sha256:[0-9a-f]{64}$'
      AND subject_artifact_digest ~ '^sha256:[0-9a-f]{64}$'
      AND policy_digest ~ '^sha256:[0-9a-f]{64}$'
      AND sbom_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT developer_module_trust_attestations_result_check
    CHECK (result IN ('passed', 'failed', 'inconclusive', 'cancelled')),
  CONSTRAINT developer_module_trust_attestations_predicate_check
    CHECK (
      length(BTRIM(predicate_type)) BETWEEN 1 AND 256
      AND predicate_type LIKE 'https://%'
    ),
  CONSTRAINT developer_module_trust_attestations_dsse_check
    CHECK (
      jsonb_typeof(dsse_envelope) = 'object'
      AND pg_column_size(dsse_envelope) <= 1048576
    ),
  CONSTRAINT developer_module_trust_attestations_issuer_check
    CHECK (length(BTRIM(issuer)) BETWEEN 1 AND 256)
);

CREATE INDEX IF NOT EXISTS idx_developer_module_trust_attestations_account_run
  ON kortix.developer_module_trust_attestations(account_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.developer_module_verification_capabilities (
  capability_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  account_id uuid NOT NULL,
  sandbox_instance_id varchar(128) NOT NULL,
  audience varchar(128) NOT NULL,
  token_hash varchar(71) NOT NULL,
  nonce_hash varchar(71) NOT NULL,
  allowed_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  max_calls integer NOT NULL,
  calls_used integer NOT NULL DEFAULT 0,
  max_payload_bytes bigint NOT NULL,
  payload_bytes_used bigint NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_verification_capabilities_run_account_fk
    FOREIGN KEY (run_id, account_id)
    REFERENCES kortix.developer_module_verification_runs(run_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_verification_capabilities_run_sandbox_unique
    UNIQUE (run_id, sandbox_instance_id),
  CONSTRAINT developer_module_verification_capabilities_hash_check
    CHECK (
      token_hash ~ '^sha256:[0-9a-f]{64}$'
      AND nonce_hash ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT developer_module_verification_capabilities_identity_check
    CHECK (
      length(BTRIM(sandbox_instance_id)) BETWEEN 1 AND 128
      AND length(BTRIM(audience)) BETWEEN 1 AND 128
    ),
  CONSTRAINT developer_module_verification_capabilities_actions_check
    CHECK (
      jsonb_typeof(allowed_actions) = 'array'
      AND jsonb_array_length(allowed_actions) <= 128
      AND pg_column_size(allowed_actions) <= 16384
    ),
  CONSTRAINT developer_module_verification_capabilities_usage_check
    CHECK (
      max_calls BETWEEN 1 AND 10000
      AND calls_used BETWEEN 0 AND max_calls
      AND max_payload_bytes BETWEEN 1 AND 104857600
      AND payload_bytes_used BETWEEN 0 AND max_payload_bytes
    ),
  CONSTRAINT developer_module_verification_capabilities_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_developer_module_verification_capabilities_token_hash
  ON kortix.developer_module_verification_capabilities(token_hash)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_developer_module_verification_capabilities_expiry
  ON kortix.developer_module_verification_capabilities(expires_at)
  WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION kortix.reject_developer_module_artifact_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM kortix.accounts WHERE account_id = OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'developer module artifacts are append-only';
END;
$$;

DROP TRIGGER IF EXISTS developer_module_artifacts_append_only
  ON kortix.developer_module_artifacts;
CREATE TRIGGER developer_module_artifacts_append_only
BEFORE UPDATE OR DELETE ON kortix.developer_module_artifacts
FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_module_artifact_mutation();

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
      NEW.attestation_digest,
      NEW.resource_summary,
      NEW.started_at,
      NEW.finished_at
    ) IS DISTINCT FROM ROW(
      OLD.terminal_reason,
      OLD.sbom_digest,
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

DROP TRIGGER IF EXISTS developer_module_verification_runs_protected
  ON kortix.developer_module_verification_runs;
CREATE TRIGGER developer_module_verification_runs_protected
BEFORE UPDATE OR DELETE ON kortix.developer_module_verification_runs
FOR EACH ROW EXECUTE FUNCTION kortix.protect_developer_module_verification_run();

CREATE OR REPLACE FUNCTION kortix.reject_developer_module_verification_finding_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1
    FROM kortix.developer_module_verification_runs
    WHERE run_id = OLD.run_id
      AND account_id = OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'developer module verification findings are append-only';
END;
$$;

DROP TRIGGER IF EXISTS developer_module_verification_findings_append_only
  ON kortix.developer_module_verification_findings;
CREATE TRIGGER developer_module_verification_findings_append_only
BEFORE UPDATE OR DELETE ON kortix.developer_module_verification_findings
FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_module_verification_finding_mutation();

CREATE OR REPLACE FUNCTION kortix.reject_developer_module_trust_attestation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1
    FROM kortix.developer_module_verification_runs
    WHERE run_id = OLD.run_id
      AND account_id = OLD.account_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'developer module trust attestations are append-only';
END;
$$;

DROP TRIGGER IF EXISTS developer_module_trust_attestations_append_only
  ON kortix.developer_module_trust_attestations;
CREATE TRIGGER developer_module_trust_attestations_append_only
BEFORE UPDATE OR DELETE ON kortix.developer_module_trust_attestations
FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_module_trust_attestation_mutation();

CREATE OR REPLACE FUNCTION kortix.protect_developer_module_release_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.account_id,
    NEW.publisher_id,
    NEW.item_name,
    NEW.module_id,
    NEW.module_version,
    NEW.manifest,
    NEW.manifest_digest,
    NEW.review_requirements,
    NEW.artifact_id,
    NEW.artifact_digest,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.account_id,
    OLD.publisher_id,
    OLD.item_name,
    OLD.module_id,
    OLD.module_version,
    OLD.manifest,
    OLD.manifest_digest,
    OLD.review_requirements,
    OLD.artifact_id,
    OLD.artifact_digest,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'developer module release content is immutable';
  END IF;

  IF ROW(
    NEW.sbom_digest,
    NEW.trust_attestation_digest,
    NEW.verification_policy_digest
  ) IS DISTINCT FROM ROW(
    OLD.sbom_digest,
    OLD.trust_attestation_digest,
    OLD.verification_policy_digest
  ) AND OLD.status IN ('signed', 'published', 'revoked', 'deprecated') THEN
    RAISE EXCEPTION 'developer module release trust binding is immutable after signing';
  END IF;

  IF ROW(
    NEW.signature_algorithm,
    NEW.signature_key_id,
    NEW.signature,
    NEW.signature_payload_digest,
    NEW.signed_at
  ) IS DISTINCT FROM ROW(
    OLD.signature_algorithm,
    OLD.signature_key_id,
    OLD.signature,
    OLD.signature_payload_digest,
    OLD.signed_at
  ) AND NOT (
    OLD.status = 'approved'
    AND NEW.status = 'signed'
  ) THEN
    RAISE EXCEPTION 'developer module signature may only change during signing';
  END IF;

  IF NEW.published_at IS DISTINCT FROM OLD.published_at
    AND NOT (OLD.status = 'signed' AND NEW.status = 'published') THEN
    RAISE EXCEPTION 'developer module publication timestamp may only change during distribution';
  END IF;

  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    AND NOT (
      OLD.status IN ('signed', 'published')
      AND NEW.status = 'revoked'
    ) THEN
    RAISE EXCEPTION 'developer module revocation timestamp may only change during revocation';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS developer_module_releases_content_immutable
  ON kortix.developer_module_releases;
CREATE TRIGGER developer_module_releases_content_immutable
BEFORE UPDATE ON kortix.developer_module_releases
FOR EACH ROW EXECUTE FUNCTION kortix.protect_developer_module_release_content();

DO $developer_trust_role$
BEGIN
  CREATE ROLE developer_trust_worker NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_trust_role$;

REVOKE ALL
  ON TABLE
    kortix.developer_module_artifact_uploads,
    kortix.developer_module_artifacts,
    kortix.developer_module_verification_runs,
    kortix.developer_module_verification_findings,
    kortix.developer_module_trust_attestations,
    kortix.developer_module_verification_capabilities
  FROM PUBLIC, anon, authenticated, service_role, developer_trust_worker;

GRANT SELECT, INSERT
  ON TABLE
    kortix.developer_module_artifact_uploads,
    kortix.developer_module_artifacts,
    kortix.developer_module_verification_runs
  TO service_role;

GRANT UPDATE (state, artifact_id, updated_at)
  ON TABLE kortix.developer_module_artifact_uploads
  TO service_role;

GRANT UPDATE (
  state,
  lease_owner,
  lease_token_hash,
  lease_expires_at,
  heartbeat_at,
  terminal_reason,
  sbom_digest,
  attestation_digest,
  resource_summary,
  started_at,
  finished_at,
  updated_at
)
  ON TABLE kortix.developer_module_verification_runs
  TO service_role;

GRANT SELECT
  ON TABLE
    kortix.developer_module_verification_findings,
    kortix.developer_module_trust_attestations,
    kortix.developer_module_verification_capabilities
  TO service_role;

GRANT INSERT
  ON TABLE kortix.developer_module_verification_capabilities
  TO service_role;

GRANT UPDATE (
  calls_used,
  payload_bytes_used,
  revoked_at,
  updated_at
)
  ON TABLE kortix.developer_module_verification_capabilities
  TO service_role;

REVOKE UPDATE (
  status,
  review_revision,
  signature_algorithm,
  signature_key_id,
  signature,
  signature_payload_digest,
  signed_at,
  published_at,
  revoked_at,
  updated_at
)
  ON TABLE kortix.developer_module_releases
  FROM service_role;

GRANT UPDATE (
  status,
  review_revision,
  sbom_digest,
  trust_attestation_digest,
  verification_policy_digest,
  signature_algorithm,
  signature_key_id,
  signature,
  signature_payload_digest,
  signed_at,
  published_at,
  revoked_at,
  updated_at
)
  ON TABLE kortix.developer_module_releases
  TO service_role;

GRANT USAGE ON SCHEMA kortix TO developer_trust_worker;
GRANT SELECT
  ON TABLE
    kortix.developer_module_releases,
    kortix.developer_module_artifacts,
    kortix.developer_module_verification_runs,
    kortix.developer_module_verification_capabilities
  TO developer_trust_worker;
GRANT UPDATE (
  state,
  lease_owner,
  lease_token_hash,
  lease_expires_at,
  heartbeat_at,
  terminal_reason,
  sbom_digest,
  attestation_digest,
  resource_summary,
  started_at,
  finished_at,
  updated_at
)
  ON TABLE kortix.developer_module_verification_runs
  TO developer_trust_worker;
GRANT INSERT
  ON TABLE
    kortix.developer_module_verification_findings,
    kortix.developer_module_trust_attestations,
    kortix.developer_module_verification_capabilities
  TO developer_trust_worker;
GRANT UPDATE (
  calls_used,
  payload_bytes_used,
  revoked_at,
  updated_at
)
  ON TABLE kortix.developer_module_verification_capabilities
  TO developer_trust_worker;

REVOKE ALL
  ON FUNCTION
    kortix.reject_developer_module_artifact_mutation(),
    kortix.protect_developer_module_verification_run(),
    kortix.reject_developer_module_verification_finding_mutation(),
    kortix.reject_developer_module_trust_attestation_mutation(),
    kortix.protect_developer_module_release_content()
  FROM PUBLIC, anon, authenticated, service_role, developer_trust_worker;
