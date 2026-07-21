DO $automation$
BEGIN
  CREATE TYPE kortix.automation_execution_domain AS ENUM ('browser', 'desktop');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_risk AS ENUM ('observe', 'operate', 'external_effect');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_job_status AS ENUM (
    'queued',
    'awaiting_approval',
    'dispatched',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'expired',
    'retryable'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_step_status AS ENUM (
    'pending',
    'awaiting_approval',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'skipped'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_approval_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired',
    'consumed'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_approval_policy AS ENUM ('project-default', 'full-access');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_browser_profile_status AS ENUM (
    'active',
    'revoked',
    'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

DO $automation$
BEGIN
  CREATE TYPE kortix.automation_kill_switch_scope AS ENUM ('account', 'project', 'device');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

CREATE TABLE IF NOT EXISTS kortix.automation_policies (
  project_id uuid PRIMARY KEY
    CONSTRAINT automation_policies_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  allowed_origins jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_network_allowed boolean NOT NULL DEFAULT false,
  persistent_profiles_allowed boolean NOT NULL DEFAULT false,
  full_access_allowed boolean NOT NULL DEFAULT false,
  default_approval_policy kortix.automation_approval_policy NOT NULL DEFAULT 'project-default',
  policy_version varchar(128) NOT NULL DEFAULT '1',
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_policies_allowed_origins_check
    CHECK (
      jsonb_typeof(allowed_origins) = 'array'
      AND jsonb_array_length(allowed_origins) <= 64
      AND pg_column_size(allowed_origins) <= 131072
    ),
  CONSTRAINT automation_policies_version_check
    CHECK (length(BTRIM(policy_version)) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_automation_policies_updated
  ON kortix.automation_policies(updated_at);

CREATE TABLE IF NOT EXISTS kortix.automation_browser_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL
    CONSTRAINT automation_browser_profiles_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  encrypted_state_ref text NOT NULL,
  state_hash varchar(71) NOT NULL,
  status kortix.automation_browser_profile_status NOT NULL DEFAULT 'active',
  created_by uuid NOT NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_browser_profiles_project_profile_unique
    UNIQUE (project_id, profile_id),
  CONSTRAINT automation_browser_profiles_state_check
    CHECK (
      encrypted_state_ref ~ '^sealed:[A-Za-z0-9][A-Za-z0-9._:/-]*$'
      AND length(encrypted_state_ref) <= 2048
      AND state_hash ~ '^sha256:[0-9a-f]{64}$'
      AND (
        (status = 'active' AND revoked_at IS NULL)
        OR (status = 'revoked' AND revoked_at IS NOT NULL)
        OR (status = 'expired' AND revoked_at IS NULL AND expires_at IS NOT NULL)
      )
      AND (expires_at IS NULL OR expires_at > created_at)
    )
);

CREATE INDEX IF NOT EXISTS idx_automation_browser_profiles_project_status
  ON kortix.automation_browser_profiles(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_automation_browser_profiles_expiry
  ON kortix.automation_browser_profiles(expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

CREATE TABLE IF NOT EXISTS kortix.automation_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT automation_jobs_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT automation_jobs_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL,
  source_run_id uuid,
  protocol_version varchar(64) NOT NULL DEFAULT 'automation.v1',
  execution_domain kortix.automation_execution_domain NOT NULL,
  request_envelope jsonb NOT NULL,
  request_hash varchar(71) NOT NULL,
  idempotency_key varchar(255) NOT NULL,
  status kortix.automation_job_status NOT NULL DEFAULT 'queued',
  approval_policy kortix.automation_approval_policy NOT NULL DEFAULT 'project-default',
  policy_snapshot_hash varchar(71) NOT NULL,
  browser_profile_id uuid,
  target_device_id uuid,
  lease_owner varchar(128),
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  kill_switch_generation bigint NOT NULL DEFAULT 0,
  deadline_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT automation_jobs_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_jobs_project_profile_fk
    FOREIGN KEY (project_id, browser_profile_id)
    REFERENCES kortix.automation_browser_profiles(project_id, profile_id) ON DELETE RESTRICT,
  CONSTRAINT automation_jobs_project_idempotency_unique
    UNIQUE (project_id, idempotency_key),
  CONSTRAINT automation_jobs_protocol_version_check
    CHECK (protocol_version = 'automation.v1'),
  CONSTRAINT automation_jobs_request_envelope_check
    CHECK (
      jsonb_typeof(request_envelope) = 'object'
      AND pg_column_size(request_envelope) <= 1048576
    ),
  CONSTRAINT automation_jobs_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT automation_jobs_policy_snapshot_hash_check
    CHECK (policy_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT automation_jobs_idempotency_key_check
    CHECK (length(BTRIM(idempotency_key)) BETWEEN 16 AND 255),
  CONSTRAINT automation_jobs_lease_pair_check
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_owner IS NOT NULL
        AND BTRIM(lease_owner) <> ''
        AND lease_expires_at IS NOT NULL
      )
    ),
  CONSTRAINT automation_jobs_target_check
    CHECK (
      (execution_domain = 'browser' AND target_device_id IS NULL)
      OR (
        execution_domain = 'desktop'
        AND browser_profile_id IS NULL
        AND target_device_id IS NOT NULL
      )
    ),
  CONSTRAINT automation_jobs_kill_switch_generation_check
    CHECK (kill_switch_generation >= 0),
  CONSTRAINT automation_jobs_terminal_check
    CHECK (
      (status IN ('succeeded', 'failed', 'cancelled', 'expired'))
      = (terminal_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_automation_jobs_account_created
  ON kortix.automation_jobs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_project_created
  ON kortix.automation_jobs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_jobs_claimable
  ON kortix.automation_jobs(status, lease_expires_at, deadline_at, created_at)
  WHERE status IN ('queued', 'retryable', 'dispatched', 'running');
CREATE INDEX IF NOT EXISTS idx_automation_jobs_browser_profile
  ON kortix.automation_jobs(project_id, browser_profile_id)
  WHERE browser_profile_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_automation_jobs_target_device
  ON kortix.automation_jobs(target_device_id, status, created_at)
  WHERE target_device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.automation_job_steps (
  step_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL
    CONSTRAINT automation_job_steps_job_fk
    REFERENCES kortix.automation_jobs(job_id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  action varchar(128) NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk kortix.automation_risk NOT NULL,
  action_hash varchar(71) NOT NULL,
  status kortix.automation_step_status NOT NULL DEFAULT 'pending',
  approval_id uuid,
  started_at timestamptz,
  ended_at timestamptz,
  result_ref text,
  error_code varchar(128),
  CONSTRAINT automation_job_steps_job_step_unique UNIQUE (job_id, step_id),
  CONSTRAINT automation_job_steps_job_sequence_unique UNIQUE (job_id, sequence),
  CONSTRAINT automation_job_steps_sequence_positive_check CHECK (sequence > 0),
  CONSTRAINT automation_job_steps_action_check
    CHECK (action ~ '^[A-Za-z][A-Za-z0-9]*(?:[._:-][A-Za-z0-9]+)*$'),
  CONSTRAINT automation_job_steps_args_check
    CHECK (jsonb_typeof(args) = 'object' AND pg_column_size(args) <= 262144),
  CONSTRAINT automation_job_steps_action_hash_check
    CHECK (action_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT automation_job_steps_timing_check
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE INDEX IF NOT EXISTS idx_automation_job_steps_job_status
  ON kortix.automation_job_steps(job_id, status, sequence);
CREATE INDEX IF NOT EXISTS idx_automation_job_steps_approval
  ON kortix.automation_job_steps(approval_id)
  WHERE approval_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.automation_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL
    CONSTRAINT automation_approvals_job_fk
    REFERENCES kortix.automation_jobs(job_id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  action_hash varchar(71) NOT NULL,
  status kortix.automation_approval_status NOT NULL DEFAULT 'pending',
  acting_user_id uuid,
  token_hash varchar(71),
  expires_at timestamptz NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_approvals_job_step_fk
    FOREIGN KEY (job_id, step_id)
    REFERENCES kortix.automation_job_steps(job_id, step_id) ON DELETE CASCADE,
  CONSTRAINT automation_approvals_action_hash_check
    CHECK (action_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT automation_approvals_token_hash_check
    CHECK (token_hash IS NULL OR token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT automation_approvals_resolution_check
    CHECK (
      (
        status = 'pending'
        AND acting_user_id IS NULL
        AND token_hash IS NULL
        AND resolved_at IS NULL
      ) OR (
        status IN ('approved', 'consumed')
        AND acting_user_id IS NOT NULL
        AND token_hash IS NOT NULL
        AND resolved_at IS NOT NULL
      ) OR (
        status = 'rejected'
        AND acting_user_id IS NOT NULL
        AND token_hash IS NULL
        AND resolved_at IS NOT NULL
      ) OR (
        status = 'expired'
        AND acting_user_id IS NULL
        AND token_hash IS NULL
        AND resolved_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_automation_approvals_job_status
  ON kortix.automation_approvals(job_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_approvals_job_step
  ON kortix.automation_approvals(job_id, step_id);
CREATE INDEX IF NOT EXISTS idx_automation_approvals_expiry
  ON kortix.automation_approvals(expires_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS kortix.automation_job_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL
    CONSTRAINT automation_job_events_job_fk
    REFERENCES kortix.automation_jobs(job_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  type varchar(64) NOT NULL,
  status kortix.automation_job_status,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id varchar(32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_job_events_job_sequence_unique UNIQUE (job_id, sequence),
  CONSTRAINT automation_job_events_sequence_positive_check CHECK (sequence > 0),
  CONSTRAINT automation_job_events_type_check
    CHECK (
      type IN (
        'job_queued', 'approval_required', 'job_dispatched', 'job_started',
        'step_started', 'step_completed', 'job_succeeded', 'job_failed',
        'job_cancelled', 'job_expired', 'kill_switch_activated', 'heartbeat'
      )
    ),
  CONSTRAINT automation_job_events_payload_check
    CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 262144),
  CONSTRAINT automation_job_events_trace_id_check
    CHECK (trace_id IS NULL OR trace_id ~ '^[0-9a-f]{32}$')
);

CREATE INDEX IF NOT EXISTS idx_automation_job_events_job_created
  ON kortix.automation_job_events(job_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.automation_kill_switches (
  kill_switch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_version varchar(64) NOT NULL DEFAULT 'automation.v1',
  scope kortix.automation_kill_switch_scope NOT NULL,
  account_id uuid NOT NULL
    CONSTRAINT automation_kill_switches_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid
    CONSTRAINT automation_kill_switches_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  device_id uuid,
  generation bigint NOT NULL,
  active boolean NOT NULL DEFAULT true,
  actor_user_id uuid NOT NULL,
  audit_event_id uuid NOT NULL,
  activated_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_kill_switches_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT automation_kill_switches_protocol_version_check
    CHECK (protocol_version = 'automation.v1'),
  CONSTRAINT automation_kill_switches_scope_check
    CHECK (
      (scope = 'account' AND project_id IS NULL AND device_id IS NULL)
      OR (scope = 'project' AND project_id IS NOT NULL AND device_id IS NULL)
      OR (scope = 'device' AND project_id IS NOT NULL AND device_id IS NOT NULL)
    ),
  CONSTRAINT automation_kill_switches_generation_check CHECK (generation >= 0),
  CONSTRAINT automation_kill_switches_release_check CHECK (active = (released_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switches_account_active
  ON kortix.automation_kill_switches(account_id)
  WHERE scope = 'account' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switches_project_active
  ON kortix.automation_kill_switches(project_id)
  WHERE scope = 'project' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_kill_switches_device_active
  ON kortix.automation_kill_switches(device_id)
  WHERE scope = 'device' AND active;

CREATE OR REPLACE FUNCTION kortix.set_automation_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS automation_jobs_set_updated_at ON kortix.automation_jobs;
CREATE TRIGGER automation_jobs_set_updated_at
BEFORE UPDATE ON kortix.automation_jobs
FOR EACH ROW EXECUTE FUNCTION kortix.set_automation_updated_at();

DROP TRIGGER IF EXISTS automation_policies_set_updated_at ON kortix.automation_policies;
CREATE TRIGGER automation_policies_set_updated_at
BEFORE UPDATE ON kortix.automation_policies
FOR EACH ROW EXECUTE FUNCTION kortix.set_automation_updated_at();

DROP TRIGGER IF EXISTS automation_browser_profiles_set_updated_at
  ON kortix.automation_browser_profiles;
CREATE TRIGGER automation_browser_profiles_set_updated_at
BEFORE UPDATE ON kortix.automation_browser_profiles
FOR EACH ROW EXECUTE FUNCTION kortix.set_automation_updated_at();

REVOKE ALL
  ON TABLE
    kortix.automation_jobs,
    kortix.automation_job_steps,
    kortix.automation_job_events,
    kortix.automation_approvals,
    kortix.automation_policies,
    kortix.automation_browser_profiles,
    kortix.automation_kill_switches
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE
  ON TABLE
    kortix.automation_jobs,
    kortix.automation_job_steps,
    kortix.automation_approvals,
    kortix.automation_policies,
    kortix.automation_browser_profiles,
    kortix.automation_kill_switches
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.automation_job_events
  TO service_role;

REVOKE ALL ON FUNCTION kortix.set_automation_updated_at()
  FROM PUBLIC, anon, authenticated, service_role;
