CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_project_account_identity
  ON kortix.projects(project_id, account_id);

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_runs (
  run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_runs_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_runs_project_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  protocol_version text NOT NULL DEFAULT 'intelligence.workflow.v1',
  actor_type text NOT NULL,
  actor_id uuid,
  acting_token_id uuid
    CONSTRAINT intelligence_workflow_runs_token_fk
    REFERENCES kortix.account_tokens(token_id) ON DELETE SET NULL,
  agent_name text,
  session_id text
    CONSTRAINT intelligence_workflow_runs_session_fk
    REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  graph_version integer NOT NULL DEFAULT 0,
  policy_snapshot_hash text,
  evaluation_version text,
  max_nodes integer NOT NULL DEFAULT 128,
  max_dependencies integer NOT NULL DEFAULT 256,
  max_approved_credits numeric(18, 6) NOT NULL DEFAULT 0,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT intelligence_workflow_runs_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_runs_project_idempotency_unique
    UNIQUE (project_id, idempotency_key),
  CONSTRAINT intelligence_workflow_runs_protocol_version_check
    CHECK (protocol_version = 'intelligence.workflow.v1'),
  CONSTRAINT intelligence_workflow_runs_actor_type_check
    CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT intelligence_workflow_runs_actor_attribution_check
    CHECK (
      (actor_type <> 'user' OR actor_id IS NOT NULL)
      AND (
        actor_type <> 'agent'
        OR (agent_name IS NOT NULL AND BTRIM(agent_name) <> '')
      )
    ),
  CONSTRAINT intelligence_workflow_runs_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_workflow_runs_status_check
    CHECK (status IN ('draft', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT intelligence_workflow_runs_graph_version_check
    CHECK (graph_version >= 0),
  CONSTRAINT intelligence_workflow_runs_policy_snapshot_hash_check
    CHECK (
      policy_snapshot_hash IS NULL
      OR policy_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT intelligence_workflow_runs_limits_check
    CHECK (
      max_nodes BETWEEN 1 AND 128
      AND max_dependencies BETWEEN 0 AND 256
      AND max_approved_credits BETWEEN 0 AND 1000000
    ),
  CONSTRAINT intelligence_workflow_runs_terminal_at_check
    CHECK (
      (status IN ('succeeded', 'failed', 'cancelled')) = (terminal_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_runs_account_created
  ON kortix.intelligence_workflow_runs(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_runs_project_created
  ON kortix.intelligence_workflow_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_runs_project_status_updated
  ON kortix.intelligence_workflow_runs(project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_nodes (
  node_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_nodes_run_fk
    REFERENCES kortix.intelligence_workflow_runs(run_id) ON DELETE CASCADE,
  node_key text NOT NULL,
  role text NOT NULL,
  kind text NOT NULL,
  agent_name text,
  agent_card_hash text,
  capability_id text,
  capability_version text,
  input_ref text,
  input_hash text NOT NULL,
  action_summary text,
  policy_snapshot_hash text,
  evaluation_version text,
  task_id uuid
    CONSTRAINT intelligence_workflow_nodes_task_fk
    REFERENCES kortix.intelligence_tasks(task_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending',
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  terminal_at timestamptz,
  CONSTRAINT intelligence_workflow_nodes_run_identity_unique UNIQUE (run_id, node_id),
  CONSTRAINT intelligence_workflow_nodes_run_node_key_unique UNIQUE (run_id, node_key),
  CONSTRAINT intelligence_workflow_nodes_node_key_check
    CHECK (
      node_key ~ '^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$'
      AND length(node_key) <= 128
    ),
  CONSTRAINT intelligence_workflow_nodes_role_check
    CHECK (role IN ('planner', 'executor', 'reviewer', 'system')),
  CONSTRAINT intelligence_workflow_nodes_kind_check
    CHECK (kind IN ('agent', 'capability', 'approval')),
  CONSTRAINT intelligence_workflow_nodes_agent_card_hash_check
    CHECK (agent_card_hash IS NULL OR agent_card_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intelligence_workflow_nodes_capability_check
    CHECK (
      (
        kind = 'capability'
        AND capability_id IS NOT NULL
        AND capability_id = 'studio.image.generate'
        AND capability_version IS NOT NULL
        AND capability_version = '1.0.0'
      ) OR (
        kind <> 'capability'
        AND capability_id IS NULL
        AND capability_version IS NULL
      )
    ),
  CONSTRAINT intelligence_workflow_nodes_input_ref_check
    CHECK (
      input_ref IS NULL
      OR (
        input_ref ~ '^sealed:[A-Za-z0-9][A-Za-z0-9._:-]*$'
        AND length(input_ref) <= 263
      )
    ),
  CONSTRAINT intelligence_workflow_nodes_input_hash_check
    CHECK (input_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_workflow_nodes_action_summary_check
    CHECK (action_summary IS NULL OR octet_length(action_summary) <= 2048),
  CONSTRAINT intelligence_workflow_nodes_policy_snapshot_hash_check
    CHECK (
      policy_snapshot_hash IS NULL
      OR policy_snapshot_hash ~ '^sha256:[0-9a-f]{64}$'
    ),
  CONSTRAINT intelligence_workflow_nodes_status_check
    CHECK (
      status IN (
        'pending', 'ready', 'running', 'waiting_approval',
        'succeeded', 'failed', 'skipped', 'cancelled'
      )
    ),
  CONSTRAINT intelligence_workflow_nodes_task_kind_check
    CHECK (task_id IS NULL OR kind = 'capability'),
  CONSTRAINT intelligence_workflow_nodes_lease_check
    CHECK (
      (lease_owner IS NULL AND lease_expires_at IS NULL)
      OR (
        lease_owner IS NOT NULL
        AND BTRIM(lease_owner) <> ''
        AND lease_expires_at IS NOT NULL
        AND status = 'running'
      )
    ),
  CONSTRAINT intelligence_workflow_nodes_attempt_count_check
    CHECK (attempt_count BETWEEN 0 AND 1000),
  CONSTRAINT intelligence_workflow_nodes_terminal_at_check
    CHECK (
      (status IN ('succeeded', 'failed', 'skipped', 'cancelled')) = (terminal_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_nodes_run_status
  ON kortix.intelligence_workflow_nodes(run_id, status, node_key);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_nodes_ready_claim
  ON kortix.intelligence_workflow_nodes(status, lease_expires_at, deadline_at, node_key)
  WHERE status IN ('ready', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_workflow_nodes_task
  ON kortix.intelligence_workflow_nodes(task_id)
  WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_dependencies (
  dependency_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_dependencies_run_fk
    REFERENCES kortix.intelligence_workflow_runs(run_id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  depends_on_node_id uuid NOT NULL,
  condition text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_workflow_dependencies_child_fk
    FOREIGN KEY (run_id, node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_dependencies_parent_fk
    FOREIGN KEY (run_id, depends_on_node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_dependencies_edge_unique
    UNIQUE (run_id, node_id, depends_on_node_id),
  CONSTRAINT intelligence_workflow_dependencies_no_self_edge_check
    CHECK (node_id <> depends_on_node_id),
  CONSTRAINT intelligence_workflow_dependencies_condition_check
    CHECK (condition IN ('on_success', 'on_completion'))
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_dependencies_child
  ON kortix.intelligence_workflow_dependencies(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_dependencies_parent
  ON kortix.intelligence_workflow_dependencies(run_id, depends_on_node_id);

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_approvals (
  approval_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_approvals_run_fk
    REFERENCES kortix.intelligence_workflow_runs(run_id) ON DELETE CASCADE,
  node_id uuid NOT NULL,
  risk text NOT NULL,
  reason_code text NOT NULL,
  action_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  review_item_id uuid
    CONSTRAINT intelligence_workflow_approvals_review_item_fk
    REFERENCES kortix.review_items(review_item_id) ON DELETE SET NULL,
  acting_user_id uuid,
  decision text,
  feedback_hash text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_workflow_approvals_node_fk
    FOREIGN KEY (run_id, node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_approvals_risk_check
    CHECK (risk IN ('none', 'low', 'medium', 'high')),
  CONSTRAINT intelligence_workflow_approvals_reason_code_check
    CHECK (reason_code ~ '^[A-Z][A-Z0-9_.-]{0,127}$'),
  CONSTRAINT intelligence_workflow_approvals_action_summary_check
    CHECK (octet_length(action_summary) BETWEEN 1 AND 2048),
  CONSTRAINT intelligence_workflow_approvals_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')),
  CONSTRAINT intelligence_workflow_approvals_decision_check
    CHECK (decision IS NULL OR decision IN ('approve', 'reject', 'changes_requested')),
  CONSTRAINT intelligence_workflow_approvals_feedback_hash_check
    CHECK (feedback_hash IS NULL OR feedback_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_workflow_approvals_resolution_check
    CHECK (
      (
        status = 'pending'
        AND acting_user_id IS NULL
        AND decision IS NULL
        AND feedback_hash IS NULL
        AND resolved_at IS NULL
      ) OR (
        status = 'approved'
        AND acting_user_id IS NOT NULL
        AND decision IS NOT NULL
        AND decision = 'approve'
        AND resolved_at IS NOT NULL
      ) OR (
        status = 'rejected'
        AND acting_user_id IS NOT NULL
        AND decision IS NOT NULL
        AND decision IN ('reject', 'changes_requested')
        AND resolved_at IS NOT NULL
      ) OR (
        status IN ('expired', 'cancelled')
        AND decision IS NULL
        AND feedback_hash IS NULL
        AND resolved_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_approvals_run_status
  ON kortix.intelligence_workflow_approvals(run_id, status, requested_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_workflow_approvals_pending_node
  ON kortix.intelligence_workflow_approvals(run_id, node_id)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_workflow_approvals_review_item
  ON kortix.intelligence_workflow_approvals(review_item_id)
  WHERE review_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_events_run_fk
    REFERENCES kortix.intelligence_workflow_runs(run_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL,
  graph_version integer NOT NULL,
  node_id uuid,
  task_id uuid
    CONSTRAINT intelligence_workflow_events_task_fk
    REFERENCES kortix.intelligence_tasks(task_id) ON DELETE RESTRICT,
  progress numeric(5, 4),
  reason_code text,
  asset_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  evaluation_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_workflow_events_node_fk
    FOREIGN KEY (run_id, node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_events_run_sequence_unique UNIQUE (run_id, sequence),
  CONSTRAINT intelligence_workflow_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT intelligence_workflow_events_graph_version_check CHECK (graph_version >= 0),
  CONSTRAINT intelligence_workflow_events_type_check
    CHECK (
      event_type IN (
        'run_created', 'node_appended', 'dependency_added', 'graph_sealed', 'run_started',
        'node_ready', 'node_started', 'node_waiting_approval', 'approval_resolved',
        'route_selected', 'task_attached', 'node_succeeded', 'node_failed', 'node_skipped',
        'run_succeeded', 'run_failed', 'run_cancelled'
      )
    ),
  CONSTRAINT intelligence_workflow_events_status_check
    CHECK (status IN ('draft', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT intelligence_workflow_events_progress_check
    CHECK (progress IS NULL OR progress BETWEEN 0 AND 1),
  CONSTRAINT intelligence_workflow_events_reason_code_check
    CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z][A-Z0-9_.-]{0,127}$'),
  CONSTRAINT intelligence_workflow_events_asset_ids_check
    CHECK (jsonb_typeof(asset_ids) = 'array' AND jsonb_array_length(asset_ids) <= 64),
  CONSTRAINT intelligence_workflow_events_route_reason_codes_check
    CHECK (
      jsonb_typeof(route_reason_codes) = 'array'
      AND jsonb_array_length(route_reason_codes) <= 16
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_events_run_created
  ON kortix.intelligence_workflow_events(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_events_node
  ON kortix.intelligence_workflow_events(run_id, node_id, sequence);

CREATE TABLE IF NOT EXISTS kortix.intelligence_workflow_payloads (
  payload_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL
    CONSTRAINT intelligence_workflow_payloads_run_fk
    REFERENCES kortix.intelligence_workflow_runs(run_id) ON DELETE CASCADE,
  node_id uuid,
  purpose text NOT NULL,
  payload_ref text NOT NULL,
  content_hash text NOT NULL,
  byte_length bigint NOT NULL,
  content_type text NOT NULL DEFAULT 'application/json',
  retention_status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT intelligence_workflow_payloads_node_fk
    FOREIGN KEY (run_id, node_id)
    REFERENCES kortix.intelligence_workflow_nodes(run_id, node_id) ON DELETE CASCADE,
  CONSTRAINT intelligence_workflow_payloads_ref_unique UNIQUE (payload_ref),
  CONSTRAINT intelligence_workflow_payloads_purpose_check
    CHECK (purpose IN ('node_input', 'planner_proposal', 'reviewer_feedback')),
  CONSTRAINT intelligence_workflow_payloads_ref_check
    CHECK (
      payload_ref ~ '^sealed:[A-Za-z0-9][A-Za-z0-9._:-]*$'
      AND length(payload_ref) <= 263
    ),
  CONSTRAINT intelligence_workflow_payloads_content_hash_check
    CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_workflow_payloads_byte_length_check
    CHECK (byte_length BETWEEN 1 AND 1048576),
  CONSTRAINT intelligence_workflow_payloads_content_type_check
    CHECK (content_type = 'application/json'),
  CONSTRAINT intelligence_workflow_payloads_retention_check
    CHECK (
      (retention_status = 'active' AND deleted_at IS NULL)
      OR (retention_status = 'deleted' AND deleted_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_payloads_run_node
  ON kortix.intelligence_workflow_payloads(run_id, node_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_workflow_payloads_retention
  ON kortix.intelligence_workflow_payloads(retention_status, created_at);

REVOKE ALL
  ON TABLE
    kortix.intelligence_workflow_runs,
    kortix.intelligence_workflow_nodes,
    kortix.intelligence_workflow_dependencies,
    kortix.intelligence_workflow_approvals,
    kortix.intelligence_workflow_events,
    kortix.intelligence_workflow_payloads
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE
  ON TABLE
    kortix.intelligence_workflow_runs,
    kortix.intelligence_workflow_nodes,
    kortix.intelligence_workflow_approvals
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE
    kortix.intelligence_workflow_dependencies,
    kortix.intelligence_workflow_events
  TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE kortix.intelligence_workflow_payloads
  TO service_role;
