CREATE TABLE IF NOT EXISTS kortix.project_module_service_consents (
  consent_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  install_revision integer NOT NULL,
  service varchar(16) NOT NULL,
  operations jsonb NOT NULL,
  consent_digest varchar(71) NOT NULL,
  accepted_by uuid NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_at timestamptz,
  CONSTRAINT project_module_service_consents_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT project_module_service_consents_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_service_consents_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT project_module_service_consents_authorization_identity_unique
    UNIQUE (consent_id, account_id, project_id, installation_id, release_id, service),
  CONSTRAINT project_module_service_consents_revision_check CHECK (install_revision > 0),
  CONSTRAINT project_module_service_consents_service_check CHECK (service IN ('ai', 'payment')),
  CONSTRAINT project_module_service_consents_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 6
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  ),
  CONSTRAINT project_module_service_consents_digest_check
    CHECK (consent_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT project_module_service_consents_revocation_check CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_module_service_consents_active_identity
  ON kortix.project_module_service_consents(installation_id, service, install_revision)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_module_service_consents_account_project
  ON kortix.project_module_service_consents(account_id, project_id, accepted_at);

CREATE TABLE IF NOT EXISTS kortix.module_service_capability_grants (
  grant_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  consent_id uuid NOT NULL,
  service varchar(16) NOT NULL,
  operations jsonb NOT NULL,
  token_hash varchar(71) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_service_capability_grants_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_service_capability_grants_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT module_service_capability_grants_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT module_service_capability_grants_consent_identity_fk
    FOREIGN KEY (consent_id, account_id, project_id, installation_id, release_id, service)
    REFERENCES kortix.project_module_service_consents
      (consent_id, account_id, project_id, installation_id, release_id, service)
    ON DELETE CASCADE,
  CONSTRAINT module_service_capability_grants_audit_identity_unique
    UNIQUE (grant_id, account_id, project_id, installation_id, release_id, service),
  CONSTRAINT module_service_capability_grants_service_check CHECK (service IN ('ai', 'payment')),
  CONSTRAINT module_service_capability_grants_operations_check CHECK (
    jsonb_typeof(operations) = 'array'
    AND (
      (service = 'ai' AND operations <@ '["models.read","text.generate","text.stream"]'::jsonb)
      OR (service = 'payment' AND operations <@ '["orders.create","orders.read","refunds.create"]'::jsonb)
    )
    AND jsonb_array_length(operations) BETWEEN 1 AND 6
    AND jsonb_array_length(operations) =
      (CASE WHEN operations @> '["models.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.generate"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["text.stream"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.create"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["orders.read"]'::jsonb THEN 1 ELSE 0 END
      + CASE WHEN operations @> '["refunds.create"]'::jsonb THEN 1 ELSE 0 END)
  ),
  CONSTRAINT module_service_capability_grants_token_hash_check
    CHECK (token_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT module_service_capability_grants_expiry_check CHECK (
    expires_at > created_at
    AND expires_at <= created_at + interval '5 minutes'
    AND (revoked_at IS NULL OR revoked_at >= created_at)
  )
);

CREATE INDEX IF NOT EXISTS idx_module_service_grants_account_project
  ON kortix.module_service_capability_grants(account_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_module_service_grants_identity_expiry
  ON kortix.module_service_capability_grants(grant_id, expires_at);

CREATE TABLE IF NOT EXISTS kortix.module_service_audit_events (
  event_id uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  release_id uuid NOT NULL,
  grant_id uuid,
  service varchar(16) NOT NULL,
  operation varchar(32),
  outcome varchar(32) NOT NULL,
  code varchar(128),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT module_service_audit_events_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id) ON DELETE CASCADE,
  CONSTRAINT module_service_audit_events_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT module_service_audit_events_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id) ON DELETE RESTRICT,
  CONSTRAINT module_service_audit_events_grant_identity_fk
    FOREIGN KEY (grant_id, account_id, project_id, installation_id, release_id, service)
    REFERENCES kortix.module_service_capability_grants
      (grant_id, account_id, project_id, installation_id, release_id, service)
    ON DELETE CASCADE,
  CONSTRAINT module_service_audit_events_service_check CHECK (service IN ('ai', 'payment')),
  CONSTRAINT module_service_audit_events_operation_check CHECK (
    operation IS NULL
    OR (service = 'ai' AND operation IN ('models.read', 'text.generate', 'text.stream'))
    OR (service = 'payment' AND operation IN ('orders.create', 'orders.read', 'refunds.create'))
  ),
  CONSTRAINT module_service_audit_events_outcome_check
    CHECK (outcome IN ('consent_granted', 'issued', 'authorized', 'denied', 'revoked')),
  CONSTRAINT module_service_audit_events_code_check
    CHECK (code IS NULL OR length(code) BETWEEN 1 AND 128)
);

CREATE INDEX IF NOT EXISTS idx_module_service_audit_account_project
  ON kortix.module_service_audit_events(account_id, project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_module_service_audit_grant_created
  ON kortix.module_service_audit_events(grant_id, created_at);

CREATE OR REPLACE FUNCTION kortix.protect_project_module_service_consent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.consent_id,
    NEW.account_id,
    NEW.project_id,
    NEW.installation_id,
    NEW.release_id,
    NEW.install_revision,
    NEW.service,
    NEW.operations,
    NEW.consent_digest,
    NEW.accepted_by,
    NEW.accepted_at
  ) IS DISTINCT FROM ROW(
    OLD.consent_id,
    OLD.account_id,
    OLD.project_id,
    OLD.installation_id,
    OLD.release_id,
    OLD.install_revision,
    OLD.service,
    OLD.operations,
    OLD.consent_digest,
    OLD.accepted_by,
    OLD.accepted_at
  ) THEN
    RAISE EXCEPTION 'project_module_service_consent_is_immutable';
  END IF;
  IF ROW(NEW.revoked_by, NEW.revoked_at) IS DISTINCT FROM ROW(OLD.revoked_by, OLD.revoked_at)
    AND NOT (
      OLD.revoked_by IS NULL
      AND OLD.revoked_at IS NULL
      AND NEW.revoked_by IS NOT NULL
      AND NEW.revoked_at IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'project_module_service_consent_revocation_is_final';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS project_module_service_consents_immutable
  ON kortix.project_module_service_consents;
CREATE TRIGGER project_module_service_consents_immutable
  BEFORE UPDATE ON kortix.project_module_service_consents
  FOR EACH ROW EXECUTE FUNCTION kortix.protect_project_module_service_consent();

CREATE OR REPLACE FUNCTION kortix.protect_module_service_capability_grant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.grant_id,
    NEW.account_id,
    NEW.project_id,
    NEW.installation_id,
    NEW.release_id,
    NEW.consent_id,
    NEW.service,
    NEW.operations,
    NEW.token_hash,
    NEW.expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.grant_id,
    OLD.account_id,
    OLD.project_id,
    OLD.installation_id,
    OLD.release_id,
    OLD.consent_id,
    OLD.service,
    OLD.operations,
    OLD.token_hash,
    OLD.expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'module_service_capability_grant_is_immutable';
  END IF;
  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    AND NOT (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'module_service_capability_grant_revocation_is_final';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS module_service_capability_grants_immutable
  ON kortix.module_service_capability_grants;
CREATE TRIGGER module_service_capability_grants_immutable
  BEFORE UPDATE ON kortix.module_service_capability_grants
  FOR EACH ROW EXECUTE FUNCTION kortix.protect_module_service_capability_grant();

CREATE OR REPLACE FUNCTION kortix.reject_module_service_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM kortix.projects AS project
      WHERE project.project_id = OLD.project_id
        AND project.account_id = OLD.account_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM kortix.project_module_installations AS installation
      WHERE installation.installation_id = OLD.installation_id
        AND installation.project_id = OLD.project_id
        AND installation.account_id = OLD.account_id
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'module_service_audit_events_append_only';
END;
$$;

DROP TRIGGER IF EXISTS module_service_audit_events_append_only
  ON kortix.module_service_audit_events;
CREATE TRIGGER module_service_audit_events_append_only
  BEFORE UPDATE OR DELETE ON kortix.module_service_audit_events
  FOR EACH ROW EXECUTE FUNCTION kortix.reject_module_service_audit_event_mutation();

REVOKE ALL PRIVILEGES ON TABLE
  kortix.project_module_service_consents,
  kortix.module_service_capability_grants,
  kortix.module_service_audit_events
FROM PUBLIC, anon, authenticated, service_role;
