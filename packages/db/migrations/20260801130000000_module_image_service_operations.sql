-- Extend the existing AI module service consent/grant/audit checks with the
-- platform-mediated image workflow operations. Existing profile data remains
-- valid; no credentials or provider configuration are stored in these rows.

ALTER TABLE kortix.project_module_service_consents
  DROP CONSTRAINT project_module_service_consents_operations_check,
  ADD CONSTRAINT project_module_service_consents_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","images.models.read","images.estimates.create","images.jobs.create","images.jobs.read","images.jobs.cancel","images.assets.create","images.assets.read","images.assets.download"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 11
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.estimates.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.cancel"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.download"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_capability_grants
  DROP CONSTRAINT module_service_capability_grants_operations_check,
  ADD CONSTRAINT module_service_capability_grants_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","images.models.read","images.estimates.create","images.jobs.create","images.jobs.read","images.jobs.cancel","images.assets.create","images.assets.read","images.assets.download"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 11
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.estimates.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.jobs.cancel"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["images.assets.download"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_audit_events
  DROP CONSTRAINT module_service_audit_events_operation_check,
  ADD CONSTRAINT module_service_audit_events_operation_check CHECK (
    operation IS NULL
    OR (service = 'ai' AND operation IN ('models.read', 'text.generate', 'text.stream', 'images.models.read', 'images.estimates.create', 'images.jobs.create', 'images.jobs.read', 'images.jobs.cancel', 'images.assets.create', 'images.assets.read', 'images.assets.download'))
    OR (service = 'payment' AND operation IN ('orders.create', 'orders.read', 'refunds.create'))
  );
