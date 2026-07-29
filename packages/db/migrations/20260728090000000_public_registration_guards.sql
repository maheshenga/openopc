CREATE TABLE IF NOT EXISTS kortix.public_registration_decisions (
  jti_hash varchar(71) PRIMARY KEY,
  email_digest varchar(71) NOT NULL,
  device_digest varchar(71) NOT NULL,
  account_digest varchar(71),
  action varchar(20) NOT NULL,
  policy_versions jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_registration_decisions_digest_check CHECK (
    jti_hash ~ '^sha256:[0-9a-f]{64}$'
    AND email_digest ~ '^sha256:[0-9a-f]{64}$'
    AND device_digest ~ '^sha256:[0-9a-f]{64}$'
    AND (account_digest IS NULL OR account_digest ~ '^sha256:[0-9a-f]{64}$')
  ),
  CONSTRAINT public_registration_decisions_action_check CHECK (
    action IN ('signup', 'magic-link')
  ),
  CONSTRAINT public_registration_decisions_policy_check CHECK (
    jsonb_typeof(policy_versions) = 'object'
    AND policy_versions = jsonb_build_object(
      'terms', policy_versions->'terms',
      'privacy', policy_versions->'privacy',
      'acceptableUse', policy_versions->'acceptableUse'
    )
    AND (policy_versions->>'terms') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND (policy_versions->>'privacy') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND (policy_versions->>'acceptableUse') ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
    AND lower(policy_versions->>'terms') NOT IN ('latest', 'current', 'draft', 'unpublished')
    AND lower(policy_versions->>'privacy') NOT IN ('latest', 'current', 'draft', 'unpublished')
    AND lower(policy_versions->>'acceptableUse') NOT IN ('latest', 'current', 'draft', 'unpublished')
  ),
  CONSTRAINT public_registration_decisions_expiry_check CHECK (
    expires_at = issued_at + interval '5 minutes'
  ),
  CONSTRAINT public_registration_decisions_consumption_check CHECK (
    consumed_at IS NULL OR (
      consumed_at >= issued_at
      AND consumed_at < expires_at
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_public_registration_decisions_expires
  ON kortix.public_registration_decisions(expires_at);
CREATE INDEX IF NOT EXISTS idx_public_registration_decisions_email_expires
  ON kortix.public_registration_decisions(email_digest, expires_at);

CREATE TABLE IF NOT EXISTS kortix.public_registration_rate_buckets (
  dimension_kind varchar(16) NOT NULL,
  dimension_key_hash varchar(71) NOT NULL,
  window_started_at timestamptz NOT NULL,
  capacity_limit integer NOT NULL,
  window_seconds integer NOT NULL,
  request_count integer NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT public_registration_rate_buckets_pkey PRIMARY KEY (
    dimension_kind,
    dimension_key_hash,
    window_started_at
  ),
  CONSTRAINT public_registration_rate_buckets_kind_check CHECK (
    dimension_kind IN ('ip', 'device', 'email', 'account', 'action')
  ),
  CONSTRAINT public_registration_rate_buckets_hash_check CHECK (
    dimension_key_hash ~ '^sha256:[0-9a-f]{64}$'
  ),
  CONSTRAINT public_registration_rate_buckets_limits_check CHECK (
    capacity_limit BETWEEN 1 AND 10000
    AND window_seconds BETWEEN 60 AND 86400
    AND request_count >= 1
  ),
  CONSTRAINT public_registration_rate_buckets_window_check CHECK (
    expires_at = window_started_at + make_interval(secs => window_seconds)
    AND updated_at >= window_started_at
  )
);

CREATE INDEX IF NOT EXISTS idx_public_registration_rate_buckets_expires
  ON kortix.public_registration_rate_buckets(expires_at);

CREATE OR REPLACE FUNCTION kortix.reject_public_registration_decision_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'public registration decisions are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.jti_hash IS DISTINCT FROM OLD.jti_hash
    OR NEW.email_digest IS DISTINCT FROM OLD.email_digest
    OR NEW.device_digest IS DISTINCT FROM OLD.device_digest
    OR NEW.account_digest IS DISTINCT FROM OLD.account_digest
    OR NEW.action IS DISTINCT FROM OLD.action
    OR NEW.policy_versions IS DISTINCT FROM OLD.policy_versions
    OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR OLD.consumed_at IS NOT NULL
    OR NEW.consumed_at IS NULL
  THEN
    RAISE EXCEPTION 'public registration decisions are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS public_registration_decisions_immutable
  ON kortix.public_registration_decisions;
CREATE TRIGGER public_registration_decisions_immutable
BEFORE UPDATE OR DELETE ON kortix.public_registration_decisions
FOR EACH ROW EXECUTE FUNCTION kortix.reject_public_registration_decision_mutation();

CREATE OR REPLACE FUNCTION kortix.authorize_public_registration_decision(
  p_dimensions jsonb,
  p_persist_decision boolean,
  p_jti_hash varchar,
  p_email_digest varchar,
  p_device_digest varchar,
  p_account_digest varchar,
  p_action varchar,
  p_policy_versions jsonb,
  p_issued_at timestamptz,
  p_expires_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  dimension record;
  dimension_count integer := 0;
  current_count integer;
  inserted_count integer;
  kinds text[] := ARRAY[]::text[];
  window_start timestamptz;
  exhausted boolean := false;
BEGIN
  IF jsonb_typeof(p_dimensions) <> 'array' THEN
    RAISE EXCEPTION 'public registration dimensions invalid'
      USING ERRCODE = '22023';
  END IF;

  FOR dimension IN
    SELECT *
    FROM jsonb_to_recordset(p_dimensions) AS value(
      kind text,
      "keyHash" text,
      "limit" integer,
      "windowSeconds" integer
    )
  LOOP
    dimension_count := dimension_count + 1;
    IF dimension.kind NOT IN ('ip', 'device', 'email', 'account', 'action')
      OR dimension."keyHash" !~ '^sha256:[0-9a-f]{64}$'
      OR dimension."limit" NOT BETWEEN 1 AND 10000
      OR dimension."windowSeconds" NOT BETWEEN 60 AND 86400
      OR dimension.kind = ANY(kinds)
    THEN
      RAISE EXCEPTION 'public registration dimension invalid'
        USING ERRCODE = '22023';
    END IF;
    kinds := array_append(kinds, dimension.kind);
    window_start := to_timestamp(
      floor(extract(epoch FROM p_issued_at) / dimension."windowSeconds")
      * dimension."windowSeconds"
    );

    current_count := NULL;
    INSERT INTO kortix.public_registration_rate_buckets AS bucket (
      dimension_kind,
      dimension_key_hash,
      window_started_at,
      capacity_limit,
      window_seconds,
      request_count,
      expires_at,
      updated_at
    ) VALUES (
      dimension.kind,
      dimension."keyHash",
      window_start,
      dimension."limit",
      dimension."windowSeconds",
      1,
      window_start + make_interval(secs => dimension."windowSeconds"),
      p_issued_at
    )
    ON CONFLICT (dimension_kind, dimension_key_hash, window_started_at)
    DO UPDATE SET
      request_count = bucket.request_count + 1,
      updated_at = EXCLUDED.updated_at
    WHERE bucket.capacity_limit = EXCLUDED.capacity_limit
      AND bucket.window_seconds = EXCLUDED.window_seconds
    RETURNING request_count INTO current_count;

    IF current_count IS NULL THEN
      RAISE EXCEPTION 'public registration rate policy mismatch'
        USING ERRCODE = '22023';
    END IF;
    IF current_count > dimension."limit" THEN
      exhausted := true;
    END IF;
  END LOOP;

  IF dimension_count NOT IN (4, 5)
    OR NOT kinds @> ARRAY['ip', 'device', 'email', 'action']::text[]
    OR (dimension_count = 5 AND NOT kinds @> ARRAY['account']::text[])
  THEN
    RAISE EXCEPTION 'public registration dimensions invalid'
      USING ERRCODE = '22023';
  END IF;

  IF exhausted THEN
    RETURN false;
  END IF;

  IF NOT p_persist_decision THEN
    RETURN true;
  END IF;

  INSERT INTO kortix.public_registration_decisions (
    jti_hash,
    email_digest,
    device_digest,
    account_digest,
    action,
    policy_versions,
    issued_at,
    expires_at
  ) VALUES (
    p_jti_hash,
    p_email_digest,
    p_device_digest,
    p_account_digest,
    p_action,
    p_policy_versions,
    p_issued_at,
    p_expires_at
  )
  ON CONFLICT (jti_hash) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count = 1;
END;
$$;

CREATE OR REPLACE FUNCTION kortix.consume_public_registration_decision(
  p_jti_hash varchar,
  p_now timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE kortix.public_registration_decisions AS decision
  SET consumed_at = p_now
  WHERE decision.jti_hash = p_jti_hash
    AND decision.consumed_at IS NULL
    AND decision.issued_at <= p_now
    AND decision.expires_at > p_now;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count = 1;
END;
$$;

REVOKE ALL
  ON TABLE
    kortix.public_registration_decisions,
    kortix.public_registration_rate_buckets
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT
  ON TABLE
    kortix.public_registration_decisions,
    kortix.public_registration_rate_buckets
  TO service_role;

REVOKE ALL
  ON FUNCTION
    kortix.reject_public_registration_decision_mutation(),
    kortix.authorize_public_registration_decision(
      jsonb,
      boolean,
      varchar,
      varchar,
      varchar,
      varchar,
      varchar,
      jsonb,
      timestamptz,
      timestamptz
    ),
    kortix.consume_public_registration_decision(varchar, timestamptz)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE
  ON FUNCTION
    kortix.authorize_public_registration_decision(
      jsonb,
      boolean,
      varchar,
      varchar,
      varchar,
      varchar,
      varchar,
      jsonb,
      timestamptz,
      timestamptz
    ),
    kortix.consume_public_registration_decision(varchar, timestamptz)
  TO service_role;
