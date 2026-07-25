DO $developer_publisher_enums$
BEGIN
  CREATE TYPE kortix.developer_invitation_state AS ENUM (
    'pending', 'accepted', 'expired', 'revoked'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_publisher_enums$;

DO $developer_organization_verification_enum$
BEGIN
  CREATE TYPE kortix.developer_organization_verification_state AS ENUM (
    'pending', 'verified', 'rejected', 'suspended'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_organization_verification_enum$;

DO $developer_publisher_role_enum$
BEGIN
  CREATE TYPE kortix.developer_publisher_role AS ENUM (
    'owner', 'developer', 'release_manager', 'finance_viewer', 'support_viewer'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_publisher_role_enum$;

DO $developer_publisher_status_enum$
BEGIN
  CREATE TYPE kortix.developer_publisher_status AS ENUM ('active', 'suspended');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer_publisher_status_enum$;

CREATE TABLE IF NOT EXISTS kortix.developer_organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT developer_organizations_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  verification_state kortix.developer_organization_verification_state
    NOT NULL DEFAULT 'pending',
  verification_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_revision integer NOT NULL DEFAULT 0,
  verification_changed_by uuid,
  verification_changed_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_organizations_organization_account_unique
    UNIQUE (organization_id, account_id),
  CONSTRAINT developer_organizations_account_unique
    UNIQUE (account_id),
  CONSTRAINT developer_organizations_name_check
    CHECK (length(BTRIM(name)) BETWEEN 1 AND 255),
  CONSTRAINT developer_organizations_metadata_check
    CHECK (
      jsonb_typeof(verification_metadata) = 'object'
      AND pg_column_size(verification_metadata) <= 8192
    ),
  CONSTRAINT developer_organizations_revision_check
    CHECK (verification_revision >= 0),
  CONSTRAINT developer_organizations_verification_transition_check
    CHECK (
      (
        verification_state = 'pending'
        AND verification_changed_by IS NULL
        AND verification_changed_at IS NULL
      ) OR (
        verification_state IN ('verified', 'rejected', 'suspended')
        AND verification_changed_by IS NOT NULL
        AND verification_changed_at IS NOT NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_organizations_account_state
  ON kortix.developer_organizations(account_id, verification_state);

INSERT INTO kortix.developer_organizations (
  organization_id,
  account_id,
  name,
  verification_state,
  verification_metadata,
  verification_revision,
  verification_changed_by,
  verification_changed_at,
  created_by,
  created_at,
  updated_at
)
SELECT DISTINCT ON (publisher.account_id)
  gen_random_uuid(),
  publisher.account_id,
  publisher.display_name,
  'verified'::kortix.developer_organization_verification_state,
  '{"migrationSource":"existing-publisher"}'::jsonb,
  1,
  publisher.created_by,
  now(),
  publisher.created_by,
  publisher.created_at,
  now()
FROM kortix.developer_publishers AS publisher
ORDER BY publisher.account_id, publisher.created_at, publisher.publisher_id
ON CONFLICT (account_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS kortix.developer_invitations (
  invitation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT developer_invitations_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  organization_id uuid,
  email varchar(320) NOT NULL,
  token_hash varchar(64) NOT NULL
    CONSTRAINT developer_invitations_token_hash_unique UNIQUE,
  state kortix.developer_invitation_state NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  accepted_by uuid,
  accepted_at timestamptz,
  revoked_by uuid,
  revoked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_invitations_invitation_account_unique
    UNIQUE (invitation_id, account_id),
  CONSTRAINT developer_invitations_organization_account_fk
    FOREIGN KEY (organization_id, account_id)
    REFERENCES kortix.developer_organizations(organization_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_invitations_token_hash_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT developer_invitations_email_check
    CHECK (email = lower(BTRIM(email)) AND length(email) BETWEEN 3 AND 320),
  CONSTRAINT developer_invitations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT developer_invitations_state_check
    CHECK (
      (
        state IN ('pending', 'expired')
        AND accepted_by IS NULL
        AND accepted_at IS NULL
        AND revoked_by IS NULL
        AND revoked_at IS NULL
      ) OR (
        state = 'accepted'
        AND accepted_by IS NOT NULL
        AND accepted_at IS NOT NULL
        AND revoked_by IS NULL
        AND revoked_at IS NULL
      ) OR (
        state = 'revoked'
        AND accepted_by IS NULL
        AND accepted_at IS NULL
        AND revoked_by IS NOT NULL
        AND revoked_at IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_invitations_pending_email_unique
  ON kortix.developer_invitations(account_id, lower(email))
  WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS idx_developer_invitations_account_state_expiry
  ON kortix.developer_invitations(account_id, state, expires_at);

ALTER TABLE kortix.developer_publishers
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS slug varchar(63),
  ADD COLUMN IF NOT EXISTS status kortix.developer_publisher_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS authority_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suspended_reason varchar(1024),
  ADD COLUMN IF NOT EXISTS suspended_by uuid,
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

UPDATE kortix.developer_publishers AS publisher
SET
  organization_id = organization.organization_id,
  slug = publisher.publisher_id
FROM kortix.developer_organizations AS organization
WHERE organization.account_id = publisher.account_id
  AND (publisher.organization_id IS NULL OR publisher.slug IS NULL);

ALTER TABLE kortix.developer_publishers
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN slug SET NOT NULL;

DO $developer_publisher_constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_organization_account_fk'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_organization_account_fk
      FOREIGN KEY (organization_id, account_id)
      REFERENCES kortix.developer_organizations(organization_id, account_id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_publisher_account_organization_unique'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_publisher_account_organization_unique
      UNIQUE (publisher_id, account_id, organization_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_slug_unique'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_slug_unique UNIQUE (slug);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_slug_identity_check'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_slug_identity_check
      CHECK (publisher_id = slug AND slug = lower(slug));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_authority_revision_check'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_authority_revision_check
      CHECK (authority_revision >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'developer_publishers_suspension_check'
      AND conrelid = 'kortix.developer_publishers'::regclass
  ) THEN
    ALTER TABLE kortix.developer_publishers
      ADD CONSTRAINT developer_publishers_suspension_check
      CHECK (
        (
          status = 'active'
          AND suspended_reason IS NULL
          AND suspended_by IS NULL
          AND suspended_at IS NULL
        ) OR (
          status = 'suspended'
          AND length(BTRIM(suspended_reason)) BETWEEN 1 AND 1024
          AND suspended_by IS NOT NULL
          AND suspended_at IS NOT NULL
        )
      );
  END IF;
END
$developer_publisher_constraints$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_developer_publishers_slug_lower_unique
  ON kortix.developer_publishers(lower(slug));
CREATE INDEX IF NOT EXISTS idx_developer_publishers_organization_created
  ON kortix.developer_publishers(organization_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.developer_publisher_members (
  member_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT developer_publisher_members_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  user_id uuid NOT NULL,
  role kortix.developer_publisher_role NOT NULL,
  revision integer NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_publisher_members_publisher_account_fk
    FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_publisher_members_publisher_user_unique
    UNIQUE (publisher_id, user_id),
  CONSTRAINT developer_publisher_members_member_account_unique
    UNIQUE (member_id, account_id),
  CONSTRAINT developer_publisher_members_revision_check
    CHECK (revision >= 0)
);

CREATE INDEX IF NOT EXISTS idx_developer_publisher_members_account_publisher_role
  ON kortix.developer_publisher_members(account_id, publisher_id, role);

INSERT INTO kortix.developer_publisher_members (
  account_id,
  publisher_id,
  user_id,
  role,
  revision,
  created_by,
  created_at,
  updated_at
)
SELECT
  publisher.account_id,
  publisher.publisher_id,
  publisher.created_by,
  'owner'::kortix.developer_publisher_role,
  0,
  publisher.created_by,
  publisher.created_at,
  publisher.updated_at
FROM kortix.developer_publishers AS publisher
ON CONFLICT (publisher_id, user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS kortix.developer_publisher_audit_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT developer_publisher_audit_events_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  organization_id uuid,
  publisher_id varchar(63),
  invitation_id uuid,
  action varchar(64) NOT NULL,
  actor_user_id uuid NOT NULL,
  subject_user_id uuid,
  from_state jsonb,
  to_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_publisher_audit_events_event_account_unique
    UNIQUE (event_id, account_id),
  CONSTRAINT developer_publisher_audit_events_organization_account_fk
    FOREIGN KEY (organization_id, account_id)
    REFERENCES kortix.developer_organizations(organization_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_publisher_audit_events_publisher_account_fk
    FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_publisher_audit_events_invitation_account_fk
    FOREIGN KEY (invitation_id, account_id)
    REFERENCES kortix.developer_invitations(invitation_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_publisher_audit_events_resource_check
    CHECK (
      organization_id IS NOT NULL
      OR publisher_id IS NOT NULL
      OR invitation_id IS NOT NULL
    ),
  CONSTRAINT developer_publisher_audit_events_action_check
    CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT developer_publisher_audit_events_json_check
    CHECK (
      (from_state IS NULL OR jsonb_typeof(from_state) = 'object')
      AND (to_state IS NULL OR jsonb_typeof(to_state) = 'object')
      AND jsonb_typeof(metadata) = 'object'
      AND COALESCE(pg_column_size(from_state), 0)
        + COALESCE(pg_column_size(to_state), 0)
        + pg_column_size(metadata) <= 16384
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_publisher_audit_events_account_created
  ON kortix.developer_publisher_audit_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_developer_publisher_audit_events_publisher_created
  ON kortix.developer_publisher_audit_events(publisher_id, created_at);

CREATE OR REPLACE FUNCTION kortix.assert_developer_publisher_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_publisher_id varchar(63);
  target_account_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'developer_publishers' THEN
    IF TG_OP = 'DELETE' THEN
      target_publisher_id := OLD.publisher_id;
      target_account_id := OLD.account_id;
    ELSE
      target_publisher_id := NEW.publisher_id;
      target_account_id := NEW.account_id;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    target_publisher_id := OLD.publisher_id;
    target_account_id := OLD.account_id;
  ELSE
    target_publisher_id := NEW.publisher_id;
    target_account_id := NEW.account_id;
  END IF;

  PERFORM 1
  FROM kortix.developer_publishers
  WHERE publisher_id = target_publisher_id
    AND account_id = target_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  PERFORM 1
  FROM kortix.developer_publisher_members
  WHERE publisher_id = target_publisher_id
    AND account_id = target_account_id
    AND role = 'owner';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'developer_publishers_owner_present'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS developer_publishers_owner_present
  ON kortix.developer_publishers;
CREATE CONSTRAINT TRIGGER developer_publishers_owner_present
AFTER INSERT OR UPDATE ON kortix.developer_publishers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION kortix.assert_developer_publisher_owner();

DROP TRIGGER IF EXISTS developer_publisher_members_owner_present
  ON kortix.developer_publisher_members;
CREATE CONSTRAINT TRIGGER developer_publisher_members_owner_present
AFTER INSERT OR UPDATE OR DELETE ON kortix.developer_publisher_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION kortix.assert_developer_publisher_owner();

CREATE OR REPLACE FUNCTION kortix.reject_developer_publisher_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'developer publisher audit events are append-only'
    USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS developer_publisher_audit_events_append_only
  ON kortix.developer_publisher_audit_events;
CREATE TRIGGER developer_publisher_audit_events_append_only
BEFORE UPDATE OR DELETE ON kortix.developer_publisher_audit_events
FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_publisher_audit_event_mutation();

REVOKE ALL
  ON TABLE
    kortix.developer_invitations,
    kortix.developer_organizations,
    kortix.developer_publishers,
    kortix.developer_publisher_members,
    kortix.developer_publisher_audit_events
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE
    kortix.developer_invitations,
    kortix.developer_organizations,
    kortix.developer_publishers,
    kortix.developer_publisher_members,
    kortix.developer_publisher_audit_events
  TO service_role;

GRANT UPDATE (state, accepted_by, accepted_at, revoked_by, revoked_at)
  ON TABLE kortix.developer_invitations
  TO service_role;

GRANT UPDATE (
  verification_state,
  verification_metadata,
  verification_revision,
  verification_changed_by,
  verification_changed_at,
  updated_at
)
  ON TABLE kortix.developer_organizations
  TO service_role;

GRANT UPDATE (
  display_name,
  status,
  authority_revision,
  suspended_reason,
  suspended_by,
  suspended_at,
  updated_at
)
  ON TABLE kortix.developer_publishers
  TO service_role;

GRANT UPDATE (role, revision, updated_by, updated_at), DELETE
  ON TABLE kortix.developer_publisher_members
  TO service_role;

REVOKE ALL
  ON FUNCTION
    kortix.assert_developer_publisher_owner(),
    kortix.reject_developer_publisher_audit_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
