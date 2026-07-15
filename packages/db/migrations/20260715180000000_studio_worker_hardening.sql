-- Forward-only Task 8 hardening for installations that already applied the
-- Studio Phase 1 schema and reservation migrations.

ALTER TABLE kortix.credit_accounts
  ALTER COLUMN daily_credits_balance TYPE numeric(12,4)
  USING daily_credits_balance::numeric(12,4);

CREATE INDEX IF NOT EXISTS idx_studio_credit_reservations_expiry
  ON kortix.studio_credit_reservations(expires_at)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.atomic_use_credits(
  p_account_id uuid,
  p_amount numeric,
  p_description text,
  p_ledger_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_daily NUMERIC(12,4);
  v_exp NUMERIC(12,4);
  v_nonexp NUMERIC(12,4);
  v_total NUMERIC(12,4);
  v_reserved NUMERIC(12,4) := 0;
  v_available NUMERIC(12,4) := 0;
  v_fd NUMERIC(12,4) := 0;
  v_fe NUMERIC(12,4) := 0;
  v_fn NUMERIC(12,4) := 0;
  v_rem NUMERIC(12,4);
  v_nd NUMERIC(12,4);
  v_ne NUMERIC(12,4);
  v_nn NUMERIC(12,4);
  v_nt NUMERIC(12,4);
  v_tid UUID;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Amount must be positive', 'required', p_amount, 'available', 0);
  END IF;

  SELECT
    COALESCE(daily_credits_balance, 0),
    COALESCE(expiring_credits, 0),
    COALESCE(non_expiring_credits, 0),
    COALESCE(balance, 0)
  INTO v_daily, v_exp, v_nonexp, v_total
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No credit account found', 'required', p_amount, 'available', 0);
  END IF;

  SELECT COALESCE(SUM(amount_credits), 0)
  INTO v_reserved
  FROM kortix.studio_credit_reservations
  WHERE account_id = p_account_id
    AND status = 'active';

  v_available := GREATEST(0, v_total - v_reserved);

  IF v_available < p_amount THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits', 'required', p_amount, 'available', v_available, 'reserved', v_reserved);
  END IF;

  v_rem := p_amount;
  IF v_rem > 0 AND v_daily > 0 THEN
    IF v_daily >= v_rem THEN v_fd := v_rem; v_rem := 0;
    ELSE v_fd := v_daily; v_rem := v_rem - v_daily;
    END IF;
  END IF;
  IF v_rem > 0 AND v_exp > 0 THEN
    IF v_exp >= v_rem THEN v_fe := v_rem; v_rem := 0;
    ELSE v_fe := v_exp; v_rem := v_rem - v_exp;
    END IF;
  END IF;
  IF v_rem > 0 THEN v_fn := v_rem; v_rem := 0; END IF;

  v_nd := v_daily - v_fd;
  v_ne := v_exp - v_fe;
  v_nn := v_nonexp - v_fn;
  v_nt := v_nd + v_ne + v_nn;

  UPDATE kortix.credit_accounts
  SET daily_credits_balance = v_nd,
      expiring_credits = v_ne,
      non_expiring_credits = v_nn,
      balance = v_nt,
      updated_at = NOW()
  WHERE account_id = p_account_id;

  INSERT INTO kortix.credit_ledger(account_id, amount, balance_after, type, description, metadata)
  VALUES (
    p_account_id,
    -p_amount,
    v_nt,
    'usage',
    p_description,
    jsonb_build_object(
      'from_daily', v_fd,
      'from_monthly', v_fe,
      'from_extra', v_fn,
      'ledger_type', p_ledger_type,
      'reserved_at_debit', v_reserved
    )
  )
  RETURNING id INTO v_tid;

  RETURN jsonb_build_object(
    'success', true,
    'amount_deducted', p_amount,
    'new_total', v_nt,
    'new_daily', v_nd,
    'new_expiring', v_ne,
    'new_non_expiring', v_nn,
    'from_daily', v_fd,
    'from_monthly', v_fe,
    'from_extra', v_fn,
    'from_expiring', v_fe,
    'from_non_expiring', v_fn,
    'reserved', v_reserved,
    'available_before_debit', v_available,
    'transaction_id', v_tid
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_create_studio_job(
  p_account_id uuid,
  p_project_id uuid,
  p_actor_user_id uuid,
  p_actor_type text,
  p_acting_token_id uuid,
  p_agent_name text,
  p_session_id text,
  p_parent_job_id uuid,
  p_capability text,
  p_provider_config_id uuid,
  p_provider text,
  p_model text,
  p_input jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_reserved_credits numeric,
  p_reservation_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_total NUMERIC(12,4);
  v_reserved NUMERIC(12,4) := 0;
  v_available NUMERIC(12,4);
  v_existing RECORD;
  v_job_id UUID;
  v_reservation_id UUID;
BEGIN
  IF p_reserved_credits < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reserved credits must be non-negative');
  END IF;

  SELECT COALESCE(balance, 0)
  INTO v_total
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No credit account found', 'required', p_reserved_credits, 'available', 0);
  END IF;

  -- Serializing by wallet row makes the idempotency check and reservation
  -- creation deterministic even when identical requests arrive concurrently.
  SELECT job_id, project_id, request_hash, status
  INTO v_existing
  FROM kortix.studio_jobs
  WHERE account_id = p_account_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.project_id <> p_project_id OR v_existing.request_hash <> p_request_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Idempotency key reused with different request', 'code', 'idempotency_mismatch');
    END IF;

    RETURN jsonb_build_object('success', true, 'idempotent', true, 'job_id', v_existing.job_id, 'status', v_existing.status);
  END IF;

  SELECT COALESCE(SUM(amount_credits), 0)
  INTO v_reserved
  FROM kortix.studio_credit_reservations
  WHERE account_id = p_account_id
    AND status = 'active';

  v_available := GREATEST(0, v_total - v_reserved);

  IF v_available < p_reserved_credits THEN
    RETURN jsonb_build_object('success', false, 'code', 'insufficient_credits', 'error', 'Insufficient credits', 'required', p_reserved_credits, 'available', v_available, 'reserved', v_reserved);
  END IF;

  INSERT INTO kortix.studio_jobs(
    account_id,
    project_id,
    actor_user_id,
    actor_type,
    acting_token_id,
    agent_name,
    session_id,
    parent_job_id,
    capability,
    provider_config_id,
    provider,
    model,
    input,
    idempotency_key,
    request_hash,
    reserved_credits
  )
  VALUES (
    p_account_id,
    p_project_id,
    p_actor_user_id,
    COALESCE(NULLIF(p_actor_type, ''), 'user'),
    p_acting_token_id,
    p_agent_name,
    p_session_id,
    p_parent_job_id,
    p_capability,
    p_provider_config_id,
    p_provider,
    p_model,
    COALESCE(p_input, '{}'::jsonb),
    p_idempotency_key,
    p_request_hash,
    p_reserved_credits
  )
  RETURNING job_id INTO v_job_id;

  INSERT INTO kortix.studio_credit_reservations(account_id, job_id, amount_credits, expires_at)
  VALUES (p_account_id, v_job_id, p_reserved_credits, p_reservation_expires_at)
  RETURNING reservation_id INTO v_reservation_id;

  INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload)
  VALUES (
    v_job_id,
    1,
    'queued',
    jsonb_build_object(
      'capability', p_capability,
      'provider_config_id', p_provider_config_id,
      'model', p_model
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'job_id', v_job_id,
    'reservation_id', v_reservation_id,
    'reserved', p_reserved_credits,
    'available_after_reservation', v_available - p_reserved_credits
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_settle_studio_job(
  p_job_id uuid,
  p_actual_credits numeric,
  p_settlement_key text,
  p_description text DEFAULT 'Studio job usage'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reservation RECORD;
  v_debit jsonb;
  v_settled_credits NUMERIC(12,4);
BEGIN
  IF p_actual_credits < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Actual credits must be non-negative');
  END IF;

  -- Keep the same job -> reservation lock order as atomic finalization so a
  -- direct service-role settlement cannot deadlock the worker finalizer.
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
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'job_id', p_job_id);
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'Reservation already settled with a different key');
  END IF;

  IF v_reservation.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reservation is not active', 'status', v_reservation.status);
  END IF;

  v_settled_credits := LEAST(p_actual_credits, v_reservation.amount_credits);

  UPDATE kortix.studio_credit_reservations
  SET status = 'settled',
      settlement_key = p_settlement_key,
      settled_at = NOW()
  WHERE reservation_id = v_reservation.reservation_id;

  UPDATE kortix.studio_jobs
  SET actual_credits = v_settled_credits,
      updated_at = NOW()
  WHERE job_id = p_job_id;

  v_debit := public.atomic_use_credits(
    v_reservation.account_id,
    v_settled_credits,
    p_description,
    'studio'
  );

  IF COALESCE((v_debit ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio settlement debit failed: %', v_debit;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'job_id', p_job_id,
    'reserved', v_reservation.amount_credits,
    'requested', p_actual_credits,
    'settled', v_settled_credits,
    'capped', v_settled_credits < p_actual_credits,
    'debit', v_debit
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.atomic_release_studio_job(
  p_job_id uuid,
  p_release_key text,
  p_reason text DEFAULT 'Studio job reservation released'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_reservation RECORD;
BEGIN
  SELECT reservation_id, amount_credits, status, release_key
  INTO v_reservation
  FROM kortix.studio_credit_reservations
  WHERE job_id = p_job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No reservation found');
  END IF;

  IF v_reservation.status = 'released' THEN
    IF v_reservation.release_key = p_release_key THEN
      RETURN jsonb_build_object('success', true, 'idempotent', true, 'job_id', p_job_id);
    END IF;

    RETURN jsonb_build_object('success', false, 'error', 'Reservation already released with a different key');
  END IF;

  IF v_reservation.status <> 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'Reservation is not active', 'status', v_reservation.status);
  END IF;

  UPDATE kortix.studio_credit_reservations
  SET status = 'released',
      release_key = p_release_key,
      released_at = NOW()
  WHERE reservation_id = v_reservation.reservation_id;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'job_id', p_job_id,
    'released', v_reservation.amount_credits
  );
END;
$function$;

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
  v_charged_credits NUMERIC(12,4) := 0;
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

  IF v_job.status NOT IN ('queued', 'running') OR v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
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

  SELECT COALESCE(MAX(event.cursor), 0)
  INTO v_cursor
  FROM kortix.studio_job_events event
  WHERE event.job_id = p_job_id;

  IF v_job.cancellation_requested_at IS NOT NULL THEN
    v_billing := public.atomic_release_studio_job(
      p_job_id,
      'studio:release:' || p_job_id::text || ':user_cancelled',
      'user_cancelled'
    );

    IF COALESCE((v_billing ->> 'success')::boolean, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Studio cancellation release failed: %', v_billing;
    END IF;

    UPDATE kortix.studio_job_attempts
    SET status = 'cancelled', ended_at = p_completed_at
    WHERE attempt_id = p_attempt_id
      AND job_id = p_job_id;

    UPDATE kortix.studio_jobs
    SET status = 'cancelled',
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

  IF COALESCE((v_billing ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio success settlement failed: %', v_billing;
  END IF;

  IF p_actual_credits > 0 AND NULLIF(v_billing #>> '{debit,transaction_id}', '') IS NOT NULL THEN
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
        'requested_actual_credits', p_actual_credits,
        'capped', v_charged_credits < p_actual_credits
      ),
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
  v_release jsonb;
  v_cursor bigint;
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

  IF v_job.status NOT IN ('queued', 'running') OR v_job.lease_owner IS DISTINCT FROM p_lease_owner THEN
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

  v_release := public.atomic_release_studio_job(
    p_job_id,
    'studio:release:' || p_job_id::text || ':' || p_release_reason,
    p_release_reason
  );

  IF COALESCE((v_release ->> 'success')::boolean, false) IS NOT TRUE THEN
    RAISE EXCEPTION 'Studio terminal reservation release failed: %', v_release;
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

  SELECT COALESCE(MAX(event.cursor), 0) + 1
  INTO v_cursor
  FROM kortix.studio_job_events event
  WHERE event.job_id = p_job_id;

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

REVOKE ALL ON FUNCTION public.atomic_create_studio_job(uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid, text, text, jsonb, text, text, numeric, timestamptz) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atomic_settle_studio_job(uuid, numeric, text, text) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atomic_release_studio_job(uuid, text, text) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) FROM PUBLIC, authenticated;
REVOKE ALL ON FUNCTION public.atomic_finalize_studio_job_terminal(uuid, uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.atomic_create_studio_job(uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid, text, text, jsonb, text, text, numeric, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_settle_studio_job(uuid, numeric, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_release_studio_job(uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_studio_job_success(uuid, uuid, text, numeric, jsonb, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.atomic_finalize_studio_job_terminal(uuid, uuid, text, text, text, text, text, text, timestamptz) TO service_role;
