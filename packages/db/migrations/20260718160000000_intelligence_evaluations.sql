CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_account_identity
  ON kortix.projects(project_id, account_id);

CREATE TABLE IF NOT EXISTS kortix.intelligence_evaluation_suites (
  suite_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT intelligence_evaluation_suites_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT intelligence_evaluation_suites_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  protocol_version text NOT NULL DEFAULT 'intelligence.workflow.v1',
  suite_version text NOT NULL,
  capability_id text NOT NULL,
  capability_version text NOT NULL,
  dataset_manifest_hash text NOT NULL,
  dataset_ref text NOT NULL,
  scorer_versions jsonb NOT NULL,
  thresholds jsonb NOT NULL,
  minimum_sample_count integer NOT NULL,
  confidence_level_bps integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT intelligence_evaluation_suites_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_evaluation_suites_project_version_unique
    UNIQUE (project_id, suite_version),
  CONSTRAINT intelligence_evaluation_suites_scope_version_unique
    UNIQUE (suite_id, account_id, project_id, suite_version),
  CONSTRAINT intelligence_evaluation_suites_protocol_version_check
    CHECK (protocol_version = 'intelligence.workflow.v1'),
  CONSTRAINT intelligence_evaluation_suites_version_check
    CHECK (suite_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT intelligence_evaluation_suites_capability_check
    CHECK (capability_id = 'studio.image.generate' AND capability_version = '1.0.0'),
  CONSTRAINT intelligence_evaluation_suites_dataset_hash_check
    CHECK (dataset_manifest_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_evaluation_suites_dataset_ref_check
    CHECK (
      dataset_ref ~ '^sealed:[A-Za-z0-9][A-Za-z0-9._:-]*$'
      AND length(dataset_ref) <= 263
    ),
  CONSTRAINT intelligence_evaluation_suites_scorers_check
    CHECK (
      jsonb_typeof(scorer_versions) = 'array'
      AND jsonb_array_length(scorer_versions) BETWEEN 1 AND 32
      AND pg_column_size(scorer_versions) <= 8192
    ),
  CONSTRAINT intelligence_evaluation_suites_thresholds_check
    CHECK (
      jsonb_typeof(thresholds) = 'object'
      AND thresholds ?& ARRAY[
        'minimum_schema_valid_rate_ppm',
        'minimum_integrity_rate_ppm',
        'minimum_safety_rate_ppm',
        'minimum_human_approval_rate_ppm',
        'maximum_failure_rate_ppm'
      ]
      AND thresholds - ARRAY[
        'minimum_schema_valid_rate_ppm',
        'minimum_integrity_rate_ppm',
        'minimum_safety_rate_ppm',
        'minimum_human_approval_rate_ppm',
        'maximum_failure_rate_ppm'
      ] = '{}'::jsonb
      AND (thresholds ->> 'minimum_schema_valid_rate_ppm') ~ '^[0-9]+$'
      AND (thresholds ->> 'minimum_integrity_rate_ppm') ~ '^[0-9]+$'
      AND (thresholds ->> 'minimum_safety_rate_ppm') ~ '^[0-9]+$'
      AND (thresholds ->> 'minimum_human_approval_rate_ppm') ~ '^[0-9]+$'
      AND (thresholds ->> 'maximum_failure_rate_ppm') ~ '^[0-9]+$'
      AND (thresholds ->> 'minimum_schema_valid_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (thresholds ->> 'minimum_integrity_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (thresholds ->> 'minimum_safety_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (thresholds ->> 'minimum_human_approval_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (thresholds ->> 'maximum_failure_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND pg_column_size(thresholds) <= 2048
    ),
  CONSTRAINT intelligence_evaluation_suites_limits_check
    CHECK (
      minimum_sample_count BETWEEN 1 AND 10000
      AND confidence_level_bps BETWEEN 1 AND 10000
    ),
  CONSTRAINT intelligence_evaluation_suites_status_check
    CHECK (status IN ('draft', 'published', 'retired')),
  CONSTRAINT intelligence_evaluation_suites_publication_check
    CHECK (
      (status = 'draft' AND published_at IS NULL)
      OR (status IN ('published', 'retired') AND published_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_evaluation_suites_project_status
  ON kortix.intelligence_evaluation_suites(project_id, status, suite_version);

CREATE TABLE IF NOT EXISTS kortix.intelligence_evaluation_runs (
  evaluation_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  suite_id uuid NOT NULL,
  account_id uuid NOT NULL
    CONSTRAINT intelligence_evaluation_runs_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT intelligence_evaluation_runs_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  suite_version text NOT NULL,
  protocol_version text NOT NULL DEFAULT 'intelligence.workflow.v1',
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  budget_micredits bigint NOT NULL,
  max_samples integer NOT NULL,
  processed_samples integer NOT NULL DEFAULT 0,
  spent_micredits bigint NOT NULL DEFAULT 0,
  failure_code text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_evaluation_runs_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_evaluation_runs_suite_scope_fk
    FOREIGN KEY (suite_id, account_id, project_id, suite_version)
    REFERENCES kortix.intelligence_evaluation_suites(
      suite_id, account_id, project_id, suite_version
    ) ON DELETE RESTRICT,
  CONSTRAINT intelligence_evaluation_runs_project_idempotency_unique
    UNIQUE (project_id, idempotency_key),
  CONSTRAINT intelligence_evaluation_runs_scope_identity_unique
    UNIQUE (evaluation_run_id, suite_id, account_id, project_id, suite_version),
  CONSTRAINT intelligence_evaluation_runs_protocol_version_check
    CHECK (protocol_version = 'intelligence.workflow.v1'),
  CONSTRAINT intelligence_evaluation_runs_idempotency_key_check
    CHECK (length(BTRIM(idempotency_key)) BETWEEN 16 AND 255),
  CONSTRAINT intelligence_evaluation_runs_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_evaluation_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT intelligence_evaluation_runs_budget_check
    CHECK (
      budget_micredits BETWEEN 1 AND 9007199254740991
      AND spent_micredits BETWEEN 0 AND budget_micredits
    ),
  CONSTRAINT intelligence_evaluation_runs_samples_check
    CHECK (max_samples BETWEEN 1 AND 10000 AND processed_samples BETWEEN 0 AND max_samples),
  CONSTRAINT intelligence_evaluation_runs_failure_code_check
    CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_.-]{0,127}$'),
  CONSTRAINT intelligence_evaluation_runs_lifecycle_check
    CHECK (
      (
        status = 'queued' AND started_at IS NULL AND completed_at IS NULL
        AND processed_samples = 0 AND spent_micredits = 0 AND failure_code IS NULL
      ) OR (
        status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL
        AND failure_code IS NULL
      ) OR (
        status = 'succeeded' AND started_at IS NOT NULL AND completed_at IS NOT NULL
        AND failure_code IS NULL
      ) OR (
        status = 'failed' AND started_at IS NOT NULL AND completed_at IS NOT NULL
        AND failure_code IS NOT NULL
      ) OR (
        status = 'cancelled' AND completed_at IS NOT NULL AND failure_code IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_evaluation_runs_project_status
  ON kortix.intelligence_evaluation_runs(project_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_evaluation_runs_suite_created
  ON kortix.intelligence_evaluation_runs(suite_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.intelligence_model_evaluation_snapshots (
  snapshot_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_version text NOT NULL,
  evaluation_run_id uuid NOT NULL,
  suite_id uuid NOT NULL,
  account_id uuid NOT NULL
    CONSTRAINT intelligence_model_evaluation_snapshots_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT intelligence_model_evaluation_snapshots_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  suite_version text NOT NULL,
  candidate_hash text NOT NULL,
  capability_id text NOT NULL,
  capability_version text NOT NULL,
  sample_count integer NOT NULL,
  minimum_sample_count integer NOT NULL,
  meets_minimum_samples boolean NOT NULL,
  confidence jsonb NOT NULL,
  metrics jsonb NOT NULL,
  scorer_versions jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_model_evaluation_snapshots_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_model_evaluation_snapshots_suite_scope_fk
    FOREIGN KEY (suite_id, account_id, project_id, suite_version)
    REFERENCES kortix.intelligence_evaluation_suites(
      suite_id, account_id, project_id, suite_version
    ) ON DELETE RESTRICT,
  CONSTRAINT intelligence_model_evaluation_snapshots_run_scope_fk
    FOREIGN KEY (evaluation_run_id, suite_id, account_id, project_id, suite_version)
    REFERENCES kortix.intelligence_evaluation_runs(
      evaluation_run_id, suite_id, account_id, project_id, suite_version
    ) ON DELETE RESTRICT,
  CONSTRAINT intelligence_model_evaluation_snapshots_project_version_unique
    UNIQUE (project_id, snapshot_version),
  CONSTRAINT intelligence_model_evaluation_snapshots_run_candidate_unique
    UNIQUE (evaluation_run_id, candidate_hash),
  CONSTRAINT intelligence_model_evaluation_snapshots_version_check
    CHECK (snapshot_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT intelligence_model_evaluation_snapshots_suite_version_check
    CHECK (suite_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT intelligence_model_evaluation_snapshots_candidate_hash_check
    CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_model_evaluation_snapshots_capability_check
    CHECK (capability_id = 'studio.image.generate' AND capability_version = '1.0.0'),
  CONSTRAINT intelligence_model_evaluation_snapshots_sample_limits_check
    CHECK (
      sample_count BETWEEN 1 AND 10000
      AND minimum_sample_count BETWEEN 1 AND 10000
      AND meets_minimum_samples = (sample_count >= minimum_sample_count)
    ),
  CONSTRAINT intelligence_model_evaluation_snapshots_confidence_check
    CHECK (
      jsonb_typeof(confidence) = 'object'
      AND confidence ?& ARRAY['method', 'level_bps', 'lower_bound_ppm', 'upper_bound_ppm']
      AND confidence - ARRAY[
        'method', 'level_bps', 'lower_bound_ppm', 'upper_bound_ppm'
      ] = '{}'::jsonb
      AND confidence ->> 'method' IN ('wilson', 'none')
      AND (confidence ->> 'level_bps') ~ '^[0-9]+$'
      AND (confidence ->> 'lower_bound_ppm') ~ '^[0-9]+$'
      AND (confidence ->> 'upper_bound_ppm') ~ '^[0-9]+$'
      AND (confidence ->> 'level_bps')::bigint BETWEEN 1 AND 10000
      AND (confidence ->> 'lower_bound_ppm')::bigint BETWEEN 0 AND 1000000
      AND (confidence ->> 'upper_bound_ppm')::bigint BETWEEN 0 AND 1000000
      AND (confidence ->> 'lower_bound_ppm')::bigint
        <= (confidence ->> 'upper_bound_ppm')::bigint
      AND pg_column_size(confidence) <= 512
    ),
  CONSTRAINT intelligence_model_evaluation_snapshots_metrics_check
    CHECK (
      jsonb_typeof(metrics) = 'object'
      AND metrics ?& ARRAY[
        'schema_valid_rate_ppm', 'integrity_rate_ppm', 'safety_rate_ppm',
        'availability_rate_ppm', 'failure_rate_ppm', 'retry_rate_ppm',
        'human_approval_rate_ppm', 'latency_p50_ms', 'latency_p95_ms',
        'mean_cost_micredits', 'total_cost_micredits'
      ]
      AND metrics - ARRAY[
        'schema_valid_rate_ppm', 'integrity_rate_ppm', 'safety_rate_ppm',
        'availability_rate_ppm', 'failure_rate_ppm', 'retry_rate_ppm',
        'human_approval_rate_ppm', 'latency_p50_ms', 'latency_p95_ms',
        'mean_cost_micredits', 'total_cost_micredits'
      ] = '{}'::jsonb
      AND (metrics ->> 'schema_valid_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'integrity_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'safety_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'availability_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'failure_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'retry_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'human_approval_rate_ppm') ~ '^[0-9]+$'
      AND (metrics ->> 'latency_p50_ms') ~ '^[0-9]+$'
      AND (metrics ->> 'latency_p95_ms') ~ '^[0-9]+$'
      AND (metrics ->> 'mean_cost_micredits') ~ '^[0-9]+$'
      AND (metrics ->> 'total_cost_micredits') ~ '^[0-9]+$'
      AND (metrics ->> 'schema_valid_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'integrity_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'safety_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'availability_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'failure_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'retry_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'human_approval_rate_ppm')::bigint BETWEEN 0 AND 1000000
      AND (metrics ->> 'latency_p50_ms')::bigint BETWEEN 0 AND 604800000
      AND (metrics ->> 'latency_p95_ms')::bigint
        BETWEEN (metrics ->> 'latency_p50_ms')::bigint AND 604800000
      AND (metrics ->> 'mean_cost_micredits')::numeric BETWEEN 0 AND 9007199254740991
      AND (metrics ->> 'total_cost_micredits')::numeric BETWEEN 0 AND 9007199254740991
      AND pg_column_size(metrics) <= 4096
    ),
  CONSTRAINT intelligence_model_evaluation_snapshots_scorers_check
    CHECK (
      jsonb_typeof(scorer_versions) = 'array'
      AND jsonb_array_length(scorer_versions) BETWEEN 1 AND 32
      AND pg_column_size(scorer_versions) <= 8192
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_model_evaluation_snapshots_project_published
  ON kortix.intelligence_model_evaluation_snapshots(project_id, published_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_model_evaluation_snapshots_suite_created
  ON kortix.intelligence_model_evaluation_snapshots(suite_id, created_at);

CREATE OR REPLACE FUNCTION kortix.guard_intelligence_evaluation_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM kortix.intelligence_evaluation_runs run
    WHERE run.evaluation_run_id = NEW.evaluation_run_id
      AND run.suite_id = NEW.suite_id
      AND run.account_id = NEW.account_id
      AND run.project_id = NEW.project_id
      AND run.suite_version = NEW.suite_version
      AND run.status = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'evaluation snapshots require a succeeded in-scope run';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intelligence_evaluation_snapshots_succeeded_run_trigger
  ON kortix.intelligence_model_evaluation_snapshots;
CREATE TRIGGER intelligence_evaluation_snapshots_succeeded_run_trigger
BEFORE INSERT ON kortix.intelligence_model_evaluation_snapshots
FOR EACH ROW EXECUTE FUNCTION kortix.guard_intelligence_evaluation_snapshot_insert();

CREATE OR REPLACE FUNCTION kortix.guard_intelligence_evaluation_suite_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'published evaluation suites are immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published'
    AND NEW.status = 'retired'
    AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;

  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'published evaluation suites are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS intelligence_evaluation_suites_immutable_trigger
  ON kortix.intelligence_evaluation_suites;
CREATE TRIGGER intelligence_evaluation_suites_immutable_trigger
BEFORE UPDATE OR DELETE ON kortix.intelligence_evaluation_suites
FOR EACH ROW EXECUTE FUNCTION kortix.guard_intelligence_evaluation_suite_mutation();

CREATE OR REPLACE FUNCTION kortix.guard_intelligence_evaluation_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'published evaluation snapshots are insert-only';
END;
$$;

DROP TRIGGER IF EXISTS intelligence_evaluation_snapshots_insert_only_trigger
  ON kortix.intelligence_model_evaluation_snapshots;
CREATE TRIGGER intelligence_evaluation_snapshots_insert_only_trigger
BEFORE UPDATE OR DELETE ON kortix.intelligence_model_evaluation_snapshots
FOR EACH ROW EXECUTE FUNCTION kortix.guard_intelligence_evaluation_snapshot_mutation();

REVOKE ALL
  ON TABLE
    kortix.intelligence_evaluation_suites,
    kortix.intelligence_evaluation_runs,
    kortix.intelligence_model_evaluation_snapshots
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE
  ON TABLE
    kortix.intelligence_evaluation_suites,
    kortix.intelligence_evaluation_runs
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.intelligence_model_evaluation_snapshots
  TO service_role;

REVOKE ALL
  ON FUNCTION
    kortix.guard_intelligence_evaluation_snapshot_insert(),
    kortix.guard_intelligence_evaluation_suite_mutation(),
    kortix.guard_intelligence_evaluation_snapshot_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
