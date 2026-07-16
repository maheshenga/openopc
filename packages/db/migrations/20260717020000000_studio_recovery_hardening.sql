-- Studio recovery forward hardening.
-- This migration intentionally redefines the recovery RPCs so databases that
-- already recorded the preceding migration name still receive the fixes.

-- Acquire the strongest affected-table locks before taking any row lock.
-- If live traffic owns an incompatible lock, fail quickly and let the deploy
-- retry the whole single transaction without a partial backfill.
SET LOCAL lock_timeout = '5s';
LOCK TABLE kortix.studio_billing_incidents IN ACCESS EXCLUSIVE MODE;
LOCK TABLE kortix.studio_credit_reservations IN ACCESS EXCLUSIVE MODE;
LOCK TABLE kortix.studio_usage_events IN ACCESS EXCLUSIVE MODE;
SET LOCAL lock_timeout = '0';

UPDATE kortix.studio_credit_reservations reservation
SET created_at = COALESCE(
  CASE
    WHEN job.created_at IS NOT NULL
      AND job.created_at::text NOT IN ('infinity', '-infinity')
      AND job.created_at <= clock_timestamp()
    THEN job.created_at
    ELSE NULL
  END,
  clock_timestamp() - interval '30 days'
)
FROM kortix.studio_jobs job
WHERE reservation.job_id = job.job_id
  AND (
    reservation.created_at IS NULL
    OR reservation.created_at::text IN ('infinity', '-infinity')
    OR reservation.created_at > clock_timestamp()
  );

ALTER TABLE kortix.studio_credit_reservations
  ALTER COLUMN created_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'studio_credit_reservations_created_at_finite_check'
      AND conrelid = 'kortix.studio_credit_reservations'::regclass
  ) THEN
    ALTER TABLE kortix.studio_credit_reservations
      ADD CONSTRAINT studio_credit_reservations_created_at_finite_check
      CHECK (created_at NOT IN ('infinity'::timestamptz, '-infinity'::timestamptz));
  END IF;
END
$$;

ALTER TABLE kortix.studio_credit_reservations
  VALIDATE CONSTRAINT studio_credit_reservations_created_at_finite_check;

ALTER TABLE kortix.studio_usage_events
  ALTER COLUMN platform_loss_credits TYPE numeric(20,4);

ALTER TABLE kortix.studio_billing_incidents
  ALTER COLUMN verified_cost_credits TYPE numeric(20,4),
  ALTER COLUMN potential_liability_credits TYPE numeric(20,4);

CREATE OR REPLACE FUNCTION kortix.prevent_studio_reservation_created_at_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
  -- Database owners retain an explicit repair path for migrations and audited
  -- operations; runtime roles cannot rewrite the cumulative-hold anchor.
  IF TG_OP = 'UPDATE'
    AND pg_catalog.pg_has_role(current_user, 'pg_database_owner', 'MEMBER') THEN
    RETURN NEW;
  END IF;
  IF NEW.created_at IS NULL
    OR NEW.created_at::text IN ('infinity', '-infinity')
    OR NEW.created_at > clock_timestamp() THEN
    RAISE EXCEPTION 'Studio reservation creation time is invalid';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Studio reservation creation time is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger
    WHERE tgname = 'trg_studio_credit_reservation_created_at_immutable'
      AND tgrelid = 'kortix.studio_credit_reservations'::regclass
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_studio_credit_reservation_created_at_immutable
      BEFORE INSERT OR UPDATE OF created_at ON kortix.studio_credit_reservations
      FOR EACH ROW
      EXECUTE FUNCTION kortix.prevent_studio_reservation_created_at_update();
  END IF;
END
$$;

REVOKE ALL ON FUNCTION kortix.prevent_studio_reservation_created_at_update() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION kortix.atomic_settle_studio_job_production(
  p_job_id uuid,
  p_requested_credits numeric,
  p_settlement_key text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reservation record;
  v_debit jsonb := NULL;
  v_settled_credits numeric(12,4);
BEGIN
  IF p_requested_credits IS NULL OR p_requested_credits <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Requested credits must be positive');
  END IF;

  PERFORM 1
  FROM kortix.studio_jobs
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio job not found');
  END IF;

  SELECT reservation_id, account_id, amount_credits, status, settlement_key
  INTO v_reservation
  FROM kortix.studio_credit_reservations
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No reservation found');
  END IF;

  IF v_reservation.status = 'settled' THEN
    IF v_reservation.settlement_key = p_settlement_key THEN
      RETURN jsonb_build_object(
        'success', true,
        'idempotent', true,
        'job_id', p_job_id,
        'settled', LEAST(p_requested_credits, v_reservation.amount_credits)::numeric(12,4)
      );
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reservation already settled with a different key'
    );
  END IF;

  IF v_reservation.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Reservation is not active',
      'status', v_reservation.status
    );
  END IF;

  v_settled_credits := LEAST(
    p_requested_credits,
    v_reservation.amount_credits
  )::numeric(12,4);

  UPDATE kortix.studio_credit_reservations
  SET status = 'settled',
      settlement_key = p_settlement_key,
      settled_at = NOW()
  WHERE reservation_id = v_reservation.reservation_id;

  UPDATE kortix.studio_jobs
  SET actual_credits = v_settled_credits,
      updated_at = NOW()
  WHERE job_id = p_job_id;

  IF v_settled_credits > 0 THEN
    v_debit := public.atomic_use_credits(
      v_reservation.account_id,
      v_settled_credits,
      p_description,
      'studio'
    );

    IF COALESCE((v_debit ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Studio production settlement debit failed: %', v_debit;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'job_id', p_job_id,
    'reserved', v_reservation.amount_credits,
    'requested', p_requested_credits,
    'settled', v_settled_credits,
    'capped', v_settled_credits < p_requested_credits,
    'debit', v_debit
  );
END;
$function$;

REVOKE ALL ON FUNCTION kortix.atomic_settle_studio_job_production(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.atomic_finalize_studio_job_success(
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_owner text,
  p_actual_credits numeric,
  p_assets jsonb,
  p_completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_job kortix.studio_jobs%ROWTYPE;
  v_billing jsonb;
  v_asset jsonb;
  v_asset_id uuid;
  v_linked_asset_id uuid;
  v_cursor bigint;
  v_ledger_id uuid;
  v_verified_upstream_credits numeric(20,4) := 0;
  v_expected_credits numeric(20,4) := 0;
  v_markup_credits numeric(12,4) := 0;
  v_charged_credits numeric(12,4) := 0;
  v_platform_loss_credits numeric(20,4) := 0;
BEGIN
  IF p_actual_credits < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Actual credits must be non-negative');
  END IF;

  IF jsonb_typeof(COALESCE(p_assets, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Assets must be a JSON array');
  END IF;

  IF jsonb_array_length(COALESCE(p_assets, '[]'::jsonb)) > 16 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Too many Studio output assets');
  END IF;

  SELECT job.*
  INTO v_job
  FROM kortix.studio_jobs job
  WHERE job.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio job not found');
  END IF;

  IF v_job.status = 'succeeded' THEN
    RETURN jsonb_build_object('success', true, 'outcome', 'succeeded', 'idempotent', true);
  END IF;

  IF v_job.status = 'cancelled' THEN
    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'idempotent', true);
  END IF;

  IF v_job.status NOT IN ('queued', 'running')
    OR v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio job lease is not owned');
  END IF;

  PERFORM 1
  FROM kortix.studio_job_attempts attempt
  WHERE attempt.attempt_id = p_attempt_id
    AND attempt.job_id = p_job_id
    AND attempt.status IN ('submitted', 'polling', 'reconciling')
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio attempt not found');
  END IF;

  IF v_job.pricing_snapshot IS NOT NULL THEN
    IF jsonb_typeof(v_job.input #> '{image,output_count}') IS DISTINCT FROM 'number'
      OR jsonb_array_length(COALESCE(p_assets, '[]'::jsonb))
        > (v_job.input #>> '{image,output_count}')::integer THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio successful output count exceeds the request'
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(p_assets, '[]'::jsonb)) asset(value)
      GROUP BY asset.value ->> 'bucket', asset.value ->> 'objectKey'
      HAVING COUNT(*) > 1
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Duplicate Studio output asset identity'
      );
    END IF;
  END IF;

  SELECT COALESCE(MAX(event.cursor), 0)
  INTO v_cursor
  FROM kortix.studio_job_events event
  WHERE event.job_id = p_job_id;

  IF v_job.pricing_snapshot IS NULL THEN
    v_verified_upstream_credits := 0;
  ELSE
    SELECT COALESCE(SUM(attempt.upstream_cost_credits), 0)::numeric(20,4)
    INTO v_verified_upstream_credits
    FROM kortix.studio_job_attempts attempt
    WHERE attempt.job_id = p_job_id
      AND attempt.cost_recorded_at IS NOT NULL;
  END IF;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    IF v_job.pricing_snapshot IS NULL THEN
      v_billing := public.atomic_release_studio_job(
        p_job_id,
        'studio:release:' || p_job_id::text || ':user_cancelled',
        'user_cancelled'
      );
    ELSIF v_verified_upstream_credits = 0 THEN
      v_billing := public.atomic_release_studio_job(
        p_job_id,
        'studio:release:' || p_job_id::text || ':user_cancelled',
        'user_cancelled'
      );
    ELSE
      v_billing := kortix.atomic_settle_studio_job_production(
        p_job_id,
        v_verified_upstream_credits,
        'studio:settle:' || p_job_id::text,
        'Studio job verified provider usage'
      );
      v_charged_credits := COALESCE(
        (v_billing ->> 'settled')::numeric,
        (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = p_job_id),
        0
      )::numeric(20,4);
      IF NULLIF(v_billing #>> '{debit,transaction_id}', '') IS NOT NULL THEN
        v_ledger_id := (v_billing #>> '{debit,transaction_id}')::uuid;
      END IF;
    END IF;

    IF COALESCE((v_billing ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Studio cancellation billing failed: %', v_billing;
    END IF;

    IF v_job.pricing_snapshot IS NOT NULL THEN
      v_platform_loss_credits := GREATEST(
        0,
        v_verified_upstream_credits - v_charged_credits
      )::numeric(20,4);

      INSERT INTO kortix.studio_usage_events(
        account_id, project_id, job_id, attempt_id, capability, provider, model,
        upstream_cost_credits, final_cost_credits, platform_loss_credits,
        ledger_id, outcome, metadata, created_at
      )
      SELECT
        v_job.account_id, v_job.project_id, p_job_id, NULL,
        v_job.capability, v_job.provider, v_job.model,
        0, v_charged_credits, v_platform_loss_credits,
        v_ledger_id, 'cancelled',
        jsonb_strip_nulls(jsonb_build_object(
          'kind', 'final',
          'verified_upstream_cost_credits', v_verified_upstream_credits,
          'settlement_key', CASE WHEN v_verified_upstream_credits > 0
            THEN 'studio:settle:' || p_job_id::text ELSE NULL END,
          'release_key', CASE WHEN v_verified_upstream_credits = 0
            THEN 'studio:release:' || p_job_id::text || ':user_cancelled' ELSE NULL END
        )),
        p_completed_at
      WHERE NOT EXISTS (
        SELECT 1
        FROM kortix.studio_usage_events existing
        WHERE existing.job_id = p_job_id
          AND existing.metadata ->> 'kind' = 'final'
      );

      IF NOT EXISTS (
        SELECT 1 FROM kortix.studio_job_events event
        WHERE event.job_id = p_job_id AND event.event_type = 'billing-settled'
      ) THEN
        v_cursor := v_cursor + 1;
        INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
        VALUES (
          p_job_id,
          v_cursor,
          'billing-settled',
          jsonb_build_object(
            'actual_credits', v_charged_credits,
            'verified_upstream_cost_credits', v_verified_upstream_credits,
            'platform_loss_credits', v_platform_loss_credits,
            'capped', v_charged_credits < v_verified_upstream_credits
          ),
          p_completed_at
        );
      END IF;
    END IF;

    UPDATE kortix.studio_job_attempts
    SET status = 'cancelled', ended_at = p_completed_at
    WHERE attempt_id = p_attempt_id
      AND job_id = p_job_id;

    UPDATE kortix.studio_jobs
    SET status = 'cancelled',
        actual_credits = CASE
          WHEN v_job.pricing_snapshot IS NULL THEN actual_credits
          ELSE v_charged_credits
        END,
        error_code = NULL,
        error_message = NULL,
        completed_at = p_completed_at,
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = p_completed_at
    WHERE job_id = p_job_id
      AND lease_owner = p_lease_owner
      AND status IN ('queued', 'running');

    v_cursor := v_cursor + 1;
    INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
    VALUES (p_job_id, v_cursor, 'cancelled', jsonb_build_object('reason', 'user_cancelled'), p_completed_at);

    RETURN jsonb_build_object('success', true, 'outcome', 'cancelled', 'idempotent', false);
  END IF;

  IF v_job.pricing_snapshot IS NULL THEN
    IF p_actual_credits = 0 THEN
      v_billing := public.atomic_release_studio_job(
        p_job_id,
        'studio:release:' || p_job_id::text || ':zero_cost_success',
        'zero_cost_success'
      );
      v_charged_credits := 0;
    ELSE
      v_billing := public.atomic_settle_studio_job(
        p_job_id,
        p_actual_credits,
        'studio:settle:' || p_job_id::text,
        'Studio job usage'
      );
      v_charged_credits := COALESCE((v_billing ->> 'settled')::numeric, p_actual_credits);
    END IF;
  ELSE
    v_markup_credits := (v_job.pricing_snapshot ->> 'markup_credits')::numeric(12,4);
    v_expected_credits := (
      v_verified_upstream_credits
      + v_markup_credits * jsonb_array_length(COALESCE(p_assets, '[]'::jsonb))
    )::numeric(20,4);

    IF p_actual_credits::numeric(20,4) IS DISTINCT FROM v_expected_credits THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio actual credits do not match verified cost',
        'code', 'actual_credits_mismatch',
        'expected', v_expected_credits
      );
    END IF;

    IF v_expected_credits = 0 THEN
      v_billing := public.atomic_release_studio_job(
        p_job_id,
        'studio:release:' || p_job_id::text || ':zero_cost_success',
        'zero_cost_success'
      );
      v_charged_credits := 0;
    ELSE
      v_billing := kortix.atomic_settle_studio_job_production(
        p_job_id,
        v_expected_credits,
        'studio:settle:' || p_job_id::text,
        'Studio job usage'
      );
      v_charged_credits := COALESCE(
        (v_billing ->> 'settled')::numeric,
        (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = p_job_id),
        0
      )::numeric(12,4);
    END IF;
    v_platform_loss_credits := GREATEST(
      0,
      v_verified_upstream_credits - v_charged_credits
    )::numeric(20,4);
  END IF;

  IF COALESCE((v_billing ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio success settlement failed: %', v_billing;
  END IF;

  IF v_charged_credits > 0 AND NULLIF(v_billing #>> '{debit,transaction_id}', '') IS NOT NULL THEN
    v_ledger_id := (v_billing #>> '{debit,transaction_id}')::uuid;
  END IF;

  FOR v_asset IN
    SELECT value FROM jsonb_array_elements(COALESCE(p_assets, '[]'::jsonb))
  LOOP
    v_asset_id := NULL;
    INSERT INTO kortix.studio_assets AS existing_asset(
      account_id, project_id, creator_user_id, source_job_id, kind, mime_type,
      bucket, object_key, checksum_sha256, size_bytes, metadata, created_at, updated_at
    )
    VALUES (
      v_job.account_id,
      v_job.project_id,
      v_job.actor_user_id,
      p_job_id,
      v_asset ->> 'kind',
      v_asset ->> 'mimeType',
      v_asset ->> 'bucket',
      v_asset ->> 'objectKey',
      v_asset ->> 'checksumSha256',
      (v_asset ->> 'sizeBytes')::bigint,
      jsonb_build_object('filename', v_asset ->> 'filename', 'attempt_id', p_attempt_id),
      p_completed_at,
      p_completed_at
    )
    ON CONFLICT (bucket, object_key) DO UPDATE
      SET updated_at = EXCLUDED.updated_at
      WHERE existing_asset.source_job_id = EXCLUDED.source_job_id
    RETURNING asset_id INTO v_asset_id;

    IF v_asset_id IS NULL THEN
      RAISE EXCEPTION 'Studio asset object key belongs to another job';
    END IF;

    v_linked_asset_id := NULL;
    INSERT INTO kortix.studio_job_assets(job_id, asset_id, role, created_at)
    VALUES (p_job_id, v_asset_id, 'output', p_completed_at)
    ON CONFLICT DO NOTHING
    RETURNING asset_id INTO v_linked_asset_id;

    IF v_linked_asset_id IS NOT NULL THEN
      v_cursor := v_cursor + 1;
      INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
      VALUES (
        p_job_id,
        v_cursor,
        'asset-created',
        jsonb_build_object('asset_id', v_asset_id),
        p_completed_at
      );
    END IF;
  END LOOP;

  IF v_job.pricing_snapshot IS NULL THEN
    INSERT INTO kortix.studio_usage_events(
      account_id, project_id, job_id, capability, provider, model,
      upstream_cost_credits, final_cost_credits, ledger_id, metadata, created_at
    )
    SELECT
      v_job.account_id,
      v_job.project_id,
      p_job_id,
      v_job.capability,
      v_job.provider,
      v_job.model,
      0,
      v_charged_credits,
      v_ledger_id,
      CASE
        WHEN p_actual_credits = 0 THEN jsonb_build_object(
          'kind', 'final',
          'release_key', 'studio:release:' || p_job_id::text || ':zero_cost_success'
        )
        ELSE jsonb_build_object('kind', 'final', 'settlement_key', 'studio:settle:' || p_job_id::text)
      END,
      p_completed_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM kortix.studio_usage_events existing
      WHERE existing.job_id = p_job_id
        AND existing.metadata ->> 'kind' = 'final'
    );
  ELSE
    INSERT INTO kortix.studio_usage_events(
      account_id, project_id, job_id, attempt_id, capability, provider, model,
      upstream_cost_credits, final_cost_credits, platform_loss_credits,
      ledger_id, outcome, metadata, created_at
    )
    SELECT
      v_job.account_id, v_job.project_id, p_job_id, NULL,
      v_job.capability, v_job.provider, v_job.model,
      0, v_charged_credits, v_platform_loss_credits,
      v_ledger_id, 'succeeded',
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'final',
        'verified_upstream_cost_credits', v_verified_upstream_credits,
        'settlement_key', CASE WHEN v_expected_credits > 0
          THEN 'studio:settle:' || p_job_id::text ELSE NULL END,
        'release_key', CASE WHEN v_expected_credits = 0
          THEN 'studio:release:' || p_job_id::text || ':zero_cost_success' ELSE NULL END
      )),
      p_completed_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM kortix.studio_usage_events existing
      WHERE existing.job_id = p_job_id
        AND existing.metadata ->> 'kind' = 'final'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM kortix.studio_job_events event
    WHERE event.job_id = p_job_id AND event.event_type = 'billing-settled'
  ) THEN
    v_cursor := v_cursor + 1;
    INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
    VALUES (
      p_job_id,
      v_cursor,
      'billing-settled',
      CASE
        WHEN v_job.pricing_snapshot IS NULL THEN jsonb_build_object(
          'actual_credits', v_charged_credits,
          'requested_actual_credits', p_actual_credits,
          'capped', v_charged_credits < p_actual_credits
        )
        ELSE jsonb_build_object(
          'actual_credits', v_charged_credits,
          'requested_actual_credits', v_expected_credits,
          'verified_upstream_cost_credits', v_verified_upstream_credits,
          'platform_loss_credits', v_platform_loss_credits,
          'capped', v_charged_credits < v_expected_credits
        )
      END,
      p_completed_at
    );
  END IF;

  UPDATE kortix.studio_job_attempts
  SET status = 'succeeded', ended_at = p_completed_at
  WHERE attempt_id = p_attempt_id
    AND job_id = p_job_id;

  UPDATE kortix.studio_jobs
  SET status = 'succeeded',
      actual_credits = v_charged_credits,
      error_code = NULL,
      error_message = NULL,
      completed_at = p_completed_at,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = p_completed_at
  WHERE job_id = p_job_id
    AND lease_owner = p_lease_owner
    AND status IN ('queued', 'running')
    AND cancellation_requested_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Studio success finalization lost its cancellation fence';
  END IF;

  v_cursor := v_cursor + 1;
  INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
  VALUES (p_job_id, v_cursor, 'succeeded', '{}'::jsonb, p_completed_at);

  RETURN jsonb_build_object('success', true, 'outcome', 'succeeded', 'idempotent', false);
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_finalize_studio_job_terminal(
  p_job_id uuid,
  p_attempt_id uuid,
  p_lease_owner text,
  p_terminal_status text,
  p_error_code text,
  p_error_message text,
  p_retry_classification text,
  p_release_reason text,
  p_completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_job kortix.studio_jobs%ROWTYPE;
  v_billing jsonb;
  v_cursor bigint;
  v_ledger_id uuid;
  v_verified_upstream_credits numeric(20,4) := 0;
  v_charged_credits numeric(12,4) := 0;
  v_platform_loss_credits numeric(20,4) := 0;
BEGIN
  IF p_terminal_status NOT IN ('failed', 'cancelled') THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid Studio terminal status');
  END IF;

  SELECT job.*
  INTO v_job
  FROM kortix.studio_jobs job
  WHERE job.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio job not found');
  END IF;

  IF v_job.status::text = p_terminal_status THEN
    RETURN jsonb_build_object(
      'success', true,
      'outcome', p_terminal_status,
      'idempotent', true
    );
  END IF;

  IF v_job.status NOT IN ('queued', 'running')
    OR v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
    RETURN jsonb_build_object('success', false, 'error', 'Studio job lease is not owned');
  END IF;

  IF p_attempt_id IS NOT NULL THEN
    PERFORM 1
    FROM kortix.studio_job_attempts attempt
    WHERE attempt.attempt_id = p_attempt_id
      AND attempt.job_id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'Studio attempt not found');
    END IF;
  END IF;

  SELECT COALESCE(MAX(event.cursor), 0)
  INTO v_cursor
  FROM kortix.studio_job_events event
  WHERE event.job_id = p_job_id;

  IF v_job.pricing_snapshot IS NULL THEN
    v_billing := public.atomic_release_studio_job(
      p_job_id,
      'studio:release:' || p_job_id::text || ':' || p_release_reason,
      p_release_reason
    );
  ELSE
    SELECT COALESCE(SUM(attempt.upstream_cost_credits), 0)::numeric(20,4)
    INTO v_verified_upstream_credits
    FROM kortix.studio_job_attempts attempt
    WHERE attempt.job_id = p_job_id
      AND attempt.cost_recorded_at IS NOT NULL;

    IF v_verified_upstream_credits = 0 THEN
      v_billing := public.atomic_release_studio_job(
        p_job_id,
        'studio:release:' || p_job_id::text || ':' || p_release_reason,
        p_release_reason
      );
    ELSE
      v_billing := kortix.atomic_settle_studio_job_production(
        p_job_id,
        v_verified_upstream_credits,
        'studio:settle:' || p_job_id::text,
        'Studio job verified provider usage'
      );
      v_charged_credits := COALESCE(
        (v_billing ->> 'settled')::numeric,
        (SELECT actual_credits FROM kortix.studio_jobs WHERE job_id = p_job_id),
        0
      )::numeric(12,4);
      IF NULLIF(v_billing #>> '{debit,transaction_id}', '') IS NOT NULL THEN
        v_ledger_id := (v_billing #>> '{debit,transaction_id}')::uuid;
      END IF;
    END IF;

    v_platform_loss_credits := GREATEST(
      0,
      v_verified_upstream_credits - v_charged_credits
    )::numeric(20,4);
  END IF;

  IF COALESCE((v_billing ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio terminal reservation billing failed: %', v_billing;
  END IF;

  IF v_job.pricing_snapshot IS NOT NULL THEN
    INSERT INTO kortix.studio_usage_events(
      account_id, project_id, job_id, attempt_id, capability, provider, model,
      upstream_cost_credits, final_cost_credits, platform_loss_credits,
      ledger_id, outcome, metadata, created_at
    )
    SELECT
      v_job.account_id, v_job.project_id, p_job_id, NULL,
      v_job.capability, v_job.provider, v_job.model,
      0, v_charged_credits, v_platform_loss_credits,
      v_ledger_id, p_terminal_status,
      jsonb_strip_nulls(jsonb_build_object(
        'kind', 'final',
        'verified_upstream_cost_credits', v_verified_upstream_credits,
        'settlement_key', CASE WHEN v_verified_upstream_credits > 0
          THEN 'studio:settle:' || p_job_id::text ELSE NULL END,
        'release_key', CASE WHEN v_verified_upstream_credits = 0
          THEN 'studio:release:' || p_job_id::text || ':' || p_release_reason ELSE NULL END
      )),
      p_completed_at
    WHERE NOT EXISTS (
      SELECT 1
      FROM kortix.studio_usage_events existing
      WHERE existing.job_id = p_job_id
        AND existing.metadata ->> 'kind' = 'final'
    );

    IF NOT EXISTS (
      SELECT 1 FROM kortix.studio_job_events event
      WHERE event.job_id = p_job_id AND event.event_type = 'billing-settled'
    ) THEN
      v_cursor := v_cursor + 1;
      INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
      VALUES (
        p_job_id,
        v_cursor,
        'billing-settled',
        jsonb_build_object(
          'actual_credits', v_charged_credits,
          'verified_upstream_cost_credits', v_verified_upstream_credits,
          'platform_loss_credits', v_platform_loss_credits,
          'capped', v_charged_credits < v_verified_upstream_credits
        ),
        p_completed_at
      );
    END IF;
  END IF;

  IF p_attempt_id IS NOT NULL THEN
    UPDATE kortix.studio_job_attempts
    SET status = p_terminal_status::kortix.studio_attempt_status,
        retry_classification = COALESCE(p_retry_classification, retry_classification),
        ended_at = p_completed_at
    WHERE attempt_id = p_attempt_id
      AND job_id = p_job_id;
  END IF;

  UPDATE kortix.studio_jobs
  SET status = p_terminal_status::kortix.studio_job_status,
      actual_credits = CASE
        WHEN v_job.pricing_snapshot IS NULL THEN actual_credits
        ELSE v_charged_credits
      END,
      error_code = p_error_code,
      error_message = p_error_message,
      completed_at = p_completed_at,
      lease_owner = NULL,
      lease_expires_at = NULL,
      updated_at = p_completed_at
  WHERE job_id = p_job_id
    AND lease_owner = p_lease_owner
    AND status IN ('queued', 'running');

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Studio terminal finalization lost its lease fence';
  END IF;

  v_cursor := v_cursor + 1;
  INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
  VALUES (
    p_job_id,
    v_cursor,
    p_terminal_status,
    jsonb_strip_nulls(jsonb_build_object('code', p_error_code, 'reason', p_release_reason)),
    p_completed_at
  );

  RETURN jsonb_build_object(
    'success', true,
    'outcome', p_terminal_status,
    'idempotent', false
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atomic_finalize_studio_job_terminal(uuid, uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_studio_job_terminal(uuid, uuid, text, text, text, text, text, text, timestamptz) TO service_role;


CREATE OR REPLACE FUNCTION public.atomic_recover_studio_job(
  p_project_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_actor_user_id uuid,
  p_actor_type text,
  p_acting_token_id uuid,
  p_decision text,
  p_idempotency_key text,
  p_request_hash text,
  p_reason text,
  p_evidence jsonb,
  p_result_assets jsonb,
  p_actual_credits numeric,
  p_keep_unknown_until timestamptz,
  p_recovered_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_job kortix.studio_jobs%ROWTYPE;
  v_attempt kortix.studio_job_attempts%ROWTYPE;
  v_reservation kortix.studio_credit_reservations%ROWTYPE;
  v_existing_recovery kortix.studio_job_recoveries%ROWTYPE;
  v_recovery_id uuid := gen_random_uuid();
  v_recovery_lease_owner text;
  v_recovery_lease_expires_at timestamptz;
  v_prior_job_status text;
  v_prior_attempt_status text;
  v_resulting_job_status text;
  v_resulting_attempt_status text;
  v_resulting_reservation_status text;
  v_resulting_hold_expires_at timestamptz := NULL;
  v_upstream_usage jsonb;
  v_upstream_cost_input numeric;
  v_upstream_cost_credits numeric(12,4);
  v_cost_result jsonb;
  v_finalize_result jsonb;
  v_result jsonb;
  v_cursor bigint;
  v_hold_cap timestamptz;
  v_current_hold timestamptz;
BEGIN
  IF p_job_id IS NULL OR p_attempt_id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery job and attempt are required',
      'code', 'recovery_arguments_invalid'
    );
  END IF;
  IF NULLIF(pg_catalog.btrim(p_idempotency_key), '') IS NULL
    OR NULLIF(pg_catalog.btrim(p_request_hash), '') IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery idempotency key and request hash are required',
      'code', 'recovery_arguments_invalid'
    );
  END IF;

  SELECT job.*
  INTO v_job
  FROM kortix.studio_jobs job
  WHERE job.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio job not found',
      'code', 'recovery_job_not_found'
    );
  END IF;

  IF v_job.project_id IS DISTINCT FROM p_project_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio job not found',
      'code', 'recovery_job_not_found'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      p_job_id::text || pg_catalog.chr(31) || p_idempotency_key,
      0
    )
  );

  SELECT recovery.*
  INTO v_existing_recovery
  FROM kortix.studio_job_recoveries recovery
  WHERE recovery.job_id = p_job_id
    AND recovery.idempotency_key = p_idempotency_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing_recovery.request_hash = p_request_hash THEN
      RETURN v_existing_recovery.result;
    END IF;

    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery idempotency key was already used',
      'code', 'recovery_conflict'
    );
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM kortix.studio_job_attempts attempt
  WHERE attempt.attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND OR v_attempt.job_id IS DISTINCT FROM p_job_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery attempt not found',
      'code', 'recovery_attempt_not_found'
    );
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM kortix.studio_credit_reservations reservation
  WHERE reservation.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery reservation not found',
      'code', 'recovery_reservation_not_found'
    );
  END IF;

  IF v_reservation.created_at IS NULL
    OR v_reservation.created_at::text IN ('infinity', '-infinity')
    OR v_reservation.created_at > clock_timestamp() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery reservation time is invalid',
      'code', 'recovery_reservation_time_invalid'
    );
  END IF;

  IF v_job.pricing_snapshot IS NULL
    OR v_job.status <> 'running'
    OR v_attempt.status <> 'reconciling'
    OR v_reservation.account_id IS DISTINCT FROM v_job.account_id
    OR v_reservation.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery state is not eligible',
      'code', 'recovery_state_invalid'
    );
  END IF;

  IF (v_job.lease_owner IS NULL) IS DISTINCT FROM (v_job.lease_expires_at IS NULL)
    OR (
      v_job.lease_owner IS NOT NULL
      AND v_job.lease_expires_at > clock_timestamp()
    ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio job still has a worker lease',
      'code', 'recovery_lease_live'
    );
  END IF;

  IF p_recovered_at IS NULL
    OR p_recovered_at::text IN ('infinity', '-infinity')
    OR p_recovered_at < clock_timestamp() - interval '5 minutes'
    OR p_recovered_at > clock_timestamp() + interval '5 minutes' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery time is invalid',
      'code', 'recovery_time_invalid'
    );
  END IF;

  IF p_actor_user_id IS NULL
    OR NULLIF(pg_catalog.btrim(p_actor_type), '') IS NULL
    OR NULLIF(pg_catalog.btrim(p_reason), '') IS NULL
    OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR p_decision IS NULL
    OR p_decision NOT IN ('confirm_succeeded', 'confirm_not_created', 'keep_unknown') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio recovery decision arguments are invalid',
      'code', 'recovery_arguments_invalid'
    );
  END IF;

  v_prior_job_status := v_job.status::text;
  v_prior_attempt_status := v_attempt.status::text;
  v_recovery_lease_owner := 'studio-recovery:' || v_recovery_id::text;
  v_recovery_lease_expires_at :=
    GREATEST(clock_timestamp(), p_recovered_at) + interval '5 minutes';

  IF p_decision = 'confirm_succeeded' THEN
    IF v_attempt.staging_manifest_key IS NULL
      OR v_attempt.staging_manifest_checksum IS NULL
      OR p_evidence ->> 'staging_manifest_key'
        IS DISTINCT FROM v_attempt.staging_manifest_key
      OR p_evidence ->> 'staging_manifest_checksum'
        IS DISTINCT FROM v_attempt.staging_manifest_checksum THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio recovery manifest identity does not match the attempt',
        'code', 'recovery_manifest_mismatch'
      );
    END IF;
    IF jsonb_typeof(p_result_assets) IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed Studio success requires result assets',
        'code', 'recovery_assets_required'
      );
    END IF;
    IF jsonb_array_length(p_result_assets) = 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed Studio success requires result assets',
        'code', 'recovery_assets_required'
      );
    END IF;
    IF p_keep_unknown_until IS NOT NULL OR v_job.cancellation_requested_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed Studio success cannot extend or cancel the hold',
        'code', 'recovery_success_invalid'
      );
    END IF;
    IF jsonb_typeof(p_evidence -> 'upstream_usage') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_evidence -> 'upstream_cost_credits') IS DISTINCT FROM 'number'
      OR p_actual_credits IS NULL
      OR p_actual_credits::text IN ('NaN', 'Infinity', '-Infinity')
      OR p_actual_credits < 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed Studio success cost evidence is invalid',
        'code', 'recovery_cost_invalid'
      );
    END IF;

    v_upstream_usage := p_evidence -> 'upstream_usage';
    v_upstream_cost_input := (p_evidence ->> 'upstream_cost_credits')::numeric;
    IF v_upstream_cost_input < 0
      OR v_upstream_cost_input > 99999999.9999
      OR jsonb_path_exists(
        v_upstream_usage,
        '$.** ? (@.type() == "number" && @ < 0)'
      ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed Studio success cost evidence is invalid',
        'code', 'recovery_cost_invalid'
      );
    END IF;
    v_upstream_cost_credits := v_upstream_cost_input::numeric(12,4);

    IF v_attempt.cost_recorded_at IS NOT NULL
      AND (
        v_attempt.upstream_usage IS DISTINCT FROM v_upstream_usage
        OR v_attempt.upstream_cost_credits IS DISTINCT FROM v_upstream_cost_credits
      ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio attempt cost was already recorded differently',
        'code', 'attempt_cost_conflict'
      );
    END IF;

    UPDATE kortix.studio_jobs
    SET lease_owner = v_recovery_lease_owner,
        lease_expires_at = v_recovery_lease_expires_at,
        updated_at = clock_timestamp()
    WHERE job_id = p_job_id;

    IF v_attempt.cost_recorded_at IS NULL THEN
      v_cost_result := public.atomic_record_studio_attempt_cost(
        p_job_id,
        p_attempt_id,
        v_recovery_lease_owner,
        v_upstream_usage,
        v_upstream_cost_credits,
        'succeeded',
        p_recovered_at
      );
      IF COALESCE((v_cost_result ->> 'success')::boolean, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Studio recovery cost recording failed (%): %',
          COALESCE(v_cost_result ->> 'code', 'unknown'),
          COALESCE(v_cost_result ->> 'error', 'unknown');
      END IF;
    END IF;

    v_finalize_result := public.atomic_finalize_studio_job_success(
      p_job_id,
      p_attempt_id,
      v_recovery_lease_owner,
      p_actual_credits,
      p_result_assets,
      p_recovered_at
    );
    IF COALESCE((v_finalize_result ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Studio recovery success finalization failed (%): %',
        COALESCE(v_finalize_result ->> 'code', 'unknown'),
        COALESCE(v_finalize_result ->> 'error', 'unknown');
    END IF;
  ELSIF p_decision = 'confirm_not_created' THEN
    IF p_result_assets IS NOT NULL AND p_result_assets <> 'null'::jsonb THEN
      IF jsonb_typeof(p_result_assets) IS DISTINCT FROM 'array' THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Confirmed not-created arguments are invalid',
          'code', 'recovery_not_created_invalid'
        );
      END IF;
      IF jsonb_array_length(p_result_assets) <> 0 THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Confirmed not-created arguments are invalid',
          'code', 'recovery_not_created_invalid'
        );
      END IF;
    END IF;
    IF p_actual_credits IS NOT NULL
      OR p_keep_unknown_until IS NOT NULL
      OR (
        p_evidence ? 'upstream_usage'
        AND p_evidence -> 'upstream_usage' <> 'null'::jsonb
      )
      OR (
        p_evidence ? 'upstream_cost_credits'
        AND p_evidence -> 'upstream_cost_credits' <> 'null'::jsonb
      ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Confirmed not-created arguments are invalid',
        'code', 'recovery_not_created_invalid'
      );
    END IF;
    IF v_attempt.cost_recorded_at IS NOT NULL
      AND COALESCE(v_attempt.upstream_cost_credits, 0) > 0 THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Current Studio attempt has verified provider cost',
        'code', 'current_attempt_cost_positive'
      );
    END IF;

    UPDATE kortix.studio_jobs
    SET lease_owner = v_recovery_lease_owner,
        lease_expires_at = v_recovery_lease_expires_at,
        updated_at = clock_timestamp()
    WHERE job_id = p_job_id;

    v_finalize_result := public.atomic_finalize_studio_job_terminal(
      p_job_id,
      p_attempt_id,
      v_recovery_lease_owner,
      'failed',
      'STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED',
      'Provider evidence confirms that the submission was not created',
      'unknown_outcome',
      'submission_confirmed_not_created',
      p_recovered_at
    );
    IF COALESCE((v_finalize_result ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Studio not-created finalization failed (%): %',
        COALESCE(v_finalize_result ->> 'code', 'unknown'),
        COALESCE(v_finalize_result ->> 'error', 'unknown');
    END IF;
  ELSIF p_decision = 'keep_unknown' THEN
    IF p_result_assets IS NOT NULL AND p_result_assets <> 'null'::jsonb THEN
      IF jsonb_typeof(p_result_assets) IS DISTINCT FROM 'array' THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Keep-unknown arguments are invalid',
          'code', 'keep_unknown_invalid'
        );
      END IF;
      IF jsonb_array_length(p_result_assets) <> 0 THEN
        RETURN jsonb_build_object(
          'success', false,
          'error', 'Keep-unknown arguments are invalid',
          'code', 'keep_unknown_invalid'
        );
      END IF;
    END IF;
    IF p_actual_credits IS NOT NULL
      OR p_keep_unknown_until IS NULL
      OR (
        p_evidence ? 'upstream_usage'
        AND p_evidence -> 'upstream_usage' <> 'null'::jsonb
      )
      OR (
        p_evidence ? 'upstream_cost_credits'
        AND p_evidence -> 'upstream_cost_credits' <> 'null'::jsonb
      ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Keep-unknown arguments are invalid',
        'code', 'keep_unknown_invalid'
      );
    END IF;

    v_hold_cap := v_reservation.created_at + interval '30 days';
    v_current_hold := GREATEST(
      v_reservation.expires_at,
      COALESCE(v_job.available_at, v_reservation.expires_at)
    );
    IF v_current_hold >= v_hold_cap THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio unknown-outcome hold reached its cumulative cap',
        'code', 'hold_cap_reached'
      );
    END IF;
    IF p_keep_unknown_until <= clock_timestamp()
      OR p_keep_unknown_until <= p_recovered_at THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio unknown-outcome hold must remain in the future',
        'code', 'hold_not_future'
      );
    END IF;
    IF p_keep_unknown_until <= v_current_hold THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio unknown-outcome hold was not extended',
        'code', 'hold_not_extended'
      );
    END IF;
    IF p_keep_unknown_until > p_recovered_at + interval '7 days' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio unknown-outcome hold extension exceeds seven days',
        'code', 'hold_extension_too_long'
      );
    END IF;
    IF p_keep_unknown_until > v_reservation.created_at + interval '30 days' THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Studio unknown-outcome hold exceeds its cumulative cap',
        'code', 'hold_cumulative_cap_exceeded'
      );
    END IF;

    UPDATE kortix.studio_credit_reservations
    SET expires_at = GREATEST(v_reservation.expires_at, p_keep_unknown_until)
    WHERE reservation_id = v_reservation.reservation_id;

    UPDATE kortix.studio_jobs
    SET available_at = GREATEST(
          COALESCE(v_job.available_at, p_keep_unknown_until),
          p_keep_unknown_until
        ),
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = p_recovered_at
    WHERE job_id = p_job_id
      AND status = 'running';

    SELECT COALESCE(MAX(event.cursor), 0) + 1
    INTO v_cursor
    FROM kortix.studio_job_events event
    WHERE event.job_id = p_job_id;

    INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
    VALUES (
      p_job_id,
      v_cursor,
      'progress',
      jsonb_build_object(
        'phase', 'operator-review',
        'recovery_id', v_recovery_id,
        'decision', 'keep_unknown'
      ),
      p_recovered_at
    );
  END IF;

  SELECT job.status::text
  INTO v_resulting_job_status
  FROM kortix.studio_jobs job
  WHERE job.job_id = p_job_id;

  SELECT attempt.status::text
  INTO v_resulting_attempt_status
  FROM kortix.studio_job_attempts attempt
  WHERE attempt.attempt_id = p_attempt_id;

  SELECT reservation.status, reservation.expires_at
  INTO v_resulting_reservation_status, v_resulting_hold_expires_at
  FROM kortix.studio_credit_reservations reservation
  WHERE reservation.job_id = p_job_id;

  IF p_decision <> 'keep_unknown' THEN
    v_resulting_hold_expires_at := NULL;
  END IF;

  v_result := jsonb_build_object(
    'recovery_id', v_recovery_id,
    'job_id', p_job_id,
    'attempt_id', p_attempt_id,
    'decision', p_decision,
    'job_status', v_resulting_job_status,
    'attempt_status', v_resulting_attempt_status,
    'reservation_status', v_resulting_reservation_status,
    'hold_expires_at', v_resulting_hold_expires_at
  );

  INSERT INTO kortix.studio_job_recoveries(
    recovery_id, account_id, project_id, job_id, attempt_id,
    idempotency_key, request_hash, decision, reason,
    actor_user_id, actor_type, acting_token_id, evidence,
    prior_job_status, prior_attempt_status,
    resulting_job_status, resulting_attempt_status,
    result, created_at
  )
  VALUES (
    v_recovery_id, v_job.account_id, v_job.project_id, p_job_id, p_attempt_id,
    p_idempotency_key, p_request_hash, p_decision, p_reason,
    p_actor_user_id, p_actor_type, p_acting_token_id, p_evidence,
    v_prior_job_status, v_prior_attempt_status,
    v_resulting_job_status, v_resulting_attempt_status,
    v_result, p_recovered_at
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_recover_studio_job(uuid, uuid, uuid, uuid, text, uuid, text, text, text, text, jsonb, jsonb, numeric, timestamptz, timestamptz) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_recover_studio_job(uuid, uuid, uuid, uuid, text, uuid, text, text, text, text, jsonb, jsonb, numeric, timestamptz, timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION public.atomic_expire_studio_unknown_hold(
  p_job_id uuid,
  p_attempt_id uuid,
  p_expired_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_job kortix.studio_jobs%ROWTYPE;
  v_attempt kortix.studio_job_attempts%ROWTYPE;
  v_reservation kortix.studio_credit_reservations%ROWTYPE;
  v_existing_incident kortix.studio_billing_incidents%ROWTYPE;
  v_inserted_incident kortix.studio_billing_incidents%ROWTYPE;
  v_recovery_lease_owner text;
  v_recovery_lease_expires_at timestamptz;
  v_verified_cost_credits numeric(20,4) := 0;
  v_max_provider_credits_input numeric;
  v_max_provider_credits numeric(12,4);
  v_potential_liability_credits numeric(20,4);
  v_finalize_result jsonb;
BEGIN
  SELECT job.*
  INTO v_job
  FROM kortix.studio_jobs job
  WHERE job.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio job not found',
      'code', 'expiry_job_not_found'
    );
  END IF;

  SELECT incident.*
  INTO v_existing_incident
  FROM kortix.studio_billing_incidents incident
  WHERE incident.job_id = p_job_id
    AND incident.attempt_id = p_attempt_id
    AND incident.kind = 'unknown_outcome_hold_expired'
  FOR UPDATE;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'incident_id', v_existing_incident.incident_id,
      'job_id', v_existing_incident.job_id,
      'attempt_id', v_existing_incident.attempt_id,
      'kind', v_existing_incident.kind,
      'status', v_existing_incident.status,
      'verified_cost_credits', v_existing_incident.verified_cost_credits,
      'potential_liability_credits', v_existing_incident.potential_liability_credits
    );
  END IF;

  IF p_expired_at IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio hold expiry time is required',
      'code', 'expiry_time_required'
    );
  END IF;
  IF p_expired_at::text IN ('infinity', '-infinity') THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio hold expiry time is invalid',
      'code', 'expiry_time_invalid'
    );
  END IF;
  IF p_expired_at > clock_timestamp() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio hold expiry cannot be in the future',
      'code', 'expiry_in_future'
    );
  END IF;

  SELECT attempt.*
  INTO v_attempt
  FROM kortix.studio_job_attempts attempt
  WHERE attempt.attempt_id = p_attempt_id
  FOR UPDATE;

  IF NOT FOUND OR v_attempt.job_id IS DISTINCT FROM p_job_id THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio expiry attempt not found',
      'code', 'expiry_attempt_not_found'
    );
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM kortix.studio_credit_reservations reservation
  WHERE reservation.job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio expiry reservation not found',
      'code', 'expiry_reservation_not_found'
    );
  END IF;

  IF v_reservation.created_at IS NULL
    OR v_reservation.created_at::text IN ('infinity', '-infinity')
    OR v_reservation.created_at > clock_timestamp() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio expiry reservation time is invalid',
      'code', 'expiry_reservation_time_invalid'
    );
  END IF;

  IF v_job.pricing_snapshot IS NULL
    OR v_job.status <> 'running'
    OR v_attempt.status <> 'reconciling'
    OR v_reservation.account_id IS DISTINCT FROM v_job.account_id
    OR v_reservation.status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio hold is not eligible for expiry',
      'code', 'expiry_state_invalid'
    );
  END IF;
  IF (v_job.lease_owner IS NULL) IS DISTINCT FROM (v_job.lease_expires_at IS NULL)
    OR (
      v_job.lease_owner IS NOT NULL
      AND v_job.lease_expires_at > clock_timestamp()
    ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio job still has a worker lease',
      'code', 'expiry_lease_live'
    );
  END IF;
  IF v_reservation.created_at + interval '30 days' > p_expired_at THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio unknown-outcome hold has not reached thirty days',
      'code', 'hold_not_expired'
    );
  END IF;
  IF jsonb_typeof(v_job.pricing_snapshot -> 'max_provider_credits')
      IS DISTINCT FROM 'number' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio pricing snapshot is invalid',
      'code', 'expiry_pricing_invalid'
    );
  END IF;

  v_max_provider_credits_input :=
    (v_job.pricing_snapshot ->> 'max_provider_credits')::numeric;
  IF v_max_provider_credits_input < 0
    OR v_max_provider_credits_input > 99999999.9999 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Studio pricing snapshot is invalid',
      'code', 'expiry_pricing_invalid'
    );
  END IF;
  v_max_provider_credits := v_max_provider_credits_input::numeric(12,4);

  SELECT COALESCE(SUM(attempt.upstream_cost_credits), 0)::numeric(20,4)
  INTO v_verified_cost_credits
  FROM kortix.studio_job_attempts attempt
  WHERE attempt.job_id = p_job_id
    AND attempt.cost_recorded_at IS NOT NULL;

  v_potential_liability_credits := GREATEST(
    0,
    v_max_provider_credits - v_verified_cost_credits
  )::numeric(20,4);
  v_recovery_lease_owner := 'studio-expiry:' || gen_random_uuid()::text;
  v_recovery_lease_expires_at :=
    GREATEST(clock_timestamp(), p_expired_at) + interval '5 minutes';

  UPDATE kortix.studio_jobs
  SET lease_owner = v_recovery_lease_owner,
      lease_expires_at = v_recovery_lease_expires_at,
      updated_at = clock_timestamp()
  WHERE job_id = p_job_id;

  v_finalize_result := public.atomic_finalize_studio_job_terminal(
    p_job_id,
    p_attempt_id,
    v_recovery_lease_owner,
    'failed',
    'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED',
    'Provider submission outcome remained unresolved after the maximum hold',
    'unknown_outcome',
    'submission_outcome_unresolved_expired',
    p_expired_at
  );
  IF COALESCE((v_finalize_result ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio unknown-hold expiry finalization failed (%): %',
      COALESCE(v_finalize_result ->> 'code', 'unknown'),
      COALESCE(v_finalize_result ->> 'error', 'unknown');
  END IF;

  INSERT INTO kortix.studio_billing_incidents(
    account_id, project_id, job_id, attempt_id, kind, status,
    verified_cost_credits, potential_liability_credits,
    metadata, opened_at
  )
  VALUES (
    v_job.account_id,
    v_job.project_id,
    p_job_id,
    p_attempt_id,
    'unknown_outcome_hold_expired',
    'open',
    v_verified_cost_credits,
    v_potential_liability_credits,
    jsonb_build_object(
      'expired_at', p_expired_at,
      'error_code', 'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED'
    ),
    clock_timestamp()
  )
  RETURNING * INTO v_inserted_incident;

  RETURN jsonb_build_object(
    'incident_id', v_inserted_incident.incident_id,
    'job_id', v_inserted_incident.job_id,
    'attempt_id', v_inserted_incident.attempt_id,
    'kind', v_inserted_incident.kind,
    'status', v_inserted_incident.status,
    'verified_cost_credits', v_inserted_incident.verified_cost_credits,
    'potential_liability_credits', v_inserted_incident.potential_liability_credits
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.atomic_expire_studio_unknown_hold(uuid, uuid, timestamptz) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_expire_studio_unknown_hold(uuid, uuid, timestamptz) TO service_role;
