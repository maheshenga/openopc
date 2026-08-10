ALTER TABLE kortix.project_module_service_consents
  DROP CONSTRAINT IF EXISTS project_module_service_consents_operations_check;

ALTER TABLE kortix.project_module_service_consents
  ADD CONSTRAINT project_module_service_consents_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","image.generate"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 7
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["image.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_capability_grants
  DROP CONSTRAINT IF EXISTS module_service_capability_grants_operations_check;

ALTER TABLE kortix.module_service_capability_grants
  ADD CONSTRAINT module_service_capability_grants_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","image.generate"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 7
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["image.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_audit_events
  DROP CONSTRAINT IF EXISTS module_service_audit_events_operation_check;

ALTER TABLE kortix.module_service_audit_events
  ADD CONSTRAINT module_service_audit_events_operation_check CHECK (
    operation IS NULL
    OR (service = 'ai' AND operation IN ('models.read', 'text.generate', 'text.stream', 'image.generate'))
    OR (service = 'payment' AND operation IN ('orders.create', 'orders.read', 'refunds.create'))
  );

ALTER TABLE kortix.studio_jobs
  ADD COLUMN IF NOT EXISTS module_service_grant_id uuid;

ALTER TABLE kortix.studio_jobs
  DROP CONSTRAINT IF EXISTS studio_jobs_module_service_grant_fk;

ALTER TABLE kortix.studio_jobs
  ADD CONSTRAINT studio_jobs_module_service_grant_fk
  FOREIGN KEY (module_service_grant_id)
  REFERENCES kortix.module_service_capability_grants(grant_id)
  ON DELETE NO ACTION;

ALTER TABLE kortix.studio_jobs
  DROP CONSTRAINT IF EXISTS studio_jobs_module_actor_check;

ALTER TABLE kortix.studio_jobs
  ADD CONSTRAINT studio_jobs_module_actor_check CHECK (
    (
      actor_type = 'module'
      AND module_service_grant_id IS NOT NULL
      AND acting_token_id IS NULL
      AND agent_name IS NULL
      AND session_id IS NULL
    ) OR (
      actor_type <> 'module'
      AND module_service_grant_id IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_studio_jobs_module_service_grant
  ON kortix.studio_jobs(module_service_grant_id)
  WHERE module_service_grant_id IS NOT NULL;
