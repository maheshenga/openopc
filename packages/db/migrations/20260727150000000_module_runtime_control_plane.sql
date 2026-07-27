-- Module runtime control plane: descriptors, consent, runners, fenced
-- executions/leases, capability grants, evidence, kill switches, and outbox.
-- Additive and idempotent. Terminal transitions require an active lease match
-- on (lease_id, generation, runner_id).

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_execution_state AS ENUM (
    'pending',
    'awaiting_confirmation',
    'dispatchable',
    'leased',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'unknown'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_runtime_kind AS ENUM (
    'wasi-component',
    'oci-image'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_runner_status AS ENUM (
    'active',
    'draining',
    'quarantined',
    'revoked'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_capability_audience AS ENUM (
    'secret',
    'egress',
    'model',
    'desktop',
    'paid-call'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_kill_switch_scope AS ENUM (
    'account',
    'project',
    'runner'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

DO $module_runtime$
BEGIN
  CREATE TYPE kortix.module_outbox_status AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$module_runtime$;

CREATE TABLE IF NOT EXISTS kortix.module_runtime_descriptors (
  descriptor_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT module_runtime_descriptors_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  release_id uuid NOT NULL,
  runtime_kind kortix.module_runtime_kind NOT NULL,
  descriptor_digest varchar(71) NOT NULL,
  descriptor jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_runtime_descriptors_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_runtime_descriptors_release_account_unique
    UNIQUE (descriptor_id, account_id),
  CONSTRAINT module_runtime_descriptors_account_digest_unique
    UNIQUE (account_id, descriptor_digest),
  CONSTRAINT module_runtime_descriptors_digest_check
    CHECK (descriptor_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_runtime_descriptors_descriptor_check
    CHECK (
      jsonb_typeof(descriptor) = 'object'
      AND pg_column_size(descriptor) <= 262144
    )
);

CREATE INDEX IF NOT EXISTS idx_module_runtime_descriptors_account_release
  ON kortix.module_runtime_descriptors(account_id, release_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.module_runtime_artifacts (
  runtime_artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT module_runtime_artifacts_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  release_id uuid NOT NULL,
  runtime_descriptor_id uuid NOT NULL,
  artifact_digest varchar(71) NOT NULL,
  artifact_bytes bigint NOT NULL,
  media_type varchar(128) NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_runtime_artifacts_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_runtime_artifacts_descriptor_account_fk
    FOREIGN KEY (runtime_descriptor_id, account_id)
    REFERENCES kortix.module_runtime_descriptors(descriptor_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_runtime_artifacts_identity_unique
    UNIQUE (runtime_artifact_id, account_id),
  CONSTRAINT module_runtime_artifacts_release_account_unique
    UNIQUE (release_id, account_id),
  CONSTRAINT module_runtime_artifacts_descriptor_account_unique
    UNIQUE (runtime_descriptor_id, account_id),
  CONSTRAINT module_runtime_artifacts_digest_check
    CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_runtime_artifacts_bytes_check
    CHECK (artifact_bytes BETWEEN 1 AND 33554432),
  CONSTRAINT module_runtime_artifacts_media_type_check
    CHECK (media_type = 'application/wasm')
);

CREATE TABLE IF NOT EXISTS kortix.project_module_consent_revisions (
  consent_revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT project_module_consent_revisions_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  install_revision integer NOT NULL,
  release_id uuid NOT NULL,
  permission_digest varchar(71) NOT NULL,
  permission_snapshot jsonb NOT NULL,
  resource_cpu_millis_ceiling integer NOT NULL,
  resource_memory_mib_ceiling integer NOT NULL,
  resource_wall_time_ms_ceiling integer NOT NULL,
  cost_ceiling_micro integer NOT NULL,
  accepted_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_consent_revisions_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT project_module_consent_revisions_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_consent_revisions_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT project_module_consent_revisions_identity_unique
    UNIQUE (consent_revision_id, account_id, project_id),
  CONSTRAINT project_module_consent_revisions_install_revision_unique
    UNIQUE (installation_id, install_revision),
  CONSTRAINT project_module_consent_revisions_permission_digest_check
    CHECK (permission_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_module_consent_revisions_snapshot_check
    CHECK (
      jsonb_typeof(permission_snapshot) = 'object'
      AND pg_column_size(permission_snapshot) <= 262144
    ),
  CONSTRAINT project_module_consent_revisions_ceilings_check
    CHECK (
      install_revision >= 0
      AND resource_cpu_millis_ceiling > 0
      AND resource_memory_mib_ceiling > 0
      AND resource_wall_time_ms_ceiling > 0
      AND cost_ceiling_micro >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_project_module_consent_revisions_project
  ON kortix.project_module_consent_revisions(account_id, project_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.module_runners (
  runner_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT module_runners_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  node_identity varchar(255) NOT NULL,
  status kortix.module_runner_status NOT NULL DEFAULT 'active',
  software_version varchar(128) NOT NULL,
  attestation_digest varchar(71) NOT NULL,
  certificate_thumbprint varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_runners_runner_account_unique
    UNIQUE (runner_id, account_id),
  CONSTRAINT module_runners_node_identity_unique
    UNIQUE (node_identity),
  CONSTRAINT module_runners_certificate_thumbprint_unique
    UNIQUE (certificate_thumbprint),
  CONSTRAINT module_runners_node_identity_check
    CHECK (
      length(BTRIM(node_identity)) BETWEEN 1 AND 255
      AND BTRIM(node_identity) = node_identity
      AND node_identity !~ '[[:cntrl:]]'
    ),
  CONSTRAINT module_runners_software_version_check
    CHECK (length(BTRIM(software_version)) BETWEEN 1 AND 128),
  CONSTRAINT module_runners_attestation_digest_check
    CHECK (attestation_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_runners_certificate_thumbprint_check
    CHECK (certificate_thumbprint ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_module_runners_account_status
  ON kortix.module_runners(account_id, status, updated_at);

CREATE TABLE IF NOT EXISTS kortix.module_runner_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runner_id uuid NOT NULL,
  account_id uuid NOT NULL,
  profile_name varchar(128) NOT NULL,
  runtime_kind kortix.module_runtime_kind NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_runner_profiles_runner_account_fk
    FOREIGN KEY (runner_id, account_id)
    REFERENCES kortix.module_runners(runner_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_runner_profiles_runner_name_unique
    UNIQUE (runner_id, profile_name),
  CONSTRAINT module_runner_profiles_name_check
    CHECK (
      length(BTRIM(profile_name)) BETWEEN 1 AND 128
      AND BTRIM(profile_name) = profile_name
      AND profile_name !~ '[[:cntrl:]]'
    )
);

CREATE INDEX IF NOT EXISTS idx_module_runner_profiles_account_kind
  ON kortix.module_runner_profiles(account_id, runtime_kind, runner_id);

CREATE TABLE IF NOT EXISTS kortix.module_executions (
  execution_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT module_executions_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  consent_revision_id uuid NOT NULL,
  runtime_descriptor_id uuid NOT NULL,
  runtime_kind kortix.module_runtime_kind NOT NULL,
  runtime_profile varchar(128) NOT NULL,
  state kortix.module_execution_state NOT NULL DEFAULT 'pending',
  idempotency_key varchar(255) NOT NULL,
  work_envelope_digest varchar(71) NOT NULL,
  kill_switch_generation integer NOT NULL DEFAULT 0,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT module_executions_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_executions_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_executions_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_executions_consent_identity_fk
    FOREIGN KEY (consent_revision_id, account_id, project_id)
    REFERENCES kortix.project_module_consent_revisions(consent_revision_id, account_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_executions_descriptor_account_fk
    FOREIGN KEY (runtime_descriptor_id, account_id)
    REFERENCES kortix.module_runtime_descriptors(descriptor_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_executions_identity_unique
    UNIQUE (execution_id, account_id, project_id),
  CONSTRAINT module_executions_project_idempotency_unique
    UNIQUE (project_id, idempotency_key),
  CONSTRAINT module_executions_idempotency_key_check
    CHECK (length(BTRIM(idempotency_key)) BETWEEN 8 AND 255),
  CONSTRAINT module_executions_work_envelope_digest_check
    CHECK (work_envelope_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_executions_kill_switch_generation_check
    CHECK (kill_switch_generation >= 0),
  CONSTRAINT module_executions_terminal_check
    CHECK (
      (
        state IN ('succeeded', 'failed', 'cancelled', 'unknown')
        AND terminal_at IS NOT NULL
      )
      OR (
        state NOT IN ('succeeded', 'failed', 'cancelled', 'unknown')
        AND terminal_at IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_module_executions_account_project_created
  ON kortix.module_executions(account_id, project_id, created_at);
DROP INDEX IF EXISTS kortix.idx_module_executions_claimable;
CREATE INDEX IF NOT EXISTS idx_module_executions_dispatchable_profile
  ON kortix.module_executions(
    account_id,
    state,
    runtime_kind,
    runtime_profile,
    deadline_at,
    created_at,
    execution_id
  )
  WHERE state = 'dispatchable';

CREATE TABLE IF NOT EXISTS kortix.module_execution_inputs (
  execution_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  input_payload bytea NOT NULL,
  input_digest varchar(71) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_inputs_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_inputs_payload_size_check
    CHECK (octet_length(input_payload) <= 262144),
  CONSTRAINT module_execution_inputs_digest_check
    CHECK (input_digest ~ '^sha256:[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS kortix.module_execution_leases (
  lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runner_id uuid NOT NULL,
  generation integer NOT NULL,
  deadline_at timestamptz NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_leases_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_leases_runner_account_fk
    FOREIGN KEY (runner_id, account_id)
    REFERENCES kortix.module_runners(runner_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_execution_leases_lease_identity_unique
    UNIQUE (lease_id, execution_id, account_id, project_id),
  CONSTRAINT module_execution_leases_generation_check
    CHECK (generation >= 1),
  CONSTRAINT module_execution_leases_release_order_check
    CHECK (released_at IS NULL OR released_at >= claimed_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS module_execution_leases_live_execution_unique
  ON kortix.module_execution_leases(execution_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_module_execution_leases_runner_live
  ON kortix.module_execution_leases(runner_id, deadline_at)
  WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS kortix.module_execution_heartbeats (
  heartbeat_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lease_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runner_id uuid NOT NULL,
  generation integer NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_heartbeats_lease_identity_fk
    FOREIGN KEY (lease_id, execution_id, account_id, project_id)
    REFERENCES kortix.module_execution_leases(lease_id, execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_heartbeats_generation_check
    CHECK (generation >= 1)
);

CREATE INDEX IF NOT EXISTS idx_module_execution_heartbeats_lease_observed
  ON kortix.module_execution_heartbeats(lease_id, observed_at);

CREATE TABLE IF NOT EXISTS kortix.module_capability_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  audience kortix.module_capability_audience NOT NULL,
  token_hash varchar(71) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_capability_grants_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_capability_grants_lease_identity_fk
    FOREIGN KEY (lease_id, execution_id, account_id, project_id)
    REFERENCES kortix.module_execution_leases(lease_id, execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_capability_grants_token_hash_unique
    UNIQUE (token_hash),
  CONSTRAINT module_capability_grants_token_hash_check
    CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_capability_grants_revoke_order_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_module_capability_grants_execution
  ON kortix.module_capability_grants(account_id, project_id, execution_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.module_capability_uses (
  use_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL
    CONSTRAINT module_capability_uses_grant_fk
    REFERENCES kortix.module_capability_grants(grant_id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_capability_uses_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_module_capability_uses_grant_observed
  ON kortix.module_capability_uses(grant_id, observed_at);

CREATE TABLE IF NOT EXISTS kortix.module_execution_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  sequence integer NOT NULL,
  event_type varchar(64) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_events_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_events_execution_sequence_unique
    UNIQUE (execution_id, sequence),
  CONSTRAINT module_execution_events_sequence_check
    CHECK (sequence > 0),
  CONSTRAINT module_execution_events_type_check
    CHECK (
      length(BTRIM(event_type)) BETWEEN 1 AND 64
      AND event_type ~ '^[a-z][a-z0-9_]*$'
    ),
  CONSTRAINT module_execution_events_payload_check
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND pg_column_size(payload) <= 262144
    )
);

CREATE INDEX IF NOT EXISTS idx_module_execution_events_execution_created
  ON kortix.module_execution_events(account_id, project_id, execution_id, sequence);

CREATE TABLE IF NOT EXISTS kortix.module_execution_outputs (
  output_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  output_digest varchar(71) NOT NULL,
  size_bytes integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_outputs_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_outputs_execution_digest_unique
    UNIQUE (execution_id, output_digest),
  CONSTRAINT module_execution_outputs_digest_check
    CHECK (output_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_execution_outputs_size_check
    CHECK (size_bytes >= 0 AND size_bytes <= 104857600)
);

CREATE TABLE IF NOT EXISTS kortix.module_execution_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  generation integer NOT NULL,
  runner_id uuid NOT NULL,
  outcome kortix.module_execution_state NOT NULL,
  evidence_digest varchar(71) NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_evidence_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_evidence_lease_identity_fk
    FOREIGN KEY (lease_id, execution_id, account_id, project_id)
    REFERENCES kortix.module_execution_leases(lease_id, execution_id, account_id, project_id)
    ON DELETE RESTRICT,
  CONSTRAINT module_execution_evidence_execution_unique
    UNIQUE (execution_id),
  CONSTRAINT module_execution_evidence_outcome_check
    CHECK (outcome IN ('succeeded', 'failed', 'cancelled', 'unknown')),
  CONSTRAINT module_execution_evidence_generation_check
    CHECK (generation >= 1),
  CONSTRAINT module_execution_evidence_digest_check
    CHECK (evidence_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_execution_evidence_payload_check
    CHECK (
      jsonb_typeof(evidence) = 'object'
      AND pg_column_size(evidence) <= 1048576
    )
);

CREATE TABLE IF NOT EXISTS kortix.module_kill_switch_generations (
  kill_switch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT module_kill_switch_generations_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid,
  runner_id uuid,
  scope kortix.module_kill_switch_scope NOT NULL,
  generation integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  activated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_kill_switch_generations_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_kill_switch_generations_runner_account_fk
    FOREIGN KEY (runner_id, account_id)
    REFERENCES kortix.module_runners(runner_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_kill_switch_generations_generation_check
    CHECK (generation >= 0),
  CONSTRAINT module_kill_switch_generations_scope_check
    CHECK (
      (scope = 'account' AND project_id IS NULL AND runner_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL AND runner_id IS NULL)
      OR (scope = 'runner' AND project_id IS NULL AND runner_id IS NOT NULL)
    ),
  CONSTRAINT module_kill_switch_generations_release_check
    CHECK (active = (released_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS module_kill_switch_generations_account_active_unique
  ON kortix.module_kill_switch_generations(account_id)
  WHERE scope = 'account' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS module_kill_switch_generations_project_active_unique
  ON kortix.module_kill_switch_generations(project_id)
  WHERE scope = 'project' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS module_kill_switch_generations_runner_active_unique
  ON kortix.module_kill_switch_generations(runner_id)
  WHERE scope = 'runner' AND active;

CREATE TABLE IF NOT EXISTS kortix.module_execution_outbox (
  outbox_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  payload jsonb NOT NULL,
  status kortix.module_outbox_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_execution_outbox_execution_identity_fk
    FOREIGN KEY (execution_id, account_id, project_id)
    REFERENCES kortix.module_executions(execution_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT module_execution_outbox_idempotency_unique
    UNIQUE (idempotency_key),
  CONSTRAINT module_execution_outbox_execution_unique
    UNIQUE (execution_id),
  CONSTRAINT module_execution_outbox_idempotency_key_check
    CHECK (length(BTRIM(idempotency_key)) BETWEEN 8 AND 255),
  CONSTRAINT module_execution_outbox_payload_check
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND pg_column_size(payload) <= 262144
    )
);

CREATE INDEX IF NOT EXISTS idx_module_execution_outbox_status_created
  ON kortix.module_execution_outbox(status, created_at, outbox_id);

CREATE OR REPLACE FUNCTION kortix.reject_module_runtime_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% are append-only', TG_TABLE_NAME;
  END IF;
  RAISE EXCEPTION '% are append-only', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER IF EXISTS module_runtime_descriptors_append_only
  ON kortix.module_runtime_descriptors;
CREATE TRIGGER module_runtime_descriptors_append_only
BEFORE UPDATE OR DELETE ON kortix.module_runtime_descriptors
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_runtime_artifacts_append_only
  ON kortix.module_runtime_artifacts;
CREATE TRIGGER module_runtime_artifacts_append_only
BEFORE UPDATE OR DELETE ON kortix.module_runtime_artifacts
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS project_module_consent_revisions_append_only
  ON kortix.project_module_consent_revisions;
CREATE TRIGGER project_module_consent_revisions_append_only
BEFORE UPDATE OR DELETE ON kortix.project_module_consent_revisions
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_execution_inputs_append_only
  ON kortix.module_execution_inputs;
CREATE TRIGGER module_execution_inputs_append_only
BEFORE UPDATE OR DELETE ON kortix.module_execution_inputs
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_execution_events_append_only
  ON kortix.module_execution_events;
CREATE TRIGGER module_execution_events_append_only
BEFORE UPDATE OR DELETE ON kortix.module_execution_events
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_execution_outputs_append_only
  ON kortix.module_execution_outputs;
CREATE TRIGGER module_execution_outputs_append_only
BEFORE UPDATE OR DELETE ON kortix.module_execution_outputs
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_execution_evidence_append_only
  ON kortix.module_execution_evidence;
CREATE TRIGGER module_execution_evidence_append_only
BEFORE UPDATE OR DELETE ON kortix.module_execution_evidence
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_execution_heartbeats_append_only
  ON kortix.module_execution_heartbeats;
CREATE TRIGGER module_execution_heartbeats_append_only
BEFORE UPDATE OR DELETE ON kortix.module_execution_heartbeats
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

DROP TRIGGER IF EXISTS module_capability_uses_append_only
  ON kortix.module_capability_uses;
CREATE TRIGGER module_capability_uses_append_only
BEFORE UPDATE OR DELETE ON kortix.module_capability_uses
FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_runtime_append_only();

CREATE OR REPLACE FUNCTION kortix.protect_module_execution()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'module executions are durable';
  END IF;

  IF ROW(
    NEW.execution_id,
    NEW.account_id,
    NEW.project_id,
    NEW.installation_id,
    NEW.release_id,
    NEW.consent_revision_id,
    NEW.runtime_descriptor_id,
    NEW.runtime_kind,
    NEW.runtime_profile,
    NEW.idempotency_key,
    NEW.work_envelope_digest,
    NEW.kill_switch_generation,
    NEW.deadline_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.execution_id,
    OLD.account_id,
    OLD.project_id,
    OLD.installation_id,
    OLD.release_id,
    OLD.consent_revision_id,
    OLD.runtime_descriptor_id,
    OLD.runtime_kind,
    OLD.runtime_profile,
    OLD.idempotency_key,
    OLD.work_envelope_digest,
    OLD.kill_switch_generation,
    OLD.deadline_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'module execution identity is immutable';
  END IF;

  IF OLD.state IN ('succeeded', 'failed', 'cancelled', 'unknown') THEN
    RAISE EXCEPTION 'terminal module executions are immutable';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state
    AND NEW.state IN ('succeeded', 'failed', 'unknown')
    AND NOT (NEW.state = 'failed' AND OLD.deadline_at <= now())
    AND current_user <> pg_catalog.pg_get_userbyid(
      (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = TG_RELID
      )
    )
  THEN
    RAISE EXCEPTION 'module execution terminal transition requires fenced finalize';
  END IF;

  IF NOT (
    (OLD.state = 'pending' AND NEW.state IN ('pending', 'awaiting_confirmation', 'dispatchable', 'cancelled'))
    OR (OLD.state = 'awaiting_confirmation' AND NEW.state IN ('awaiting_confirmation', 'dispatchable', 'cancelled'))
    OR (OLD.state = 'dispatchable' AND NEW.state IN ('dispatchable', 'leased', 'cancelled'))
    OR (OLD.state = 'leased' AND NEW.state IN ('leased', 'running', 'succeeded', 'failed', 'cancelled', 'unknown', 'dispatchable'))
    OR (OLD.state = 'running' AND NEW.state IN ('running', 'succeeded', 'failed', 'cancelled', 'unknown'))
  ) THEN
    RAISE EXCEPTION 'invalid module execution state transition';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS module_executions_protected
  ON kortix.module_executions;
CREATE TRIGGER module_executions_protected
BEFORE UPDATE OR DELETE ON kortix.module_executions
FOR EACH ROW EXECUTE FUNCTION kortix.protect_module_execution();

CREATE OR REPLACE FUNCTION kortix.protect_module_execution_outbox()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'module_execution_outbox are append-only';
  END IF;

  IF ROW(
    NEW.outbox_id,
    NEW.execution_id,
    NEW.account_id,
    NEW.project_id,
    NEW.idempotency_key,
    NEW.payload,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.outbox_id,
    OLD.execution_id,
    OLD.account_id,
    OLD.project_id,
    OLD.idempotency_key,
    OLD.payload,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'module_execution_outbox are append-only';
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('pending', 'processing', 'failed'))
    OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'completed', 'failed', 'pending'))
    OR (OLD.status = 'failed' AND NEW.status IN ('failed', 'pending', 'processing'))
    OR (OLD.status = 'completed' AND NEW.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'invalid module execution outbox status transition';
  END IF;

  IF OLD.status = 'completed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'module_execution_outbox are append-only';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS module_execution_outbox_protected
  ON kortix.module_execution_outbox;
CREATE TRIGGER module_execution_outbox_protected
BEFORE UPDATE OR DELETE ON kortix.module_execution_outbox
FOR EACH ROW EXECUTE FUNCTION kortix.protect_module_execution_outbox();

DROP FUNCTION IF EXISTS kortix.claim_module_execution(
  uuid, uuid, uuid, uuid, uuid, integer, timestamptz
);

CREATE OR REPLACE FUNCTION kortix.claim_next_module_execution(
  p_account_id uuid,
  p_runner_id uuid
)
RETURNS TABLE (
  lease_id uuid,
  execution_id uuid,
  account_id uuid,
  project_id uuid,
  runner_id uuid,
  generation integer,
  deadline_at timestamptz,
  state kortix.module_execution_state
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_execution kortix.module_executions%ROWTYPE;
  v_runner kortix.module_runners%ROWTYPE;
  v_kill_switch_generation integer;
  v_kill_switch_active boolean;
  v_lease_id uuid;
  v_generation integer;
  v_deadline_at timestamptz;
BEGIN
  SELECT *
  INTO v_runner
  FROM kortix.module_runners AS runner
  WHERE runner.runner_id = p_runner_id
    AND runner.account_id = p_account_id
    AND runner.status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT execution.*
  INTO v_execution
  FROM kortix.module_executions AS execution
  WHERE execution.account_id = p_account_id
    AND execution.state = 'dispatchable'
    AND execution.deadline_at > clock_timestamp()
    AND EXISTS (
      SELECT 1
      FROM kortix.module_runner_profiles AS profile
      WHERE profile.runner_id = p_runner_id
        AND profile.account_id = p_account_id
        AND profile.runtime_kind = execution.runtime_kind
        AND profile.profile_name = execution.runtime_profile
    )
  ORDER BY execution.created_at, execution.execution_id
  FOR UPDATE OF execution SKIP LOCKED
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM kortix.project_module_installations AS installation
  INNER JOIN kortix.developer_module_releases AS module_release
    ON module_release.release_id = installation.active_release_id
   AND module_release.account_id = installation.account_id
  INNER JOIN kortix.project_module_consent_revisions AS consent
    ON consent.consent_revision_id = v_execution.consent_revision_id
   AND consent.installation_id = installation.installation_id
   AND consent.install_revision = installation.install_revision
   AND consent.release_id = installation.active_release_id
   AND consent.account_id = installation.account_id
   AND consent.project_id = installation.project_id
  INNER JOIN kortix.module_runtime_descriptors AS descriptor
    ON descriptor.descriptor_id = v_execution.runtime_descriptor_id
   AND descriptor.release_id = module_release.release_id
   AND descriptor.account_id = module_release.account_id
   AND descriptor.descriptor_digest = module_release.runtime_descriptor_digest
  WHERE installation.installation_id = v_execution.installation_id
    AND installation.account_id = p_account_id
    AND installation.project_id = v_execution.project_id
    AND installation.active_release_id = v_execution.release_id
    AND installation.status = 'active'
    AND module_release.status = 'published'
    AND module_release.revoked_at IS NULL
    AND module_release.signature_payload_digest IS NOT NULL
    AND module_release.verification_policy_digest IS NOT NULL
    AND module_release.signature IS NOT NULL
  FOR SHARE OF installation, module_release, consent, descriptor;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'module execution not found';
  END IF;

  SELECT
    COALESCE(MAX(kill_switch.generation), 0),
    COALESCE(BOOL_OR(kill_switch.active), false)
  INTO v_kill_switch_generation, v_kill_switch_active
  FROM kortix.module_kill_switch_generations AS kill_switch
  WHERE kill_switch.account_id = p_account_id
    AND (
      kill_switch.scope = 'account'
      OR (
        kill_switch.scope = 'project'
        AND kill_switch.project_id = v_execution.project_id
      )
    );

  IF v_kill_switch_active
    OR v_kill_switch_generation <> v_execution.kill_switch_generation
    OR EXISTS (
      SELECT 1
      FROM kortix.module_kill_switch_generations AS kill_switch
      WHERE kill_switch.account_id = p_account_id
        AND kill_switch.scope = 'runner'
        AND kill_switch.runner_id = p_runner_id
        AND kill_switch.active
    )
  THEN
    RAISE EXCEPTION 'module execution not found';
  END IF;

  SELECT COALESCE(MAX(lease_row.generation), 0) + 1
  INTO v_generation
  FROM kortix.module_execution_leases AS lease_row
  WHERE lease_row.execution_id = v_execution.execution_id;

  v_lease_id := gen_random_uuid();
  v_deadline_at := LEAST(
    clock_timestamp() + interval '30 seconds',
    v_execution.deadline_at
  );

  INSERT INTO kortix.module_execution_leases (
    lease_id,
    execution_id,
    account_id,
    project_id,
    runner_id,
    generation,
    deadline_at
  ) VALUES (
    v_lease_id,
    v_execution.execution_id,
    p_account_id,
    v_execution.project_id,
    p_runner_id,
    v_generation,
    v_deadline_at
  );

  UPDATE kortix.module_executions AS execution
  SET state = 'leased'
  WHERE execution.execution_id = v_execution.execution_id
    AND execution.account_id = p_account_id
    AND execution.project_id = v_execution.project_id;

  INSERT INTO kortix.module_execution_events (
    execution_id,
    account_id,
    project_id,
    sequence,
    event_type,
    payload
  ) VALUES (
    v_execution.execution_id,
    p_account_id,
    v_execution.project_id,
    (
      SELECT COALESCE(MAX(event.sequence), 0) + 1
      FROM kortix.module_execution_events AS event
      WHERE event.execution_id = v_execution.execution_id
    ),
    'execution_claimed',
    jsonb_build_object('lease_id', v_lease_id, 'generation', v_generation)
  );

  RETURN QUERY
  SELECT
    v_lease_id,
    v_execution.execution_id,
    p_account_id,
    v_execution.project_id,
    p_runner_id,
    v_generation,
    v_deadline_at,
    'leased'::kortix.module_execution_state;
END;
$$;

DROP FUNCTION IF EXISTS kortix.heartbeat_module_execution(
  uuid, uuid, uuid, uuid, integer, uuid, timestamptz
);

CREATE OR REPLACE FUNCTION kortix.heartbeat_module_execution(
  p_account_id uuid,
  p_project_id uuid,
  p_execution_id uuid,
  p_lease_id uuid,
  p_generation integer,
  p_runner_id uuid
)
RETURNS TABLE (
  lease_id uuid,
  execution_id uuid,
  generation integer,
  deadline_at timestamptz,
  state kortix.module_execution_state
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_lease kortix.module_execution_leases%ROWTYPE;
  v_execution kortix.module_executions%ROWTYPE;
  v_observed_at timestamptz;
  v_deadline timestamptz;
BEGIN
  SELECT *
  INTO v_execution
  FROM kortix.module_executions AS execution
  WHERE execution.execution_id = p_execution_id
    AND execution.account_id = p_account_id
    AND execution.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'module execution lease not found';
  END IF;

  SELECT *
  INTO v_lease
  FROM kortix.module_execution_leases AS lease
  WHERE lease.lease_id = p_lease_id
    AND lease.execution_id = p_execution_id
    AND lease.account_id = p_account_id
    AND lease.project_id = p_project_id
    AND lease.runner_id = p_runner_id
    AND lease.generation = p_generation
    AND lease.released_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'module execution lease not found';
  END IF;

  IF v_execution.state NOT IN ('leased', 'running') THEN
    RAISE EXCEPTION 'module execution not found';
  END IF;

  v_observed_at := clock_timestamp();

  IF v_lease.deadline_at <= v_observed_at THEN
    RAISE EXCEPTION 'module execution lease not found';
  END IF;

  IF v_execution.deadline_at <= v_observed_at THEN
    RAISE EXCEPTION 'module execution not found';
  END IF;

  v_deadline := LEAST(
    v_observed_at + interval '30 seconds',
    v_execution.deadline_at
  );

  UPDATE kortix.module_execution_leases AS lease
  SET deadline_at = v_deadline
  WHERE lease.lease_id = p_lease_id
    AND lease.account_id = p_account_id
    AND lease.project_id = p_project_id
    AND lease.execution_id = p_execution_id
    AND lease.generation = p_generation
    AND lease.runner_id = p_runner_id
    AND lease.released_at IS NULL;

  IF v_execution.state = 'leased' THEN
    UPDATE kortix.module_executions AS execution
    SET state = 'running'
    WHERE execution.execution_id = p_execution_id
      AND execution.account_id = p_account_id
      AND execution.project_id = p_project_id;
    v_execution.state := 'running';
  END IF;

  INSERT INTO kortix.module_execution_heartbeats (
    lease_id,
    execution_id,
    account_id,
    project_id,
    runner_id,
    generation,
    observed_at
  ) VALUES (
    p_lease_id,
    p_execution_id,
    p_account_id,
    p_project_id,
    p_runner_id,
    p_generation,
    v_observed_at
  );

  RETURN QUERY
  SELECT
    p_lease_id,
    p_execution_id,
    p_generation,
    v_deadline,
    v_execution.state;
END;
$$;

CREATE OR REPLACE FUNCTION kortix.finalize_module_execution(
  p_account_id uuid,
  p_project_id uuid,
  p_execution_id uuid,
  p_lease_id uuid,
  p_generation integer,
  p_runner_id uuid,
  p_outcome kortix.module_execution_state,
  p_evidence_digest varchar,
  p_evidence jsonb,
  p_outbox_idempotency_key varchar,
  p_outbox_payload jsonb
)
RETURNS TABLE (
  execution_id uuid,
  state kortix.module_execution_state,
  evidence_id uuid,
  outbox_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, kortix
AS $$
DECLARE
  v_lease kortix.module_execution_leases%ROWTYPE;
  v_execution kortix.module_executions%ROWTYPE;
  v_evidence_id uuid;
  v_outbox_id uuid;
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'cancelled', 'unknown') THEN
    RAISE EXCEPTION 'module execution outcome is invalid';
  END IF;
  IF p_evidence_digest IS NULL OR p_evidence_digest !~ '^sha256:[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'module execution evidence digest is invalid';
  END IF;
  IF p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
    RAISE EXCEPTION 'module execution evidence is invalid';
  END IF;
  IF p_outbox_idempotency_key IS NULL OR length(BTRIM(p_outbox_idempotency_key)) < 8 THEN
    RAISE EXCEPTION 'module execution outbox idempotency key is invalid';
  END IF;
  IF p_outbox_payload IS NULL OR jsonb_typeof(p_outbox_payload) <> 'object' THEN
    RAISE EXCEPTION 'module execution outbox payload is invalid';
  END IF;

  SELECT *
  INTO v_execution
  FROM kortix.module_executions AS execution
  WHERE execution.execution_id = p_execution_id
    AND execution.account_id = p_account_id
    AND execution.project_id = p_project_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Stale generation / wrong fence tuple / cross-tenant all look like absence.
    RAISE EXCEPTION 'module execution lease not found or stale generation';
  END IF;

  SELECT *
  INTO v_lease
  FROM kortix.module_execution_leases AS lease
  WHERE lease.lease_id = p_lease_id
    AND lease.execution_id = p_execution_id
    AND lease.account_id = p_account_id
    AND lease.project_id = p_project_id
    AND lease.runner_id = p_runner_id
    AND lease.generation = p_generation
    AND lease.released_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'module execution lease not found or stale generation';
  END IF;

  IF v_execution.state NOT IN ('leased', 'running') THEN
    RAISE EXCEPTION 'module execution not found';
  END IF;
  IF v_lease.deadline_at <= now() OR v_execution.deadline_at <= now() THEN
    RAISE EXCEPTION 'module execution lease not found or stale deadline';
  END IF;

  UPDATE kortix.module_execution_leases AS lease
  SET released_at = now()
  WHERE lease.lease_id = p_lease_id
    AND lease.execution_id = p_execution_id
    AND lease.account_id = p_account_id
    AND lease.project_id = p_project_id
    AND lease.runner_id = p_runner_id
    AND lease.generation = p_generation
    AND lease.released_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'module execution lease not found or stale generation';
  END IF;

  UPDATE kortix.module_executions AS execution
  SET
    state = p_outcome,
    terminal_at = now()
  WHERE execution.execution_id = p_execution_id
    AND execution.account_id = p_account_id
    AND execution.project_id = p_project_id;

  INSERT INTO kortix.module_execution_evidence (
    execution_id,
    account_id,
    project_id,
    lease_id,
    generation,
    runner_id,
    outcome,
    evidence_digest,
    evidence
  ) VALUES (
    p_execution_id,
    p_account_id,
    p_project_id,
    p_lease_id,
    p_generation,
    p_runner_id,
    p_outcome,
    p_evidence_digest,
    p_evidence
  )
  RETURNING module_execution_evidence.evidence_id INTO v_evidence_id;

  INSERT INTO kortix.module_execution_outbox (
    execution_id,
    account_id,
    project_id,
    idempotency_key,
    payload,
    status
  ) VALUES (
    p_execution_id,
    p_account_id,
    p_project_id,
    p_outbox_idempotency_key,
    p_outbox_payload,
    'pending'
  )
  RETURNING module_execution_outbox.outbox_id INTO v_outbox_id;

  UPDATE kortix.module_capability_grants AS grant_row
  SET revoked_at = COALESCE(revoked_at, now())
  WHERE grant_row.execution_id = p_execution_id
    AND grant_row.account_id = p_account_id
    AND grant_row.project_id = p_project_id
    AND grant_row.revoked_at IS NULL;

  RETURN QUERY
  SELECT
    p_execution_id,
    p_outcome,
    v_evidence_id,
    v_outbox_id;
END;
$$;

REVOKE ALL
  ON TABLE
    kortix.module_runtime_descriptors,
    kortix.module_runtime_artifacts,
    kortix.project_module_consent_revisions,
    kortix.module_runners,
    kortix.module_runner_profiles,
    kortix.module_executions,
    kortix.module_execution_inputs,
    kortix.module_execution_leases,
    kortix.module_execution_heartbeats,
    kortix.module_capability_grants,
    kortix.module_capability_uses,
    kortix.module_execution_events,
    kortix.module_execution_outputs,
    kortix.module_execution_evidence,
    kortix.module_kill_switch_generations,
    kortix.module_execution_outbox
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL
  ON FUNCTION
    kortix.claim_next_module_execution(uuid, uuid),
    kortix.heartbeat_module_execution(uuid, uuid, uuid, uuid, integer, uuid),
    kortix.finalize_module_execution(
      uuid, uuid, uuid, uuid, integer, uuid,
      kortix.module_execution_state, varchar, jsonb, varchar, jsonb
    ),
    kortix.reject_module_runtime_append_only(),
    kortix.protect_module_execution(),
    kortix.protect_module_execution_outbox()
  FROM PUBLIC, anon, authenticated, service_role;
