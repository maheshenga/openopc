DO $developer$
BEGIN
  CREATE TYPE kortix.developer_module_release_status AS ENUM (
    'validated',
    'review_pending',
    'changes_requested',
    'approved',
    'signed',
    'published',
    'revoked',
    'deprecated'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

CREATE TABLE IF NOT EXISTS kortix.developer_publishers (
  publisher_id varchar(63) PRIMARY KEY,
  account_id uuid NOT NULL
    CONSTRAINT developer_publishers_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  display_name varchar(255) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_publishers_publisher_account_unique
    UNIQUE (publisher_id, account_id),
  CONSTRAINT developer_publishers_id_check
    CHECK (publisher_id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT developer_publishers_display_name_check
    CHECK (length(BTRIM(display_name)) BETWEEN 1 AND 255)
);

CREATE INDEX IF NOT EXISTS idx_developer_publishers_account_created
  ON kortix.developer_publishers(account_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.developer_module_releases (
  release_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL
    CONSTRAINT developer_module_releases_account_fk
    REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  publisher_id varchar(63) NOT NULL,
  item_name varchar(128) NOT NULL,
  module_id varchar(128) NOT NULL,
  module_version varchar(128) NOT NULL,
  manifest jsonb NOT NULL,
  manifest_digest varchar(71) NOT NULL,
  review_requirements jsonb NOT NULL,
  status kortix.developer_module_release_status NOT NULL DEFAULT 'validated',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_releases_publisher_account_fk
    FOREIGN KEY (publisher_id, account_id)
    REFERENCES kortix.developer_publishers(publisher_id, account_id)
    ON DELETE RESTRICT,
  CONSTRAINT developer_module_releases_module_version_unique
    UNIQUE (module_id, module_version),
  CONSTRAINT developer_module_releases_item_name_check
    CHECK (item_name ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT developer_module_releases_namespace_check
    CHECK (
      module_id ~ '^[a-z0-9]+(?:[.-][a-z0-9]+)+$'
      AND module_id LIKE (publisher_id || '.%')
    ),
  CONSTRAINT developer_module_releases_version_check
    CHECK (
      module_version ~ '^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?(?:[+][0-9A-Za-z-]+(?:[.][0-9A-Za-z-]+)*)?$'
    ),
  CONSTRAINT developer_module_releases_manifest_check
    CHECK (
      jsonb_typeof(manifest) = 'object'
      AND pg_column_size(manifest) <= 262144
    ),
  CONSTRAINT developer_module_releases_digest_check
    CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  CONSTRAINT developer_module_releases_review_requirements_check
    CHECK (
      jsonb_typeof(review_requirements) = 'array'
      AND jsonb_array_length(review_requirements) BETWEEN 2 AND 16
      AND pg_column_size(review_requirements) <= 4096
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_releases_account_created
  ON kortix.developer_module_releases(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_developer_module_releases_account_status_created
  ON kortix.developer_module_releases(account_id, status, created_at);

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
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS developer_module_releases_content_immutable
  ON kortix.developer_module_releases;
CREATE TRIGGER developer_module_releases_content_immutable
BEFORE UPDATE ON kortix.developer_module_releases
FOR EACH ROW EXECUTE FUNCTION kortix.protect_developer_module_release_content();

REVOKE ALL
  ON TABLE
    kortix.developer_publishers,
    kortix.developer_module_releases
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE
    kortix.developer_publishers,
    kortix.developer_module_releases
  TO service_role;

GRANT UPDATE (status, updated_at)
  ON TABLE kortix.developer_module_releases
  TO service_role;

REVOKE ALL ON FUNCTION kortix.protect_developer_module_release_content()
  FROM PUBLIC, anon, authenticated, service_role;
