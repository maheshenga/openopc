-- Best-effort convenience only. The authoritative deployment prerequisite is
-- that the runtime API login is a member of developer_artifact_retention_worker:
--
--   GRANT developer_artifact_retention_worker TO <api_login_role>;
--
-- A DBA should execute that GRANT once. This migration attempts it only when
-- kortix.retention_runtime_role explicitly names the runtime login. It must not
-- infer the login from session_user: deploy-prod.yml runs migrations with
-- PROD_DATABASE_URL, while the API runtime uses a separately configured
-- DATABASE_URL secret, so their login roles are not guaranteed to match.
DO $developer_artifact_retention_role_membership$
DECLARE
  runtime_role_name text := NULLIF(
    pg_catalog.current_setting('kortix.retention_runtime_role', true),
    ''
  );
  runtime_role_oid oid;
  worker_role_oid oid;
BEGIN
  SELECT role.oid
  INTO worker_role_oid
  FROM pg_catalog.pg_roles role
  WHERE role.rolname = 'developer_artifact_retention_worker';

  IF worker_role_oid IS NULL OR runtime_role_name IS NULL THEN
    RETURN;
  END IF;

  SELECT role.oid
  INTO runtime_role_oid
  FROM pg_catalog.pg_roles role
  WHERE role.rolname = runtime_role_name;

  IF runtime_role_oid IS NULL THEN
    RAISE NOTICE
      'Configured retention runtime role "%" does not exist; skipping membership grant',
      runtime_role_name;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = worker_role_oid
      AND membership.member = runtime_role_oid
  ) AND NOT pg_catalog.pg_has_role(
    runtime_role_oid,
    worker_role_oid,
    'MEMBER'
  ) THEN
    BEGIN
      EXECUTE pg_catalog.format(
        'GRANT %I TO %I',
        'developer_artifact_retention_worker',
        runtime_role_name
      );
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE WARNING '%', pg_catalog.format(
          'Could not grant developer_artifact_retention_worker to %I; a DBA must run: GRANT developer_artifact_retention_worker TO %I;',
          runtime_role_name,
          runtime_role_name
        );
    END;
  END IF;
END
$developer_artifact_retention_role_membership$;
