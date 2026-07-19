-- Immutable, project-fenced deterministic intelligence route decisions.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'intelligence_workflow_runs_scope_identity_unique'
      AND conrelid = 'kortix.intelligence_workflow_runs'::regclass
  ) THEN
    ALTER TABLE kortix.intelligence_workflow_runs
      ADD CONSTRAINT intelligence_workflow_runs_scope_identity_unique
      UNIQUE (run_id, account_id, project_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS kortix.intelligence_route_decisions (
  decision_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  run_id uuid NOT NULL,
  node_id uuid NOT NULL,
  protocol_version text NOT NULL DEFAULT 'intelligence.route.v1',
  request_hash text NOT NULL,
  policy_version text NOT NULL,
  policy_hash text NOT NULL,
  primary_candidate jsonb,
  fallback_candidate jsonb,
  rejected_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason_codes jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT intelligence_route_decisions_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_route_decisions_run_scope_fk
    FOREIGN KEY (run_id, account_id, project_id)
    REFERENCES kortix.intelligence_workflow_runs(run_id, account_id, project_id)
    ON DELETE CASCADE,
  CONSTRAINT intelligence_route_decisions_node_fk
    FOREIGN KEY (run_id, node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_route_decisions_run_node_unique UNIQUE (run_id, node_id),
  CONSTRAINT intelligence_route_decisions_protocol_version_check
    CHECK (protocol_version = 'intelligence.route.v1'),
  CONSTRAINT intelligence_route_decisions_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_route_decisions_policy_check
    CHECK (
      policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      AND policy_hash ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT intelligence_route_decisions_primary_candidate_check
    CHECK (
      primary_candidate IS NULL OR (
        jsonb_typeof(primary_candidate) = 'object'
        AND primary_candidate ?& ARRAY[
          'candidateId', 'providerDefinitionId', 'providerConfigId', 'modelId',
          'evaluationVersion', 'scorePpm', 'components'
        ]
        AND primary_candidate - ARRAY[
          'candidateId', 'providerDefinitionId', 'providerConfigId', 'modelId',
          'evaluationVersion', 'scorePpm', 'components'
        ] = '{}'::jsonb
        AND (primary_candidate ->> 'candidateId') ~ '^sha256:[0-9a-f]{64}$'
        AND length(primary_candidate ->> 'providerDefinitionId') BETWEEN 1 AND 128
        AND length(primary_candidate ->> 'providerConfigId') BETWEEN 1 AND 256
        AND length(primary_candidate ->> 'modelId') BETWEEN 1 AND 255
        AND (primary_candidate ->> 'evaluationVersion')
          ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND (primary_candidate ->> 'scorePpm') ~ '^-?[0-9]+$'
        AND (primary_candidate ->> 'scorePpm')::bigint BETWEEN -5000000 AND 5000000
        AND jsonb_typeof(primary_candidate -> 'components') = 'object'
        AND (primary_candidate -> 'components') ?& ARRAY[
          'qualityPpm', 'availabilityPpm', 'latencyPenaltyPpm',
          'costPenaltyPpm', 'riskPenaltyPpm'
        ]
        AND (primary_candidate -> 'components') - ARRAY[
          'qualityPpm', 'availabilityPpm', 'latencyPenaltyPpm',
          'costPenaltyPpm', 'riskPenaltyPpm'
        ] = '{}'::jsonb
        AND (primary_candidate -> 'components' ->> 'qualityPpm') ~ '^[0-9]+$'
        AND (primary_candidate -> 'components' ->> 'availabilityPpm') ~ '^[0-9]+$'
        AND (primary_candidate -> 'components' ->> 'latencyPenaltyPpm') ~ '^[0-9]+$'
        AND (primary_candidate -> 'components' ->> 'costPenaltyPpm') ~ '^[0-9]+$'
        AND (primary_candidate -> 'components' ->> 'riskPenaltyPpm') ~ '^[0-9]+$'
        AND (primary_candidate -> 'components' ->> 'qualityPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (primary_candidate -> 'components' ->> 'availabilityPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (primary_candidate -> 'components' ->> 'latencyPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (primary_candidate -> 'components' ->> 'costPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (primary_candidate -> 'components' ->> 'riskPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND pg_column_size(primary_candidate) <= 4096
      )
    ),
  CONSTRAINT intelligence_route_decisions_fallback_candidate_check
    CHECK (
      fallback_candidate IS NULL OR (
        primary_candidate IS NOT NULL
        AND jsonb_typeof(fallback_candidate) = 'object'
        AND fallback_candidate ?& ARRAY[
          'candidateId', 'providerDefinitionId', 'providerConfigId', 'modelId',
          'evaluationVersion', 'scorePpm', 'components'
        ]
        AND fallback_candidate - ARRAY[
          'candidateId', 'providerDefinitionId', 'providerConfigId', 'modelId',
          'evaluationVersion', 'scorePpm', 'components'
        ] = '{}'::jsonb
        AND (fallback_candidate ->> 'candidateId') ~ '^sha256:[0-9a-f]{64}$'
        AND length(fallback_candidate ->> 'providerDefinitionId') BETWEEN 1 AND 128
        AND length(fallback_candidate ->> 'providerConfigId') BETWEEN 1 AND 256
        AND length(fallback_candidate ->> 'modelId') BETWEEN 1 AND 255
        AND (fallback_candidate ->> 'evaluationVersion')
          ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        AND (fallback_candidate ->> 'scorePpm') ~ '^-?[0-9]+$'
        AND (fallback_candidate ->> 'scorePpm')::bigint BETWEEN -5000000 AND 5000000
        AND jsonb_typeof(fallback_candidate -> 'components') = 'object'
        AND (fallback_candidate -> 'components') ?& ARRAY[
          'qualityPpm', 'availabilityPpm', 'latencyPenaltyPpm',
          'costPenaltyPpm', 'riskPenaltyPpm'
        ]
        AND (fallback_candidate -> 'components') - ARRAY[
          'qualityPpm', 'availabilityPpm', 'latencyPenaltyPpm',
          'costPenaltyPpm', 'riskPenaltyPpm'
        ] = '{}'::jsonb
        AND (fallback_candidate -> 'components' ->> 'qualityPpm') ~ '^[0-9]+$'
        AND (fallback_candidate -> 'components' ->> 'availabilityPpm') ~ '^[0-9]+$'
        AND (fallback_candidate -> 'components' ->> 'latencyPenaltyPpm') ~ '^[0-9]+$'
        AND (fallback_candidate -> 'components' ->> 'costPenaltyPpm') ~ '^[0-9]+$'
        AND (fallback_candidate -> 'components' ->> 'riskPenaltyPpm') ~ '^[0-9]+$'
        AND (fallback_candidate -> 'components' ->> 'qualityPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (fallback_candidate -> 'components' ->> 'availabilityPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (fallback_candidate -> 'components' ->> 'latencyPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (fallback_candidate -> 'components' ->> 'costPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND (fallback_candidate -> 'components' ->> 'riskPenaltyPpm')::bigint
          BETWEEN 0 AND 1000000
        AND pg_column_size(fallback_candidate) <= 4096
      )
    ),
  CONSTRAINT intelligence_route_decisions_rejected_candidates_check
    CHECK (
      jsonb_typeof(rejected_candidates) = 'array'
      AND jsonb_array_length(rejected_candidates) <= 128
      AND pg_column_size(rejected_candidates) <= 32768
      AND rejected_candidates::text !~* '"(prompt|provider_?url|base_?url|api_?key|credential|authorization|payload_?ref|raw_?response)"[[:space:]]*:'
    ),
  CONSTRAINT intelligence_route_decisions_reason_codes_check
    CHECK (
      jsonb_typeof(reason_codes) = 'array'
      AND jsonb_array_length(reason_codes) BETWEEN 1 AND 32
      AND pg_column_size(reason_codes) <= 4096
      AND reason_codes <@ '[
        "ROUTE_PRIMARY_SELECTED", "ROUTE_FALLBACK_SELECTED",
        "ROUTE_NO_ELIGIBLE_CANDIDATE", "ROUTE_IAM_DENIED", "ROUTE_AGENT_DENIED",
        "ROUTE_PROJECT_POLICY_DENIED", "ROUTE_CAPABILITY_MISMATCH",
        "ROUTE_SCHEMA_MISMATCH", "ROUTE_REGION_DENIED", "ROUTE_SAFETY_DENIED",
        "ROUTE_INPUT_UNSUPPORTED", "ROUTE_OUTPUT_UNSUPPORTED", "ROUTE_NOT_READY",
        "ROUTE_BUDGET_EXCEEDED", "ROUTE_DEADLINE_UNSATISFIABLE",
        "ROUTE_EVALUATION_MISSING", "ROUTE_EVALUATION_STALE",
        "ROUTE_EVALUATION_THRESHOLD_FAILED", "ROUTE_RISK_EXCEEDED",
        "ROUTE_PROPOSED_TARGET_REJECTED"
      ]'::jsonb
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_route_decisions_project_created
  ON kortix.intelligence_route_decisions(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_intelligence_model_evaluation_snapshots_project_candidate_published
  ON kortix.intelligence_model_evaluation_snapshots(project_id, candidate_hash, published_at);

CREATE OR REPLACE FUNCTION kortix.guard_intelligence_route_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'intelligence route decisions are insert-only';
END;
$$;

DROP TRIGGER IF EXISTS intelligence_route_decisions_insert_only_trigger
  ON kortix.intelligence_route_decisions;
CREATE TRIGGER intelligence_route_decisions_insert_only_trigger
BEFORE UPDATE OR DELETE ON kortix.intelligence_route_decisions
FOR EACH ROW EXECUTE FUNCTION kortix.guard_intelligence_route_decision_mutation();

REVOKE ALL ON TABLE kortix.intelligence_route_decisions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE kortix.intelligence_route_decisions TO service_role;

REVOKE ALL ON FUNCTION kortix.guard_intelligence_route_decision_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
