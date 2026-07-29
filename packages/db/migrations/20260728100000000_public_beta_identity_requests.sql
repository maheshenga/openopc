DO $policy_acceptance_policy_enum$
BEGIN
  CREATE TYPE kortix.policy_acceptance_policy AS ENUM (
    'terms', 'privacy', 'acceptable_use', 'module_rules'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$policy_acceptance_policy_enum$;

DO $policy_acceptance_source_enum$
BEGIN
  CREATE TYPE kortix.policy_acceptance_source AS ENUM (
    'registration', 'developer_application', 'settings'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$policy_acceptance_source_enum$;

DO $account_request_kind_enum$
BEGIN
  CREATE TYPE kortix.account_request_kind AS ENUM (
    'data_export', 'account_deletion', 'security_report', 'module_report'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$account_request_kind_enum$;

DO $account_request_status_enum$
BEGIN
  CREATE TYPE kortix.account_request_status AS ENUM (
    'pending', 'cooling_off', 'processing', 'completed',
    'cancelled', 'rejected', 'expired'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$account_request_status_enum$;

DO $developer_application_state_enum$
BEGIN
  CREATE TYPE kortix.developer_application_state AS ENUM (
    'draft', 'submitted', 'under_review', 'approved', 'rejected', 'suspended'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_application_state_enum$;

DO $public_beta_identity_parent_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'account_members_account_user_unique'
      AND conrelid = 'kortix.account_members'::regclass
  ) THEN
    ALTER TABLE kortix.account_members
      ADD CONSTRAINT account_members_account_user_unique UNIQUE (account_id, user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installations_installation_account_unique'
      AND conrelid = 'kortix.project_module_installations'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installations
      ADD CONSTRAINT project_module_installations_installation_account_unique
      UNIQUE (installation_id, account_id);
  END IF;
END
$public_beta_identity_parent_constraints$;

CREATE TABLE IF NOT EXISTS kortix.policy_acceptances (
  acceptance_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  user_id uuid NOT NULL,
  policy kortix.policy_acceptance_policy NOT NULL,
  version varchar(64) NOT NULL,
  source kortix.policy_acceptance_source NOT NULL,
  registration_decision_jti_hash varchar(71),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT policy_acceptances_acceptance_account_unique
    UNIQUE (acceptance_id, account_id),
  CONSTRAINT policy_acceptances_account_user_policy_version_unique
    UNIQUE (account_id, user_id, policy, version),
  CONSTRAINT policy_acceptances_account_user_fk
    FOREIGN KEY (account_id, user_id)
    REFERENCES kortix.account_members(account_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT policy_acceptances_registration_decision_fk
    FOREIGN KEY (registration_decision_jti_hash)
    REFERENCES kortix.public_registration_decisions(jti_hash)
    ON DELETE RESTRICT,
  CONSTRAINT policy_acceptances_version_check
    CHECK (
      version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND lower(version) NOT IN ('latest', 'current', 'draft', 'unpublished')
    ),
  CONSTRAINT policy_acceptances_source_check
    CHECK (
      (
        source = 'registration'
        AND registration_decision_jti_hash IS NOT NULL
        AND policy IN ('terms', 'privacy', 'acceptable_use')
      ) OR (
        source <> 'registration'
        AND registration_decision_jti_hash IS NULL
      )
    ),
  CONSTRAINT policy_acceptances_metadata_check
    CHECK (
      jsonb_typeof(metadata) = 'object'
      AND pg_column_size(metadata) <= 4096
    )
);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_account_user_accepted
  ON kortix.policy_acceptances(account_id, user_id, accepted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_acceptances_registration_policy_unique
  ON kortix.policy_acceptances(registration_decision_jti_hash, policy)
  WHERE registration_decision_jti_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.account_requests (
  request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  kind kortix.account_request_kind NOT NULL,
  status kortix.account_request_status NOT NULL,
  reason text,
  module_installation_id uuid,
  idempotency_key varchar(255) NOT NULL,
  request_hash varchar(71) NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  not_before_at timestamptz,
  processing_started_at timestamptz,
  terminal_at timestamptz,
  expires_at timestamptz,
  result_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_requests_request_account_unique UNIQUE (request_id, account_id),
  CONSTRAINT account_requests_account_user_idempotency_unique
    UNIQUE (account_id, requested_by, idempotency_key),
  CONSTRAINT account_requests_account_user_fk
    FOREIGN KEY (account_id, requested_by)
    REFERENCES kortix.account_members(account_id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT account_requests_module_installation_account_fk
    FOREIGN KEY (module_installation_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT account_requests_reason_check
    CHECK (
      reason IS NULL
      OR (
        reason = BTRIM(reason)
        AND length(reason) BETWEEN 1 AND 4000
        AND octet_length(reason) <= 8192
      )
    ),
  CONSTRAINT account_requests_idempotency_check
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{15,254}$'),
  CONSTRAINT account_requests_request_hash_check
    CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT account_requests_module_check
    CHECK (
      (kind = 'module_report' AND module_installation_id IS NOT NULL)
      OR (kind <> 'module_report' AND module_installation_id IS NULL)
    ),
  CONSTRAINT account_requests_expiry_check
    CHECK (
      (kind = 'data_export' AND expires_at > requested_at)
      OR (kind <> 'data_export' AND expires_at IS NULL)
    ),
  CONSTRAINT account_requests_state_check
    CHECK (
      (
        status = 'pending'
        AND kind <> 'account_deletion'
        AND not_before_at IS NULL
        AND processing_started_at IS NULL
        AND terminal_at IS NULL
      ) OR (
        status = 'cooling_off'
        AND kind = 'account_deletion'
        AND not_before_at > requested_at
        AND processing_started_at IS NULL
        AND terminal_at IS NULL
      ) OR (
        status = 'processing'
        AND processing_started_at >= requested_at
        AND terminal_at IS NULL
      ) OR (
        status = 'cancelled'
        AND processing_started_at IS NULL
        AND terminal_at >= requested_at
      ) OR (
        status IN ('completed', 'rejected', 'expired')
        AND terminal_at >= requested_at
      )
    ),
  CONSTRAINT account_requests_metadata_check
    CHECK (
      jsonb_typeof(result_metadata) = 'object'
      AND pg_column_size(result_metadata) <= 16384
      AND updated_at >= requested_at
    )
);

CREATE INDEX IF NOT EXISTS idx_account_requests_account_user_requested
  ON kortix.account_requests(account_id, requested_by, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_requests_pending_work
  ON kortix.account_requests(status, not_before_at, requested_at)
  WHERE status IN ('pending', 'cooling_off');
CREATE INDEX IF NOT EXISTS idx_account_requests_module
  ON kortix.account_requests(module_installation_id, requested_at DESC)
  WHERE module_installation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS kortix.developer_applications (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  state kortix.developer_application_state NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 0,
  policy_versions jsonb NOT NULL,
  submitted_at timestamptz,
  decided_at timestamptz,
  suspended_at timestamptz,
  decision_reason text,
  created_by uuid NOT NULL,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_applications_application_account_unique
    UNIQUE (application_id, account_id),
  CONSTRAINT developer_applications_account_unique UNIQUE (account_id),
  CONSTRAINT developer_applications_organization_account_fk
    FOREIGN KEY (organization_id, account_id)
    REFERENCES kortix.developer_organizations(organization_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_applications_account_creator_fk
    FOREIGN KEY (account_id, created_by)
    REFERENCES kortix.account_members(account_id, user_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_applications_revision_check CHECK (revision >= 0),
  CONSTRAINT developer_applications_policy_check
    CHECK (
      jsonb_typeof(policy_versions) = 'object'
      AND policy_versions = jsonb_build_object(
        'moduleRules', policy_versions->'moduleRules',
        'acceptableUse', policy_versions->'acceptableUse'
      )
      AND policy_versions ?& ARRAY['moduleRules', 'acceptableUse']
      AND (policy_versions->>'moduleRules') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND (policy_versions->>'acceptableUse') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
      AND lower(policy_versions->>'moduleRules') NOT IN ('latest', 'current', 'draft', 'unpublished')
      AND lower(policy_versions->>'acceptableUse') NOT IN ('latest', 'current', 'draft', 'unpublished')
    ),
  CONSTRAINT developer_applications_state_check
    CHECK (
      (
        state = 'draft'
        AND submitted_at IS NULL
        AND decided_at IS NULL
        AND suspended_at IS NULL
      ) OR (
        state IN ('submitted', 'under_review')
        AND submitted_at IS NOT NULL
        AND decided_at IS NULL
        AND suspended_at IS NULL
      ) OR (
        state IN ('approved', 'rejected')
        AND submitted_at IS NOT NULL
        AND decided_at IS NOT NULL
        AND suspended_at IS NULL
      ) OR (
        state = 'suspended'
        AND submitted_at IS NOT NULL
        AND decided_at IS NOT NULL
        AND suspended_at IS NOT NULL
      )
    ),
  CONSTRAINT developer_applications_reason_check
    CHECK (
      (
        decision_reason IS NULL
        OR (
          decision_reason = BTRIM(decision_reason)
          AND length(decision_reason) BETWEEN 1 AND 4000
          AND octet_length(decision_reason) <= 8192
        )
      )
      AND (state NOT IN ('rejected', 'suspended') OR decision_reason IS NOT NULL)
    ),
  CONSTRAINT developer_applications_updated_check CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_developer_applications_state_updated
  ON kortix.developer_applications(state, updated_at);
CREATE INDEX IF NOT EXISTS idx_developer_applications_organization
  ON kortix.developer_applications(organization_id, updated_at);

CREATE OR REPLACE FUNCTION kortix.reject_policy_acceptance_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'policy acceptances are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS policy_acceptances_append_only
  ON kortix.policy_acceptances;
CREATE TRIGGER policy_acceptances_append_only
BEFORE UPDATE OR DELETE ON kortix.policy_acceptances
FOR EACH ROW EXECUTE FUNCTION kortix.reject_policy_acceptance_mutation();

CREATE OR REPLACE FUNCTION kortix.guard_account_request_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account requests cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.request_id IS DISTINCT FROM OLD.request_id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.module_installation_id IS DISTINCT FROM OLD.module_installation_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
    OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR NEW.not_before_at IS DISTINCT FROM OLD.not_before_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'account request identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('cancelled', 'rejected', 'expired')
    AND NEW IS DISTINCT FROM OLD
  THEN
    RAISE EXCEPTION 'terminal account requests are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status = 'completed'
    AND NEW IS DISTINCT FROM OLD
    AND NEW.status IS DISTINCT FROM 'expired'::kortix.account_request_status
  THEN
    RAISE EXCEPTION 'completed account requests may only expire'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status
    AND NOT (
      (OLD.status IN ('pending', 'cooling_off') AND NEW.status IN ('processing', 'cancelled', 'rejected', 'expired'))
      OR (OLD.status = 'processing' AND NEW.status IN ('completed', 'rejected'))
      OR (OLD.status = 'completed' AND NEW.status = 'expired')
    )
  THEN
    RAISE EXCEPTION 'account request state transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_requests_guard_mutation
  ON kortix.account_requests;
CREATE TRIGGER account_requests_guard_mutation
BEFORE UPDATE OR DELETE ON kortix.account_requests
FOR EACH ROW EXECUTE FUNCTION kortix.guard_account_request_mutation();

CREATE OR REPLACE FUNCTION kortix.complete_public_registration_decision(
  p_jti_hash varchar,
  p_now timestamptz,
  p_account_id uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  decision kortix.public_registration_decisions%ROWTYPE;
  replay_count integer;
BEGIN
  IF p_jti_hash !~ '^sha256:[0-9a-f]{64}$'
    OR p_now IS NULL
    OR p_account_id IS NULL
    OR p_user_id IS NULL
  THEN
    RETURN false;
  END IF;

  SELECT registration.*
  INTO decision
  FROM kortix.public_registration_decisions AS registration
  WHERE registration.jti_hash = p_jti_hash
  FOR UPDATE;

  IF NOT FOUND
    OR decision.issued_at > p_now
    OR decision.expires_at <= p_now
  THEN
    RETURN false;
  END IF;

  IF decision.consumed_at IS NOT NULL THEN
    SELECT count(*)
    INTO replay_count
    FROM kortix.policy_acceptances AS acceptance
    WHERE acceptance.registration_decision_jti_hash = p_jti_hash
      AND acceptance.account_id = p_account_id
      AND acceptance.user_id = p_user_id
      AND acceptance.source = 'registration';
    RETURN replay_count = 3;
  END IF;

  PERFORM 1
  FROM kortix.account_members AS member
  WHERE member.account_id = p_account_id
    AND member.user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO kortix.policy_acceptances (
    account_id,
    user_id,
    policy,
    version,
    source,
    registration_decision_jti_hash,
    accepted_at,
    metadata
  ) VALUES
    (
      p_account_id,
      p_user_id,
      'terms',
      decision.policy_versions->>'terms',
      'registration',
      p_jti_hash,
      p_now,
      '{}'::jsonb
    ),
    (
      p_account_id,
      p_user_id,
      'privacy',
      decision.policy_versions->>'privacy',
      'registration',
      p_jti_hash,
      p_now,
      '{}'::jsonb
    ),
    (
      p_account_id,
      p_user_id,
      'acceptable_use',
      decision.policy_versions->>'acceptableUse',
      'registration',
      p_jti_hash,
      p_now,
      '{}'::jsonb
    );

  UPDATE kortix.public_registration_decisions AS registration
  SET consumed_at = p_now
  WHERE registration.jti_hash = p_jti_hash
    AND registration.consumed_at IS NULL;

  RETURN FOUND;
END;
$$;

ALTER TABLE kortix.policy_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.account_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE kortix.developer_applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL
  ON TABLE
    kortix.policy_acceptances,
    kortix.account_requests,
    kortix.developer_applications
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE
    kortix.policy_acceptances,
    kortix.account_requests,
    kortix.developer_applications
  TO service_role;

GRANT UPDATE (
  status,
  processing_started_at,
  terminal_at,
  result_metadata,
  updated_at
)
  ON TABLE kortix.account_requests
  TO service_role;

GRANT UPDATE (
  state,
  revision,
  policy_versions,
  submitted_at,
  decided_at,
  suspended_at,
  decision_reason,
  updated_by,
  updated_at
)
  ON TABLE kortix.developer_applications
  TO service_role;

REVOKE ALL
  ON FUNCTION
    kortix.reject_policy_acceptance_mutation(),
    kortix.guard_account_request_mutation(),
    kortix.complete_public_registration_decision(varchar, timestamptz, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE
  ON FUNCTION kortix.complete_public_registration_decision(varchar, timestamptz, uuid, uuid)
  TO service_role;
