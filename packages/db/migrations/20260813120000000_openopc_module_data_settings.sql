CREATE TABLE IF NOT EXISTS kortix.project_module_documents (
  document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  document_key varchar(128) NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_documents_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT project_module_documents_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_documents_key_check CHECK (
    document_key ~ '^[a-z0-9][a-z0-9._/-]{0,127}$'
    AND document_key !~ '(^|/)\.\.?(/|$)'
    AND document_key !~ '//'
  ),
  CONSTRAINT project_module_documents_revision_check CHECK (revision > 0),
  CONSTRAINT project_module_documents_value_check CHECK (pg_column_size(value) <= 2000000)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_module_documents_identity_unique
  ON kortix.project_module_documents(installation_id, document_key);
CREATE INDEX IF NOT EXISTS idx_project_module_documents_account_project
  ON kortix.project_module_documents(account_id, project_id, updated_at);

CREATE TABLE IF NOT EXISTS kortix.project_module_settings (
  settings_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_settings_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT project_module_settings_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_settings_revision_check CHECK (revision >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS project_module_settings_installation_unique
  ON kortix.project_module_settings(installation_id);
CREATE INDEX IF NOT EXISTS idx_project_module_settings_account_project
  ON kortix.project_module_settings(account_id, project_id);

CREATE TABLE IF NOT EXISTS kortix.project_module_setting_values (
  setting_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  setting_key varchar(64) NOT NULL,
  value jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_setting_values_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT project_module_setting_values_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_setting_values_updated_by_fk
    FOREIGN KEY (account_id, updated_by)
    REFERENCES kortix.account_members(account_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT project_module_setting_values_key_check CHECK (
    setting_key ~ '^[a-z][a-z0-9_.-]{0,63}$'
    AND setting_key !~* '(^|[._-])(api[_-]?key|token|secret|password|credential|authorization|cookie|provider|base[_-]?url|endpoint)([._-]|$)'
  ),
  CONSTRAINT project_module_setting_values_revision_check CHECK (revision > 0),
  CONSTRAINT project_module_setting_values_value_check CHECK (
    jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null')
    AND pg_column_size(value) <= 65536
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS project_module_setting_values_identity_unique
  ON kortix.project_module_setting_values(installation_id, setting_key);
CREATE INDEX IF NOT EXISTS idx_project_module_setting_values_account_project
  ON kortix.project_module_setting_values(account_id, project_id, updated_at);

ALTER TABLE kortix.project_module_service_consents
  DROP CONSTRAINT IF EXISTS project_module_service_consents_service_check,
  DROP CONSTRAINT IF EXISTS project_module_service_consents_operations_check;

ALTER TABLE kortix.project_module_service_consents
  ADD CONSTRAINT project_module_service_consents_service_check
    CHECK (service IN ('ai', 'payment', 'data', 'settings')),
  ADD CONSTRAINT project_module_service_consents_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","image.generate"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
      OR (service = 'data' AND operations <@ '["documents.list","documents.read","documents.write","documents.delete"]'::jsonb)
      OR (service = 'settings' AND operations <@ '["settings.read"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 15
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["image.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.list"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.write"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.delete"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["settings.read"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_capability_grants
  DROP CONSTRAINT IF EXISTS module_service_capability_grants_service_check,
  DROP CONSTRAINT IF EXISTS module_service_capability_grants_operations_check;

ALTER TABLE kortix.module_service_capability_grants
  ADD CONSTRAINT module_service_capability_grants_service_check
    CHECK (service IN ('ai', 'payment', 'data', 'settings')),
  ADD CONSTRAINT module_service_capability_grants_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream","image.generate"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
      OR (service = 'data' AND operations <@ '["documents.list","documents.read","documents.write","documents.delete"]'::jsonb)
      OR (service = 'settings' AND operations <@ '["settings.read"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 15
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["image.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.list"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.write"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["documents.delete"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["settings.read"]'::jsonb THEN 1 ELSE 0 END)
  );

ALTER TABLE kortix.module_service_audit_events
  DROP CONSTRAINT IF EXISTS module_service_audit_events_service_check,
  DROP CONSTRAINT IF EXISTS module_service_audit_events_operation_check;

ALTER TABLE kortix.module_service_audit_events
  ADD CONSTRAINT module_service_audit_events_service_check
    CHECK (service IN ('ai', 'payment', 'data', 'settings')),
  ADD CONSTRAINT module_service_audit_events_operation_check CHECK (
    operation IS NULL
    OR (service = 'ai' AND operation IN ('models.read', 'text.generate', 'text.stream', 'image.generate'))
    OR (service = 'payment' AND operation IN ('orders.create', 'orders.read', 'refunds.create'))
    OR (service = 'data' AND operation IN ('documents.list', 'documents.read', 'documents.write', 'documents.delete'))
    OR (service = 'settings' AND operation = 'settings.read')
  );

CREATE OR REPLACE FUNCTION kortix.protect_project_module_document_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.document_id, NEW.account_id, NEW.project_id, NEW.installation_id,
    NEW.document_key, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.document_id, OLD.account_id, OLD.project_id, OLD.installation_id,
    OLD.document_key, OLD.created_at) THEN
    RAISE EXCEPTION 'project_module_document_identity_is_immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'project_module_document_revision_must_advance';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_module_documents_revision_guard
  ON kortix.project_module_documents;
CREATE TRIGGER project_module_documents_revision_guard
  BEFORE UPDATE ON kortix.project_module_documents
  FOR EACH ROW EXECUTE FUNCTION kortix.protect_project_module_document_revision();

CREATE OR REPLACE FUNCTION kortix.protect_project_module_setting_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.setting_id, NEW.account_id, NEW.project_id, NEW.installation_id,
    NEW.setting_key, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.setting_id, OLD.account_id, OLD.project_id, OLD.installation_id,
    OLD.setting_key, OLD.created_at) THEN
    RAISE EXCEPTION 'project_module_setting_identity_is_immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'project_module_setting_revision_must_advance';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_module_setting_values_revision_guard
  ON kortix.project_module_setting_values;
CREATE TRIGGER project_module_setting_values_revision_guard
  BEFORE UPDATE ON kortix.project_module_setting_values
  FOR EACH ROW EXECUTE FUNCTION kortix.protect_project_module_setting_revision();

CREATE OR REPLACE FUNCTION kortix.protect_project_module_settings_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(NEW.settings_id, NEW.account_id, NEW.project_id, NEW.installation_id,
    NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.settings_id, OLD.account_id, OLD.project_id, OLD.installation_id,
    OLD.created_at) THEN
    RAISE EXCEPTION 'project_module_settings_identity_is_immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at THEN
    RAISE EXCEPTION 'project_module_settings_revision_must_advance';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_module_settings_revision_guard
  ON kortix.project_module_settings;
CREATE TRIGGER project_module_settings_revision_guard
  BEFORE UPDATE ON kortix.project_module_settings
  FOR EACH ROW EXECUTE FUNCTION kortix.protect_project_module_settings_revision();

REVOKE ALL PRIVILEGES ON TABLE
  kortix.project_module_documents,
  kortix.project_module_settings,
  kortix.project_module_setting_values
FROM PUBLIC, anon, authenticated, service_role;
