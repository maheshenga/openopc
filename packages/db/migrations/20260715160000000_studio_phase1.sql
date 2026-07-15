-- Studio Phase 1 durable model: provider configs, jobs, attempts, events,
-- assets, uploads, credit reservations, and usage attribution.
-- Billing RPC changes land in the follow-up reservation migration.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'studio_job_status'
  ) THEN
    CREATE TYPE kortix.studio_job_status AS ENUM (
      'queued',
      'running',
      'succeeded',
      'failed',
      'cancelled'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'studio_attempt_status'
  ) THEN
    CREATE TYPE kortix.studio_attempt_status AS ENUM (
      'created',
      'submitting',
      'submitted',
      'polling',
      'reconciling',
      'succeeded',
      'failed',
      'cancelled'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS kortix.studio_provider_configs (
  provider_config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  provider text NOT NULL,
  display_name text NOT NULL,
  base_url text,
  region text,
  credential_binding jsonb NOT NULL DEFAULT '{}'::jsonb,
  capability_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_provider_configs_project
  ON kortix.studio_provider_configs(project_id);
CREATE INDEX IF NOT EXISTS idx_studio_provider_configs_account
  ON kortix.studio_provider_configs(account_id);

CREATE TABLE IF NOT EXISTS kortix.studio_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  actor_user_id uuid,
  actor_type text NOT NULL DEFAULT 'user',
  acting_token_id uuid REFERENCES kortix.account_tokens(token_id) ON DELETE SET NULL,
  agent_name text,
  session_id text REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  parent_job_id uuid REFERENCES kortix.studio_jobs(job_id) ON DELETE SET NULL,
  capability text NOT NULL,
  provider_config_id uuid NOT NULL REFERENCES kortix.studio_provider_configs(provider_config_id) ON DELETE RESTRICT,
  provider text NOT NULL,
  model text NOT NULL,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  status kortix.studio_job_status NOT NULL DEFAULT 'queued',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  provider_handle text,
  cancellation_requested_at timestamptz,
  reserved_credits numeric(12,4) NOT NULL DEFAULT 0,
  actual_credits numeric(12,4),
  error_code text,
  error_message text,
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_studio_jobs_account_created
  ON kortix.studio_jobs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_project_created
  ON kortix.studio_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_claimable
  ON kortix.studio_jobs(status, available_at, lease_expires_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_studio_jobs_provider_handle
  ON kortix.studio_jobs(provider, provider_handle);
CREATE INDEX IF NOT EXISTS idx_studio_jobs_parent_job
  ON kortix.studio_jobs(parent_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_jobs_idempotency
  ON kortix.studio_jobs(account_id, idempotency_key);

CREATE TABLE IF NOT EXISTS kortix.studio_job_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  submission_key text NOT NULL,
  provider_request_id text,
  adapter_version text NOT NULL,
  status kortix.studio_attempt_status NOT NULL DEFAULT 'created',
  retry_classification text,
  diagnostic jsonb NOT NULL DEFAULT '{}'::jsonb,
  upstream_usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  upstream_cost_credits numeric(12,4),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_job_attempts_submission_key
  ON kortix.studio_job_attempts(submission_key);
CREATE INDEX IF NOT EXISTS idx_studio_job_attempts_job
  ON kortix.studio_job_attempts(job_id);

CREATE TABLE IF NOT EXISTS kortix.studio_job_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  cursor bigint NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_job_events_job_cursor
  ON kortix.studio_job_events(job_id, cursor);
CREATE INDEX IF NOT EXISTS idx_studio_job_events_created
  ON kortix.studio_job_events(created_at);

CREATE TABLE IF NOT EXISTS kortix.studio_assets (
  asset_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  creator_user_id uuid,
  source_job_id uuid REFERENCES kortix.studio_jobs(job_id) ON DELETE SET NULL,
  kind text NOT NULL,
  mime_type text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  checksum_sha256 text NOT NULL,
  size_bytes bigint NOT NULL,
  width integer,
  height integer,
  duration_ms integer,
  frame_rate numeric(8,3),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  version_parent_asset_id uuid,
  visibility text NOT NULL DEFAULT 'project',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_assets_project_created
  ON kortix.studio_assets(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_assets_source_job
  ON kortix.studio_assets(source_job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_assets_object
  ON kortix.studio_assets(bucket, object_key);

CREATE TABLE IF NOT EXISTS kortix.studio_job_assets (
  job_id uuid NOT NULL REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES kortix.studio_assets(asset_id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz DEFAULT now(),
  PRIMARY KEY (job_id, asset_id, role)
);

CREATE INDEX IF NOT EXISTS idx_studio_job_assets_asset
  ON kortix.studio_job_assets(asset_id);

CREATE TABLE IF NOT EXISTS kortix.studio_asset_uploads (
  upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  actor_user_id uuid,
  object_key text NOT NULL,
  declared_mime_type text NOT NULL,
  expected_size_bytes bigint NOT NULL,
  expected_checksum_sha256 text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  finalized_asset_id uuid REFERENCES kortix.studio_assets(asset_id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_asset_uploads_project
  ON kortix.studio_asset_uploads(project_id);
CREATE INDEX IF NOT EXISTS idx_studio_asset_uploads_expiry
  ON kortix.studio_asset_uploads(expires_at, status);

CREATE TABLE IF NOT EXISTS kortix.studio_credit_reservations (
  reservation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.credit_accounts(account_id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  amount_credits numeric(12,4) NOT NULL,
  status text NOT NULL DEFAULT 'active',
  settlement_key text,
  release_key text,
  expires_at timestamptz NOT NULL,
  settled_at timestamptz,
  released_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_credit_reservations_active_account
  ON kortix.studio_credit_reservations(account_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_credit_reservations_job
  ON kortix.studio_credit_reservations(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_credit_reservations_settlement_key
  ON kortix.studio_credit_reservations(settlement_key)
  WHERE settlement_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_credit_reservations_release_key
  ON kortix.studio_credit_reservations(release_key)
  WHERE release_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.studio_usage_events (
  usage_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  capability text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  upstream_cost_credits numeric(12,4) NOT NULL DEFAULT 0,
  final_cost_credits numeric(12,4) NOT NULL DEFAULT 0,
  ledger_id uuid REFERENCES kortix.credit_ledger(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_studio_usage_events_account_created
  ON kortix.studio_usage_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_usage_events_job
  ON kortix.studio_usage_events(job_id);
