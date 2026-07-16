-- Studio production provider storage: additive pricing, recovery, and billing state.
-- This migration deliberately contains no public RPC definitions.

CREATE TABLE IF NOT EXISTS kortix.studio_pricing_catalog (
  pricing_catalog_id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  provider text not null,
  model text not null,
  unit text not null,
  rate_data jsonb not null,
  maximum_cost_rule jsonb not null,
  markup_rule jsonb not null,
  version integer not null,
  active boolean not null default true,
  created_by_user_id uuid null,
  created_at timestamptz not null default now(),
  CONSTRAINT studio_pricing_catalog_account_fk
    FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT studio_pricing_catalog_unit_check CHECK (unit = 'image'),
  CONSTRAINT studio_pricing_catalog_version_check CHECK (version > 0),
  CONSTRAINT studio_pricing_catalog_scope_version_key UNIQUE (account_id, provider, model, version)
);

CREATE TABLE IF NOT EXISTS kortix.studio_job_recoveries (
  recovery_id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  idempotency_key text not null,
  request_hash text not null,
  decision text not null,
  reason text not null,
  actor_user_id uuid not null,
  actor_type text not null,
  acting_token_id uuid null,
  evidence jsonb not null,
  prior_job_status text not null,
  prior_attempt_status text not null,
  resulting_job_status text not null,
  resulting_attempt_status text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  CONSTRAINT studio_job_recoveries_account_fk
    FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT studio_job_recoveries_project_fk
    FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  CONSTRAINT studio_job_recoveries_job_fk
    FOREIGN KEY (job_id) REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  CONSTRAINT studio_job_recoveries_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES kortix.studio_job_attempts(attempt_id) ON DELETE CASCADE,
  CONSTRAINT studio_job_recoveries_decision_check
    CHECK (decision IN ('confirm_succeeded', 'confirm_not_created', 'keep_unknown')),
  CONSTRAINT studio_job_recoveries_job_idempotency_key UNIQUE (job_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS kortix.studio_billing_incidents (
  incident_id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  project_id uuid not null,
  job_id uuid not null,
  attempt_id uuid not null,
  kind text not null,
  status text not null default 'open',
  verified_cost_credits numeric(12,4) not null,
  potential_liability_credits numeric(12,4) not null,
  metadata jsonb not null default '{}'::jsonb,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by_user_id uuid null,
  CONSTRAINT studio_billing_incidents_account_fk
    FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT studio_billing_incidents_project_fk
    FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  CONSTRAINT studio_billing_incidents_job_fk
    FOREIGN KEY (job_id) REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE,
  CONSTRAINT studio_billing_incidents_attempt_fk
    FOREIGN KEY (attempt_id) REFERENCES kortix.studio_job_attempts(attempt_id) ON DELETE CASCADE,
  CONSTRAINT studio_billing_incidents_kind_check
    CHECK (kind = 'unknown_outcome_hold_expired'),
  CONSTRAINT studio_billing_incidents_status_check
    CHECK (status IN ('open', 'resolved')),
  CONSTRAINT studio_billing_incidents_job_attempt_kind_key UNIQUE (job_id, attempt_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_studio_job_recoveries_account
  ON kortix.studio_job_recoveries (account_id);
CREATE INDEX IF NOT EXISTS idx_studio_job_recoveries_project
  ON kortix.studio_job_recoveries (project_id);
CREATE INDEX IF NOT EXISTS idx_studio_job_recoveries_attempt
  ON kortix.studio_job_recoveries (attempt_id);
CREATE INDEX IF NOT EXISTS idx_studio_billing_incidents_account
  ON kortix.studio_billing_incidents (account_id);
CREATE INDEX IF NOT EXISTS idx_studio_billing_incidents_project
  ON kortix.studio_billing_incidents (project_id);
CREATE INDEX IF NOT EXISTS idx_studio_billing_incidents_attempt
  ON kortix.studio_billing_incidents (attempt_id);

ALTER TABLE kortix.studio_billing_incidents
  ADD COLUMN IF NOT EXISTS resolution jsonb;

ALTER TABLE kortix.studio_jobs
  ADD COLUMN IF NOT EXISTS provider_config_version text,
  ADD COLUMN IF NOT EXISTS pricing_catalog_id uuid,
  ADD COLUMN IF NOT EXISTS pricing_version integer,
  ADD COLUMN IF NOT EXISTS pricing_snapshot jsonb;

ALTER TABLE kortix.studio_job_attempts
  ADD COLUMN IF NOT EXISTS provider_config_version text,
  ADD COLUMN IF NOT EXISTS submission_kind text,
  ADD COLUMN IF NOT EXISTS staging_manifest_key text,
  ADD COLUMN IF NOT EXISTS staging_manifest_checksum text,
  ADD COLUMN IF NOT EXISTS cost_outcome text,
  ADD COLUMN IF NOT EXISTS cost_recorded_at timestamptz;

ALTER TABLE kortix.studio_usage_events
  ADD COLUMN IF NOT EXISTS attempt_id uuid,
  ADD COLUMN IF NOT EXISTS outcome text,
  ADD COLUMN IF NOT EXISTS platform_loss_credits numeric(12,4) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_pricing_catalog_account_fk'
      AND conrelid = 'kortix.studio_pricing_catalog'::regclass
  ) THEN
    ALTER TABLE kortix.studio_pricing_catalog
      ADD CONSTRAINT studio_pricing_catalog_account_fk
      FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;

REVOKE ALL ON TABLE kortix.studio_pricing_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE kortix.studio_pricing_catalog TO service_role;

REVOKE ALL ON TABLE kortix.studio_job_recoveries FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE kortix.studio_job_recoveries TO service_role;

REVOKE ALL ON TABLE kortix.studio_billing_incidents FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE kortix.studio_billing_incidents TO service_role;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE kortix.studio_jobs, kortix.studio_job_attempts,
    kortix.studio_credit_reservations, kortix.studio_usage_events
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_account_fk'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_account_fk
      FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_project_fk'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_project_fk
      FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_job_fk'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_job_fk
      FOREIGN KEY (job_id) REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_attempt_fk'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_attempt_fk
      FOREIGN KEY (attempt_id) REFERENCES kortix.studio_job_attempts(attempt_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_kind_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_kind_check
      CHECK (kind = 'unknown_outcome_hold_expired');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_status_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_status_check
      CHECK (status in ('open', 'resolved'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_verified_cost_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_verified_cost_check
      CHECK (verified_cost_credits >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_potential_liability_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_potential_liability_check
      CHECK (potential_liability_credits >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_resolution_audit_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_resolution_audit_check CHECK (
        (status = 'open'
          AND resolved_at IS NULL
          AND resolved_by_user_id IS NULL
          AND resolution IS NULL)
        OR (status = 'resolved'
          AND resolved_at IS NOT NULL
          AND resolved_by_user_id IS NOT NULL
          AND resolution IS NOT NULL)
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_resolved_at_check'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_resolved_at_check
      CHECK (resolved_at IS NULL OR resolved_at >= opened_at);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_billing_incidents_job_attempt_kind_key'
      AND conrelid = 'kortix.studio_billing_incidents'::regclass
  ) THEN
    ALTER TABLE kortix.studio_billing_incidents
      ADD CONSTRAINT studio_billing_incidents_job_attempt_kind_key
      UNIQUE (job_id, attempt_id, kind);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_usage_events_attempt_fk'
      AND conrelid = 'kortix.studio_usage_events'::regclass
  ) THEN
    ALTER TABLE kortix.studio_usage_events
      ADD CONSTRAINT studio_usage_events_attempt_fk
      FOREIGN KEY (attempt_id) REFERENCES kortix.studio_job_attempts(attempt_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_usage_events_outcome_shape_check'
      AND conrelid = 'kortix.studio_usage_events'::regclass
  ) THEN
    ALTER TABLE kortix.studio_usage_events
      ADD CONSTRAINT studio_usage_events_outcome_shape_check CHECK (
        outcome is null or (
          (
            attempt_id is not null and outcome in ('succeeded', 'failed', 'cancelled', 'unknown')
            and upstream_cost_credits >= 0
            and final_cost_credits = 0
            and platform_loss_credits = 0
          ) or (
            attempt_id is null and outcome in ('succeeded', 'failed', 'cancelled')
            and upstream_cost_credits = 0
            and final_cost_credits >= 0
            and platform_loss_credits >= 0
            and metadata ? 'verified_upstream_cost_credits'
          )
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_usage_events_attempt
  ON kortix.studio_usage_events (attempt_id)
  WHERE attempt_id is not null;

CREATE OR REPLACE FUNCTION kortix.enforce_studio_pricing_catalog_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A nested delete is a parent-account cascade only when that account row is gone.
    IF pg_catalog.pg_trigger_depth() > 1
      AND NOT EXISTS (SELECT 1 FROM kortix.accounts WHERE account_id = OLD.account_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Studio pricing catalog rows are append-only';
  END IF;

  IF NOT (new.active is false and old.active is true) THEN
    RAISE EXCEPTION 'Studio pricing catalog rows may only deactivate';
  END IF;

  IF NOT (
    NEW.pricing_catalog_id IS NOT DISTINCT FROM OLD.pricing_catalog_id
    AND
    NEW.account_id IS NOT DISTINCT FROM OLD.account_id
    AND NEW.provider IS NOT DISTINCT FROM OLD.provider
    AND NEW.model IS NOT DISTINCT FROM OLD.model
    AND NEW.unit IS NOT DISTINCT FROM OLD.unit
    AND NEW.rate_data IS NOT DISTINCT FROM OLD.rate_data
    AND NEW.maximum_cost_rule IS NOT DISTINCT FROM OLD.maximum_cost_rule
    AND NEW.markup_rule IS NOT DISTINCT FROM OLD.markup_rule
    AND NEW.version IS NOT DISTINCT FROM OLD.version
    AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  ) THEN
    RAISE EXCEPTION 'Studio pricing catalog identity or pricing fields are immutable';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION kortix.enforce_studio_job_recovery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  -- Nested deletes with every declared parent still present are direct deletes and fail.
  IF TG_OP = 'DELETE'
    AND pg_catalog.pg_trigger_depth() > 1
    AND (
      NOT EXISTS (SELECT 1 FROM kortix.accounts WHERE account_id = OLD.account_id)
      OR NOT EXISTS (SELECT 1 FROM kortix.projects WHERE project_id = OLD.project_id)
      OR NOT EXISTS (SELECT 1 FROM kortix.studio_jobs WHERE job_id = OLD.job_id)
      OR NOT EXISTS (SELECT 1 FROM kortix.studio_job_attempts WHERE attempt_id = OLD.attempt_id)
    ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Studio recovery audit rows are immutable';
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'trg_studio_pricing_catalog_immutable'
      AND tgrelid = 'kortix.studio_pricing_catalog'::regclass
  ) THEN
    CREATE TRIGGER trg_studio_pricing_catalog_immutable
      BEFORE UPDATE OR DELETE ON kortix.studio_pricing_catalog
      FOR EACH ROW EXECUTE FUNCTION kortix.enforce_studio_pricing_catalog_immutability();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'trg_studio_job_recoveries_immutable'
      AND tgrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    CREATE TRIGGER trg_studio_job_recoveries_immutable
      BEFORE UPDATE OR DELETE ON kortix.studio_job_recoveries
      FOR EACH ROW EXECUTE FUNCTION kortix.enforce_studio_job_recovery_immutability();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_pricing_catalog_unit_check'
      AND conrelid = 'kortix.studio_pricing_catalog'::regclass
  ) THEN
    ALTER TABLE kortix.studio_pricing_catalog
      ADD CONSTRAINT studio_pricing_catalog_unit_check CHECK (unit = 'image');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_pricing_catalog_version_check'
      AND conrelid = 'kortix.studio_pricing_catalog'::regclass
  ) THEN
    ALTER TABLE kortix.studio_pricing_catalog
      ADD CONSTRAINT studio_pricing_catalog_version_check CHECK (version > 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_pricing_catalog_scope_version_key'
      AND conrelid = 'kortix.studio_pricing_catalog'::regclass
  ) THEN
    ALTER TABLE kortix.studio_pricing_catalog
      ADD CONSTRAINT studio_pricing_catalog_scope_version_key
      UNIQUE (account_id, provider, model, version);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_jobs_pricing_catalog_fk'
      AND conrelid = 'kortix.studio_jobs'::regclass
  ) THEN
    ALTER TABLE kortix.studio_jobs
      ADD CONSTRAINT studio_jobs_pricing_catalog_fk
      FOREIGN KEY (pricing_catalog_id)
      REFERENCES kortix.studio_pricing_catalog(pricing_catalog_id)
      ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_jobs_pricing_snapshot_shape_check'
      AND conrelid = 'kortix.studio_jobs'::regclass
  ) THEN
    ALTER TABLE kortix.studio_jobs
      ADD CONSTRAINT studio_jobs_pricing_snapshot_shape_check CHECK (
        provider_config_version is null and pricing_catalog_id is null
        and pricing_version is null and pricing_snapshot is null
        or provider_config_version is not null and pricing_catalog_id is not null
        and pricing_version is not null and pricing_snapshot is not null
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_jobs_pricing_version_check'
      AND conrelid = 'kortix.studio_jobs'::regclass
  ) THEN
    ALTER TABLE kortix.studio_jobs
      ADD CONSTRAINT studio_jobs_pricing_version_check
      CHECK (pricing_version is null or pricing_version > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_studio_jobs_pricing_catalog
  ON kortix.studio_jobs (pricing_catalog_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_attempts_submission_kind_check'
      AND conrelid = 'kortix.studio_job_attempts'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_attempts
      ADD CONSTRAINT studio_job_attempts_submission_kind_check
      CHECK (submission_kind is null or submission_kind in ('async', 'completed'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_attempts_staging_manifest_check'
      AND conrelid = 'kortix.studio_job_attempts'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_attempts
      ADD CONSTRAINT studio_job_attempts_staging_manifest_check CHECK (
        staging_manifest_key is null and staging_manifest_checksum is null
        or staging_manifest_key is not null and staging_manifest_checksum is not null
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_attempts_cost_outcome_check'
      AND conrelid = 'kortix.studio_job_attempts'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_attempts
      ADD CONSTRAINT studio_job_attempts_cost_outcome_check
      CHECK (cost_outcome is null or cost_outcome in ('succeeded', 'failed', 'cancelled', 'unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_attempts_cost_recorded_check'
      AND conrelid = 'kortix.studio_job_attempts'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_attempts
      ADD CONSTRAINT studio_job_attempts_cost_recorded_check CHECK (
        cost_outcome is null and cost_recorded_at is null
        or cost_outcome is not null and cost_recorded_at is not null
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_attempts_upstream_cost_check'
      AND conrelid = 'kortix.studio_job_attempts'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_attempts
      ADD CONSTRAINT studio_job_attempts_upstream_cost_check
      CHECK (upstream_cost_credits is null or upstream_cost_credits >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_account_fk'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_account_fk
      FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_project_fk'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_project_fk
      FOREIGN KEY (project_id) REFERENCES kortix.projects(project_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_job_fk'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_job_fk
      FOREIGN KEY (job_id) REFERENCES kortix.studio_jobs(job_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_attempt_fk'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_attempt_fk
      FOREIGN KEY (attempt_id) REFERENCES kortix.studio_job_attempts(attempt_id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_decision_check'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_decision_check
      CHECK (decision in ('confirm_succeeded', 'confirm_not_created', 'keep_unknown'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_job_recoveries_job_idempotency_key'
      AND conrelid = 'kortix.studio_job_recoveries'::regclass
  ) THEN
    ALTER TABLE kortix.studio_job_recoveries
      ADD CONSTRAINT studio_job_recoveries_job_idempotency_key UNIQUE (job_id, idempotency_key);
  END IF;
END $$;
