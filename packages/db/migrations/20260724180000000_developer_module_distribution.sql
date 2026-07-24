DO $developer$
BEGIN
  CREATE TYPE kortix.developer_module_distribution_action AS ENUM (
    'sign',
    'publish',
    'revoke'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

DO $developer$
BEGIN
  CREATE TYPE kortix.project_module_installation_status AS ENUM (
    'active',
    'blocked'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

DO $developer$
BEGIN
  CREATE TYPE kortix.project_module_installation_action AS ENUM (
    'install',
    'update',
    'rollback'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

ALTER TABLE kortix.developer_module_releases
  ADD COLUMN IF NOT EXISTS signature_algorithm varchar(16),
  ADD COLUMN IF NOT EXISTS signature_key_id varchar(128),
  ADD COLUMN IF NOT EXISTS signature varchar(96),
  ADD COLUMN IF NOT EXISTS signature_payload_digest varchar(71),
  ADD COLUMN IF NOT EXISTS signed_at timestamptz,
  ADD COLUMN IF NOT EXISTS published_at timestamptz,
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

DO $developer$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_signature_consistency_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_signature_consistency_check
      CHECK (
        (
          (
            signature_algorithm IS NULL
            AND signature_key_id IS NULL
            AND signature IS NULL
            AND signature_payload_digest IS NULL
            AND signed_at IS NULL
          )
          OR (
            signature_algorithm = 'ed25519'
            AND signature_key_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND signature ~ '^base64url:[A-Za-z0-9_-]{86}$'
            AND signature_payload_digest ~ '^sha256:[0-9a-f]{64}$'
            AND signed_at IS NOT NULL
          )
        )
        AND (
          status NOT IN ('signed', 'published')
          OR signature_algorithm IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_lifecycle_timestamps_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_lifecycle_timestamps_check
      CHECK (
        (
          (status IN ('published', 'deprecated') AND published_at IS NOT NULL)
          OR (status NOT IN ('published', 'deprecated', 'revoked') AND published_at IS NULL)
          OR status = 'revoked'
        )
        AND (status = 'revoked' OR revoked_at IS NULL)
        AND (
          status <> 'revoked'
          OR signature_algorithm IS NULL
          OR revoked_at IS NOT NULL
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_installation_identity_unique'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_installation_identity_unique
      UNIQUE (release_id, account_id, module_id, module_version);
  END IF;
END
$developer$;

CREATE TABLE IF NOT EXISTS kortix.developer_module_release_distribution_events (
  distribution_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL,
  account_id uuid NOT NULL,
  sequence integer NOT NULL,
  action kortix.developer_module_distribution_action NOT NULL,
  from_status kortix.developer_module_release_status NOT NULL,
  to_status kortix.developer_module_release_status NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_kind kortix.developer_module_review_actor_kind NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_release_distribution_events_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_release_distribution_events_release_sequence_unique
    UNIQUE (release_id, sequence),
  CONSTRAINT developer_module_release_distribution_events_sequence_check
    CHECK (sequence > 0),
  CONSTRAINT developer_module_release_distribution_events_reason_check
    CHECK (
      (
        reason IS NULL
        OR (
          length(BTRIM(reason)) BETWEEN 1 AND 4000
          AND octet_length(reason) <= 8192
        )
      )
      AND (action <> 'revoke' OR reason IS NOT NULL)
    ),
  CONSTRAINT developer_module_release_distribution_events_transition_check
    CHECK (
      actor_kind = 'platform_admin'
      AND (
        (
          action = 'sign'
          AND from_status = 'approved'
          AND to_status = 'signed'
        ) OR (
          action = 'publish'
          AND from_status = 'signed'
          AND to_status = 'published'
        ) OR (
          action = 'revoke'
          AND from_status IN ('signed', 'published')
          AND to_status = 'revoked'
        )
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_release_distribution_events_account_release_sequence
  ON kortix.developer_module_release_distribution_events(account_id, release_id, sequence);

CREATE TABLE IF NOT EXISTS kortix.project_module_installations (
  installation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  module_id varchar(128) NOT NULL,
  active_release_id uuid NOT NULL,
  active_version varchar(128) NOT NULL,
  install_revision integer NOT NULL DEFAULT 0,
  status kortix.project_module_installation_status NOT NULL DEFAULT 'active',
  installed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_installations_project_account_fk
    FOREIGN KEY (project_id, account_id)
    REFERENCES kortix.projects(project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_installations_release_identity_fk
    FOREIGN KEY (active_release_id, account_id, module_id, active_version)
    REFERENCES kortix.developer_module_releases(
      release_id,
      account_id,
      module_id,
      module_version
    )
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT project_module_installations_project_module_unique
    UNIQUE (project_id, module_id),
  CONSTRAINT project_module_installations_identity_unique
    UNIQUE (installation_id, project_id, account_id),
  CONSTRAINT project_module_installations_module_id_check
    CHECK (module_id ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)+$'),
  CONSTRAINT project_module_installations_active_version_check
    CHECK (
      active_version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$'
    ),
  CONSTRAINT project_module_installations_revision_check
    CHECK (install_revision >= 0)
);

CREATE INDEX IF NOT EXISTS idx_project_module_installations_account_project
  ON kortix.project_module_installations(account_id, project_id);
CREATE INDEX IF NOT EXISTS idx_project_module_installations_active_release
  ON kortix.project_module_installations(active_release_id);

CREATE TABLE IF NOT EXISTS kortix.project_module_installation_events (
  installation_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id uuid NOT NULL,
  project_id uuid NOT NULL,
  account_id uuid NOT NULL,
  sequence integer NOT NULL,
  action kortix.project_module_installation_action NOT NULL,
  from_release_id uuid,
  to_release_id uuid NOT NULL,
  expected_revision integer NOT NULL,
  resulting_revision integer NOT NULL,
  actor_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_module_installation_events_installation_identity_fk
    FOREIGN KEY (installation_id, project_id, account_id)
    REFERENCES kortix.project_module_installations(installation_id, project_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT project_module_installation_events_from_release_account_fk
    FOREIGN KEY (from_release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT project_module_installation_events_to_release_account_fk
    FOREIGN KEY (to_release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT project_module_installation_events_installation_sequence_unique
    UNIQUE (installation_id, sequence),
  CONSTRAINT project_module_installation_events_revision_check
    CHECK (
      sequence > 0
      AND expected_revision >= 0
      AND resulting_revision = expected_revision + 1
      AND sequence = resulting_revision
    ),
  CONSTRAINT project_module_installation_events_transition_check
    CHECK (
      (
        action = 'install'
        AND from_release_id IS NULL
        AND expected_revision = 0
        AND resulting_revision = 1
      ) OR (
        action IN ('update', 'rollback')
        AND from_release_id IS NOT NULL
        AND from_release_id <> to_release_id
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_project_module_installation_events_account_project_installation_sequence
  ON kortix.project_module_installation_events(account_id, project_id, installation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_project_module_installation_events_from_release
  ON kortix.project_module_installation_events(from_release_id);
CREATE INDEX IF NOT EXISTS idx_project_module_installation_events_to_release
  ON kortix.project_module_installation_events(to_release_id);

CREATE OR REPLACE FUNCTION kortix.protect_developer_module_release_content()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.account_id,
    NEW.publisher_id,
    NEW.item_name,
    NEW.module_id,
    NEW.module_version,
    NEW.manifest,
    NEW.manifest_digest,
    NEW.review_requirements,
    NEW.created_by,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.account_id,
    OLD.publisher_id,
    OLD.item_name,
    OLD.module_id,
    OLD.module_version,
    OLD.manifest,
    OLD.manifest_digest,
    OLD.review_requirements,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'developer module release content is immutable';
  END IF;

  IF ROW(
    NEW.signature_algorithm,
    NEW.signature_key_id,
    NEW.signature,
    NEW.signature_payload_digest,
    NEW.signed_at
  ) IS DISTINCT FROM ROW(
    OLD.signature_algorithm,
    OLD.signature_key_id,
    OLD.signature,
    OLD.signature_payload_digest,
    OLD.signed_at
  ) AND NOT (
    OLD.status = 'approved'
    AND NEW.status = 'signed'
  ) THEN
    RAISE EXCEPTION 'developer module signature may only change during signing';
  END IF;

  IF NEW.published_at IS DISTINCT FROM OLD.published_at
    AND NOT (OLD.status = 'signed' AND NEW.status = 'published') THEN
    RAISE EXCEPTION 'developer module publication timestamp may only change during distribution';
  END IF;

  IF NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
    AND NOT (
      OLD.status IN ('signed', 'published')
      AND NEW.status = 'revoked'
    ) THEN
    RAISE EXCEPTION 'developer module revocation timestamp may only change during revocation';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS developer_module_releases_content_immutable
  ON kortix.developer_module_releases;
CREATE TRIGGER developer_module_releases_content_immutable
BEFORE UPDATE ON kortix.developer_module_releases
FOR EACH ROW EXECUTE FUNCTION kortix.protect_developer_module_release_content();

-- A release delete may legitimately cascade its distribution history (for
-- example, when an account is deleted). The child trigger therefore allows a
-- DELETE only after the owning release has disappeared. Direct event deletes
-- while the parent still exists remain append-only violations.
DROP TRIGGER IF EXISTS developer_module_releases_allow_distribution_event_cascade
  ON kortix.developer_module_releases;

CREATE OR REPLACE FUNCTION kortix.reject_developer_module_distribution_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM kortix.developer_module_releases AS release
      WHERE release.release_id = OLD.release_id
        AND release.account_id = OLD.account_id
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'developer module distribution events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS developer_module_release_distribution_events_append_only
  ON kortix.developer_module_release_distribution_events;
CREATE TRIGGER developer_module_release_distribution_events_append_only
BEFORE UPDATE OR DELETE ON kortix.developer_module_release_distribution_events
FOR EACH ROW EXECUTE FUNCTION kortix.reject_developer_module_distribution_event_mutation();

-- Apply the same parent-existence rule to installation history so deleting a
-- project can cascade its installation and event rows without permitting a
-- direct history mutation.
DROP TRIGGER IF EXISTS project_module_installations_allow_event_cascade
  ON kortix.project_module_installations;

CREATE OR REPLACE FUNCTION kortix.reject_project_module_installation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM kortix.project_module_installations AS installation
      WHERE installation.installation_id = OLD.installation_id
        AND installation.project_id = OLD.project_id
        AND installation.account_id = OLD.account_id
    ) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'project module installation events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS project_module_installation_events_append_only
  ON kortix.project_module_installation_events;
CREATE TRIGGER project_module_installation_events_append_only
BEFORE UPDATE OR DELETE ON kortix.project_module_installation_events
FOR EACH ROW EXECUTE FUNCTION kortix.reject_project_module_installation_event_mutation();

REVOKE UPDATE (
  status,
  review_revision,
  updated_at
)
ON TABLE kortix.developer_module_releases
FROM service_role;

GRANT UPDATE (
  status,
  review_revision,
  signature_algorithm,
  signature_key_id,
  signature,
  signature_payload_digest,
  signed_at,
  published_at,
  revoked_at,
  updated_at
)
ON TABLE kortix.developer_module_releases
TO service_role;

REVOKE ALL
  ON TABLE
    kortix.developer_module_release_distribution_events,
    kortix.project_module_installations,
    kortix.project_module_installation_events
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.developer_module_release_distribution_events
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.project_module_installations
  TO service_role;

GRANT UPDATE (
  active_release_id,
  active_version,
  install_revision,
  status,
  updated_at
)
  ON TABLE kortix.project_module_installations
  TO service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.project_module_installation_events
  TO service_role;

REVOKE ALL
  ON FUNCTION
    kortix.protect_developer_module_release_content(),
    kortix.reject_developer_module_distribution_event_mutation(),
    kortix.reject_project_module_installation_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION IF EXISTS kortix.mark_developer_module_distribution_event_cascade();
DROP FUNCTION IF EXISTS kortix.mark_project_module_installation_event_cascade();
