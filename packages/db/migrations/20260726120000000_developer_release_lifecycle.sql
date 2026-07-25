ALTER TYPE kortix.developer_module_release_status
  ADD VALUE IF NOT EXISTS 'draft' BEFORE 'validated';
ALTER TYPE kortix.developer_module_release_status
  ADD VALUE IF NOT EXISTS 'uploaded' BEFORE 'validated';
ALTER TYPE kortix.developer_module_release_status
  ADD VALUE IF NOT EXISTS 'verifying' AFTER 'validated';

ALTER TABLE kortix.developer_module_releases
  ADD COLUMN IF NOT EXISTS runtime_descriptor_digest varchar(71),
  ADD COLUMN IF NOT EXISTS runtime_descriptor_path varchar(512),
  ADD COLUMN IF NOT EXISTS runtime_kind varchar(32);

DO $developer_runtime_descriptor_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_runtime_descriptor_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_runtime_descriptor_check
      CHECK (
        (
          manifest #>> '{execution,mode}' = 'server-adapter'
          AND runtime_descriptor_digest ~ '^sha256:[0-9a-f]{64}$'
          AND runtime_descriptor_path = manifest #>> '{execution,entry}'
          AND runtime_descriptor_path ~ '(^|/)openopc[.]runtime[.]json$'
          AND runtime_kind IN ('wasi-component', 'oci-image')
        ) OR (
          manifest #>> '{execution,mode}' IN (
            'declarative',
            'agent',
            'sandboxed-web',
            'desktop-native'
          )
          AND runtime_descriptor_digest IS NULL
          AND runtime_descriptor_path IS NULL
          AND runtime_kind IS NULL
        )
      );
  END IF;
END
$developer_runtime_descriptor_constraint$;

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
    NEW.artifact_id,
    NEW.artifact_digest,
    NEW.runtime_descriptor_digest,
    NEW.runtime_descriptor_path,
    NEW.runtime_kind,
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
    OLD.artifact_id,
    OLD.artifact_digest,
    OLD.runtime_descriptor_digest,
    OLD.runtime_descriptor_path,
    OLD.runtime_kind,
    OLD.created_by,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'developer module release content is immutable';
  END IF;

  IF ROW(
    NEW.sbom_digest,
    NEW.trust_attestation_digest,
    NEW.verification_policy_digest
  ) IS DISTINCT FROM ROW(
    OLD.sbom_digest,
    OLD.trust_attestation_digest,
    OLD.verification_policy_digest
  ) AND OLD.status IN ('signed', 'published', 'revoked', 'deprecated') THEN
    RAISE EXCEPTION 'developer module release trust binding is immutable after signing';
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
      OLD.status IN ('signed', 'published', 'deprecated')
      AND NEW.status = 'revoked'
    ) THEN
    RAISE EXCEPTION 'developer module revocation timestamp may only change during revocation';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION kortix.protect_developer_module_release_content()
  FROM PUBLIC, anon, authenticated, service_role, developer_trust_worker;
