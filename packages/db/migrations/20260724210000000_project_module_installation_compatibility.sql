-- Follow-up for 20260724180000000. This migration is intentionally separate:
-- the original distribution migration may already have run in a self-hosted
-- Kortix deployment.

ALTER TABLE kortix.project_module_installation_events
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(128);

DO $developer$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installations_release_identity_fk'
      AND conrelid = 'kortix.project_module_installations'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installations
      DROP CONSTRAINT project_module_installations_release_identity_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installations_release_identity_fk'
      AND conrelid = 'kortix.project_module_installations'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installations
      ADD CONSTRAINT project_module_installations_release_identity_fk
      FOREIGN KEY (active_release_id)
      REFERENCES kortix.developer_module_releases(release_id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_from_release_account_fk'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      DROP CONSTRAINT project_module_installation_events_from_release_account_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_from_release_account_fk'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      ADD CONSTRAINT project_module_installation_events_from_release_account_fk
      FOREIGN KEY (from_release_id)
      REFERENCES kortix.developer_module_releases(release_id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_to_release_account_fk'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      DROP CONSTRAINT project_module_installation_events_to_release_account_fk;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_to_release_account_fk'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      ADD CONSTRAINT project_module_installation_events_to_release_account_fk
      FOREIGN KEY (to_release_id)
      REFERENCES kortix.developer_module_releases(release_id)
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_account_project_idempotency_unique'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      ADD CONSTRAINT project_module_installation_events_account_project_idempotency_unique
      UNIQUE (account_id, project_id, idempotency_key);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'project_module_installation_events_idempotency_key_check'
      AND conrelid = 'kortix.project_module_installation_events'::regclass
  ) THEN
    ALTER TABLE kortix.project_module_installation_events
      ADD CONSTRAINT project_module_installation_events_idempotency_key_check
      CHECK (
        idempotency_key IS NULL
        OR idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );
  END IF;
END
$developer$;
