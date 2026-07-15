-- Studio Phase 1 reservation-aware billing RPCs.
-- Keep the existing four-argument atomic_use_credits signature stable so LLM
-- and compute metering continue to call the same function.

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
  v_daily NUMERIC(10,2);
  v_exp NUMERIC(10,2);
  v_nonexp NUMERIC(10,2);
  v_total NUMERIC(10,2);
  v_reserved NUMERIC(12,4) := 0;
  v_available NUMERIC(12,4) := 0;
  v_fd NUMERIC(10,2) := 0;
  v_fe NUMERIC(10,2) := 0;
  v_fn NUMERIC(10,2) := 0;
  v_rem NUMERIC(10,2);
  v_nd NUMERIC(10,2);
  v_ne NUMERIC(10,2);
  v_nn NUMERIC(10,2);
  v_nt NUMERIC(10,2);
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

GRANT EXECUTE ON FUNCTION public.atomic_use_credits(uuid, numeric, text, text) TO service_role, authenticated;

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

  SELECT job_id, request_hash, status
  INTO v_existing
  FROM kortix.studio_jobs
  WHERE account_id = p_account_id
    AND idempotency_key = p_idempotency_key;

  IF FOUND THEN
    IF v_existing.request_hash <> p_request_hash THEN
      RETURN jsonb_build_object('success', false, 'error', 'Idempotency key reused with different request', 'code', 'idempotency_mismatch');
    END IF;

    RETURN jsonb_build_object('success', true, 'idempotent', true, 'job_id', v_existing.job_id, 'status', v_existing.status);
  END IF;

  SELECT COALESCE(balance, 0)
  INTO v_total
  FROM kortix.credit_accounts
  WHERE account_id = p_account_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'No credit account found', 'required', p_reserved_credits, 'available', 0);
  END IF;

  SELECT COALESCE(SUM(amount_credits), 0)
  INTO v_reserved
  FROM kortix.studio_credit_reservations
  WHERE account_id = p_account_id
    AND status = 'active';

  v_available := GREATEST(0, v_total - v_reserved);

  IF v_available < p_reserved_credits THEN
    RETURN jsonb_build_object('success', false, 'error', 'Insufficient credits', 'required', p_reserved_credits, 'available', v_available, 'reserved', v_reserved);
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
BEGIN
  IF p_actual_credits < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Actual credits must be non-negative');
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

  UPDATE kortix.studio_credit_reservations
  SET status = 'settled',
      settlement_key = p_settlement_key,
      settled_at = NOW()
  WHERE reservation_id = v_reservation.reservation_id;

  UPDATE kortix.studio_jobs
  SET actual_credits = p_actual_credits,
      updated_at = NOW()
  WHERE job_id = p_job_id;

  v_debit := public.atomic_use_credits(
    v_reservation.account_id,
    p_actual_credits,
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
    'settled', p_actual_credits,
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

  INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload)
  VALUES (
    p_job_id,
    EXTRACT(EPOCH FROM clock_timestamp())::bigint,
    'billing.reservation_released',
    jsonb_build_object('reason', p_reason, 'released', v_reservation.amount_credits)
  )
  ON CONFLICT DO NOTHING;

  RETURN jsonb_build_object(
    'success', true,
    'idempotent', false,
    'job_id', p_job_id,
    'released', v_reservation.amount_credits
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.atomic_create_studio_job(uuid, uuid, uuid, text, uuid, text, text, uuid, text, uuid, text, text, jsonb, text, text, numeric, timestamptz) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_settle_studio_job(uuid, numeric, text, text) TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_release_studio_job(uuid, text, text) TO service_role, authenticated;
