CREATE TABLE IF NOT EXISTS kortix.intelligence_tasks (
  task_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT intelligence_tasks_account_id_accounts_account_id_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id uuid NOT NULL
    CONSTRAINT intelligence_tasks_project_id_projects_project_id_fk
    REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  job_id uuid
    CONSTRAINT intelligence_tasks_job_id_studio_jobs_job_id_fk
    REFERENCES kortix.studio_jobs(job_id) ON DELETE RESTRICT,
  actor_user_id uuid,
  actor_type text NOT NULL,
  acting_token_id uuid
    CONSTRAINT intelligence_tasks_acting_token_id_account_tokens_token_id_fk
    REFERENCES kortix.account_tokens(token_id) ON DELETE SET NULL,
  agent_name text,
  session_id text
    CONSTRAINT intelligence_tasks_session_id_project_sessions_session_id_fk
    REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  parent_task_id uuid,
  capability_id text NOT NULL,
  capability_version text NOT NULL,
  provider_config_id uuid NOT NULL
    CONSTRAINT intelligence_tasks_provider_config_id_studio_provider_configs_provider_config_id_fk
    REFERENCES kortix.studio_provider_configs(provider_config_id) ON DELETE RESTRICT,
  model text NOT NULL,
  request_hash text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  agent_card_hash text NOT NULL,
  studio_source_cursor bigint,
  deadline_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_tasks_parent_task_fk
    FOREIGN KEY (parent_task_id) REFERENCES kortix.intelligence_tasks(task_id) ON DELETE SET NULL,
  CONSTRAINT intelligence_tasks_actor_type_check
    CHECK (actor_type IN ('user', 'agent', 'system')),
  CONSTRAINT intelligence_tasks_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT intelligence_tasks_capability_check
    CHECK (capability_id = 'studio.image.generate' AND capability_version = '1.0.0'),
  CONSTRAINT intelligence_tasks_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT intelligence_tasks_agent_card_hash_check
    CHECK (agent_card_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT intelligence_tasks_studio_source_cursor_check
    CHECK (studio_source_cursor IS NULL OR studio_source_cursor > 0),
  CONSTRAINT intelligence_tasks_project_idempotency_unique
    UNIQUE (project_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_intelligence_tasks_account_created
  ON kortix.intelligence_tasks(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_tasks_project_created
  ON kortix.intelligence_tasks(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_intelligence_tasks_parent
  ON kortix.intelligence_tasks(project_id, parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_tasks_job
  ON kortix.intelligence_tasks(job_id)
  WHERE job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.intelligence_task_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL
    CONSTRAINT intelligence_task_events_task_id_intelligence_tasks_task_id_fk
    REFERENCES kortix.intelligence_tasks(task_id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  studio_cursor bigint,
  event_type text NOT NULL,
  status text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT intelligence_task_events_sequence_check CHECK (sequence > 0),
  CONSTRAINT intelligence_task_events_studio_cursor_check
    CHECK (studio_cursor IS NULL OR studio_cursor > 0),
  CONSTRAINT intelligence_task_events_type_check
    CHECK (event_type IN (
      'created', 'queued', 'running', 'progress', 'asset_created',
      'approval_required', 'succeeded', 'failed', 'cancelled'
    )),
  CONSTRAINT intelligence_task_events_status_check
    CHECK (status IN ('queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT intelligence_task_events_payload_object_check
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT intelligence_task_events_task_sequence_unique UNIQUE (task_id, sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_intelligence_task_events_studio_cursor
  ON kortix.intelligence_task_events(task_id, studio_cursor)
  WHERE studio_cursor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_intelligence_task_events_created
  ON kortix.intelligence_task_events(created_at);

REVOKE ALL
  ON TABLE kortix.intelligence_tasks, kortix.intelligence_task_events
  FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE kortix.intelligence_tasks, kortix.intelligence_task_events
  TO service_role;
