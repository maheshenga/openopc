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
    OR NOT (
      v_attempt.status = 'reconciling'
      OR (
        v_attempt.status = 'polling'
        AND v_attempt.retry_classification = 'unknown_outcome'
      )
    )
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

REVOKE ALL ON FUNCTION public.atomic_expire_studio_unknown_hold(uuid, uuid, timestamptz)
  FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_expire_studio_unknown_hold(uuid, uuid, timestamptz)
  TO service_role;
