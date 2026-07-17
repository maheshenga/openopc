import type { AgentGrant } from '@kortix/db';
import type { StudioProviderHandle, StudioRetryClassification } from '@kortix/studio-runtime';
import type {
  StudioCredentialBinding,
  StudioWorkerServiceAccountRow,
  StudioWorkerTokenRow,
} from './authorization';
import type {
  StoredStudioAsset,
  StudioWorkerAttempt,
  StudioWorkerJob,
  StudioWorkerProviderConfig,
  StudioWorkerRepository,
} from './contracts';
import type { StudioMaintenanceRepository, StudioOrphanStagingCandidate } from './maintenance';
import { assertProcessRole } from './memory-repository';

export interface StudioSqlClient {
  unsafe(text: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
}

const CLAIM_SQL = `
WITH picked AS (
  SELECT j.job_id
  FROM kortix.studio_jobs j
  JOIN kortix.studio_provider_configs p
    ON p.provider_config_id = j.provider_config_id
   AND p.project_id = j.project_id
  WHERE j.status IN ('queued', 'running')
    AND COALESCE(j.available_at, now()) <= $1::timestamptz
    AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= $1::timestamptz)
  ORDER BY j.available_at ASC NULLS FIRST, j.created_at ASC
  LIMIT 1
  FOR UPDATE OF j SKIP LOCKED
), claimed AS (
  UPDATE kortix.studio_jobs j
  SET lease_owner = $2,
      lease_expires_at = $3::timestamptz,
      updated_at = $1::timestamptz
  FROM picked
  WHERE j.job_id = picked.job_id
  RETURNING j.*
), next_cursor AS (
  SELECT claimed.job_id, COALESCE(MAX(event.cursor), 0) + 1 AS cursor
  FROM claimed
  LEFT JOIN kortix.studio_job_events event ON event.job_id = claimed.job_id
  GROUP BY claimed.job_id
), claimed_event AS (
  INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
  SELECT
    claimed.job_id,
    next_cursor.cursor,
    'claimed',
    jsonb_build_object('worker_id', $2),
    $1::timestamptz
  FROM claimed JOIN next_cursor USING (job_id)
  RETURNING job_id
)
SELECT c.*, p.credential_binding, p.enabled AS provider_enabled
FROM claimed c
JOIN claimed_event event ON event.job_id = c.job_id
JOIN kortix.studio_provider_configs p ON p.provider_config_id = c.provider_config_id
`;

const PREPARE_ATTEMPT_SQL = `
WITH locked AS (
  SELECT j.job_id, j.attempt_count
  FROM kortix.studio_jobs j
  WHERE j.job_id = $1::uuid
    AND j.lease_owner = $2
    AND j.lease_expires_at > GREATEST(clock_timestamp(), $6::timestamptz)
    AND j.status IN ('queued', 'running')
    AND j.attempt_count < 3
    AND j.cancellation_requested_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM kortix.studio_provider_configs config
      WHERE config.provider_config_id = j.provider_config_id
        AND config.account_id = j.account_id
        AND config.project_id = j.project_id
        AND config.provider = j.provider
        AND config.enabled = true
        AND md5(jsonb_build_object(
          'provider_config_id', config.provider_config_id,
          'account_id', config.account_id,
          'project_id', config.project_id,
          'provider', config.provider,
          'base_url', config.base_url,
          'region', config.region,
          'credential_binding', config.credential_binding,
          'capability_map', config.capability_map,
          'enabled', config.enabled,
          'updated_at', config.updated_at
        )::text) = $5
    )
    AND NOT EXISTS (
      SELECT 1 FROM kortix.studio_job_attempts active
      WHERE active.job_id = j.job_id
        AND active.status IN ('submitting', 'submitted', 'polling', 'reconciling')
    )
  FOR UPDATE
), inserted AS (
  INSERT INTO kortix.studio_job_attempts(
    job_id, submission_key, adapter_version, provider_config_version, status, started_at
  )
  SELECT job_id, $3, $4, $5, 'submitting', $6::timestamptz
  FROM locked
  RETURNING attempt_id, job_id, submission_key, provider_config_version, status, started_at
), updated AS (
  UPDATE kortix.studio_jobs j
  SET status = 'running',
      attempt_count = j.attempt_count + 1,
      started_at = COALESCE(j.started_at, $6::timestamptz),
      error_code = NULL,
      error_message = NULL,
      updated_at = $6::timestamptz
  FROM inserted
  WHERE j.job_id = inserted.job_id
  RETURNING j.job_id, j.attempt_count
)
SELECT inserted.*, updated.attempt_count AS attempt_number
FROM inserted JOIN updated USING (job_id)
`;

export class PostgresStudioWorkerRepository implements StudioWorkerRepository {
  constructor(private readonly client: StudioSqlClient) {}

  async claimNextJob(input: {
    processRole: 'studio-worker';
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<StudioWorkerJob | null> {
    assertProcessRole(input.processRole);
    const rows = await this.client.unsafe(CLAIM_SQL, [
      input.now.toISOString(),
      input.workerId,
      new Date(input.now.getTime() + input.leaseMs).toISOString(),
    ]);
    if (!rows[0]) return null;
    return mapJob(rows[0]);
  }

  async getLatestAttempt(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<StudioWorkerAttempt | null> {
    const rows = await this.client.unsafe(
      `
      WITH owned AS MATERIALIZED (
        SELECT job_id, attempt_count, provider_handle
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $2
          AND lease_expires_at > GREATEST(clock_timestamp(), $3::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      )
      SELECT
        owned.job_id AS owned_job_id,
        latest.*,
        owned.attempt_count AS attempt_number,
        owned.provider_handle
      FROM owned
      LEFT JOIN LATERAL (
        SELECT attempt.*
        FROM kortix.studio_job_attempts attempt
        WHERE attempt.job_id = owned.job_id
        ORDER BY attempt.started_at DESC, attempt.attempt_id DESC
        LIMIT 1
      ) latest ON true
    `,
      [input.jobId, input.workerId, input.now.toISOString()],
    );
    if (!rows[0]) throw new Error('Studio job lease is not owned by this worker');
    return rows[0].attempt_id ? mapAttempt(rows[0]) : null;
  }

  async heartbeatLease(input: {
    jobId: string;
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean> {
    const rows = await this.client.unsafe(
      `
      UPDATE kortix.studio_jobs
      SET lease_expires_at = $3::timestamptz, updated_at = $4::timestamptz
      WHERE job_id = $1::uuid
        AND lease_owner = $2
        AND lease_expires_at > GREATEST(clock_timestamp(), $4::timestamptz)
        AND status IN ('queued', 'running')
      RETURNING job_id
    `,
      [
        input.jobId,
        input.workerId,
        new Date(input.now.getTime() + input.leaseMs).toISOString(),
        input.now.toISOString(),
      ],
    );
    return rows.length > 0;
  }

  async isCancellationRequested(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.client.unsafe(
      `
      SELECT cancellation_requested_at
      FROM kortix.studio_jobs
      WHERE job_id = $1::uuid
        AND lease_owner = $2
        AND lease_expires_at > GREATEST(clock_timestamp(), $3::timestamptz)
        AND status IN ('queued', 'running')
    `,
      [input.jobId, input.workerId, input.now.toISOString()],
    );
    if (!rows[0]) throw new Error('Studio job lease is not owned by this worker');
    return rows[0].cancellation_requested_at != null;
  }

  async loadProviderConfigForSubmission(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<StudioWorkerProviderConfig | null> {
    const rows = await this.client.unsafe(
      `
      SELECT
        config.provider_config_id,
        config.account_id,
        config.project_id,
        config.provider,
        config.enabled,
        config.base_url,
        config.region,
        config.credential_binding,
        config.capability_map,
        md5(jsonb_build_object(
          'provider_config_id', config.provider_config_id,
          'account_id', config.account_id,
          'project_id', config.project_id,
          'provider', config.provider,
          'base_url', config.base_url,
          'region', config.region,
          'credential_binding', config.credential_binding,
          'capability_map', config.capability_map,
          'enabled', config.enabled,
          'updated_at', config.updated_at
        )::text) AS version_token
      FROM kortix.studio_jobs job
      JOIN kortix.studio_provider_configs config
        ON config.provider_config_id = job.provider_config_id
       AND config.account_id = job.account_id
       AND config.project_id = job.project_id
      WHERE job.job_id = $1::uuid
        AND job.lease_owner = $2
        AND job.lease_expires_at > GREATEST(clock_timestamp(), $3::timestamptz)
        AND job.status IN ('queued', 'running')
      LIMIT 1
    `,
      [input.jobId, input.workerId, input.now.toISOString()],
    );
    if (!rows[0]) return null;
    const versionToken = String(rows[0].version_token ?? '');
    if (!versionToken) return null;
    return {
      providerConfigId: String(rows[0].provider_config_id),
      accountId: String(rows[0].account_id),
      projectId: String(rows[0].project_id),
      provider: String(rows[0].provider),
      enabled: rows[0].enabled === true,
      baseUrl: nullableString(rows[0].base_url),
      region: nullableString(rows[0].region),
      definitionId: providerDefinitionId(rows[0].capability_map, rows[0].provider),
      credentialBinding: (rows[0].credential_binding ?? {}) as Record<string, unknown>,
      capabilityMap: (rows[0].capability_map ?? {}) as Record<string, unknown>,
      versionToken,
    };
  }

  async prepareAttempt(input: {
    jobId: string;
    workerId: string;
    submissionKey: string;
    adapterVersion: string;
    providerConfigVersion: string;
    now: Date;
  }): Promise<StudioWorkerAttempt | null> {
    const rows = await this.client.unsafe(PREPARE_ATTEMPT_SQL, [
      input.jobId,
      input.workerId,
      input.submissionKey,
      input.adapterVersion,
      input.providerConfigVersion,
      input.now.toISOString(),
    ]);
    return rows[0] ? mapAttempt(rows[0]) : null;
  }

  async markSubmitted(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    handle: StudioProviderHandle;
    now: Date;
  }): Promise<void> {
    await this.requireOwnedMutation(
      `
      WITH owned AS (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $3
          AND lease_expires_at > GREATEST(clock_timestamp(), $6::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      ), attempt_update AS (
        UPDATE kortix.studio_job_attempts attempt
        SET status = 'submitted', provider_request_id = $4
        FROM owned
        WHERE attempt.attempt_id = $2::uuid
          AND attempt.job_id = owned.job_id
          AND attempt.status IN ('submitting', 'submitted', 'polling', 'reconciling')
          AND attempt.submission_key = $7
          AND (attempt.provider_request_id IS NULL OR attempt.provider_request_id = $4)
        RETURNING attempt.job_id
      )
      , job_update AS (
        UPDATE kortix.studio_jobs j
        SET provider_handle = $5, updated_at = $6::timestamptz
        FROM attempt_update
        WHERE j.job_id = attempt_update.job_id
          AND j.lease_owner = $3
        RETURNING j.job_id
      ), next_cursor AS (
        SELECT COALESCE(MAX(event.cursor), 0) + 1 AS cursor
        FROM kortix.studio_job_events event
        JOIN job_update ON job_update.job_id = event.job_id
      ), submitted_event AS (
        INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
        SELECT
          job_update.job_id,
          next_cursor.cursor,
          'provider-submitted',
          jsonb_build_object(
            'submission_key', $7::text,
            'provider_request_id', $4::text
          ),
          $6::timestamptz
        FROM job_update CROSS JOIN next_cursor
        WHERE NOT EXISTS (
          SELECT 1
          FROM kortix.studio_job_events existing
          WHERE existing.job_id = job_update.job_id
            AND existing.event_type = 'provider-submitted'
            AND existing.payload ->> 'submission_key' = $7::text
        )
        RETURNING job_id
      )
      SELECT job_id FROM submitted_event
      UNION ALL
      SELECT job_update.job_id
      FROM job_update
      WHERE EXISTS (
        SELECT 1
        FROM kortix.studio_job_events existing
        WHERE existing.job_id = job_update.job_id
          AND existing.event_type = 'provider-submitted'
          AND existing.payload ->> 'submission_key' = $7::text
      )
      LIMIT 1
    `,
      [
        input.jobId,
        input.attemptId,
        input.workerId,
        input.handle.id,
        JSON.stringify(input.handle),
        input.now.toISOString(),
        input.handle.submission_key,
      ],
    );
  }

  async markReconciling(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    availableAt: Date;
    message: string;
    now: Date;
  }): Promise<void> {
    await this.updateAttemptAndRelease({
      ...input,
      attemptStatus: 'reconciling',
      retryClassification: 'unknown_outcome',
      errorCode: 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
      eventType: 'progress',
      eventPayload: { phase: 'reconciling' },
    });
  }

  async schedulePoll(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    availableAt: Date;
    progress?: number;
    now: Date;
  }): Promise<void> {
    await this.updateAttemptAndRelease({
      ...input,
      attemptStatus: 'polling',
      retryClassification: null,
      errorCode: null,
      message: '',
      eventType: 'progress',
      eventPayload: {
        ...(input.progress === undefined ? {} : { progress: input.progress }),
      },
    });
  }

  async scheduleContinuation(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    phase: 'polling' | 'reconciling';
    classification: StudioRetryClassification;
    availableAt: Date;
    code: string;
    message: string;
    now: Date;
  }): Promise<void> {
    await this.updateAttemptAndRelease({
      ...input,
      attemptStatus: input.phase,
      retryClassification: input.classification,
      errorCode: input.code,
      eventType: 'retry-scheduled',
      eventPayload: {
        phase: input.phase,
        classification: input.classification,
        available_at: input.availableAt.toISOString(),
      },
    });
  }

  async scheduleRetry(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    classification: StudioRetryClassification;
    availableAt: Date;
    message: string;
    now: Date;
  }): Promise<void> {
    await this.updateAttemptAndRelease({
      ...input,
      attemptStatus: 'failed',
      retryClassification: input.classification,
      errorCode: null,
      eventType: 'retry-scheduled',
      eventPayload: {
        classification: input.classification,
        available_at: input.availableAt.toISOString(),
      },
    });
  }

  async finalizeSuccess(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    actualCredits: number;
    assets: StoredStudioAsset[];
    now: Date;
  }): Promise<'succeeded' | 'cancelled'> {
    const rows = await this.client.unsafe(
      `
      WITH owned AS MATERIALIZED (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $3
          AND lease_expires_at > GREATEST(clock_timestamp(), $6::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      )
      SELECT public.atomic_finalize_studio_job_success(
        $1::uuid, $2::uuid, $3, $4::numeric, $5::jsonb, $6::timestamptz
      ) AS result
      FROM owned
    `,
      [
        input.jobId,
        input.attemptId,
        input.workerId,
        input.actualCredits,
        JSON.stringify(input.assets),
        input.now.toISOString(),
      ],
    );
    const result = rows[0]?.result as Record<string, unknown> | undefined;
    if (!result || result.success !== true) {
      throw new Error(String(result?.error ?? 'Studio success finalization RPC failed'));
    }
    if (result.outcome !== 'succeeded' && result.outcome !== 'cancelled') {
      throw new Error('Studio success finalization RPC returned an invalid outcome');
    }
    return result.outcome;
  }

  async recordStagedManifest(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    submissionKind: 'async' | 'completed';
    manifestKey: string;
    manifestChecksum: string;
    now: Date;
  }): Promise<void> {
    await this.requireOwnedMutation(
      `
      WITH owned AS (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $3
          AND lease_expires_at > GREATEST(clock_timestamp(), $7::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      )
      UPDATE kortix.studio_job_attempts attempt
      SET status = CASE WHEN attempt.status = 'submitting' THEN 'reconciling' ELSE attempt.status END,
          submission_kind = $4,
          staging_manifest_key = $5,
          staging_manifest_checksum = $6
      FROM owned
      WHERE attempt.attempt_id = $2::uuid
        AND attempt.job_id = owned.job_id
        AND attempt.status IN ('submitting', 'submitted', 'polling', 'reconciling')
        AND (attempt.submission_kind IS NULL OR attempt.submission_kind = $4)
        AND (attempt.staging_manifest_key IS NULL OR attempt.staging_manifest_key = $5)
        AND (attempt.staging_manifest_checksum IS NULL OR attempt.staging_manifest_checksum = $6)
      RETURNING attempt.attempt_id
    `,
      [
        input.jobId,
        input.attemptId,
        input.workerId,
        input.submissionKind,
        input.manifestKey,
        input.manifestChecksum,
        input.now.toISOString(),
      ],
    );
  }

  async recordAttemptCost(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    usage: Record<string, number>;
    upstreamCostCredits: number;
    outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    now: Date;
  }): Promise<void> {
    const rows = await this.client.unsafe(
      `
      SELECT public.atomic_record_studio_attempt_cost(
        $1::uuid, $2::uuid, $3, $4::jsonb, $5::numeric, $6, $7::timestamptz
      ) AS result
    `,
      [
        input.jobId,
        input.attemptId,
        input.workerId,
        JSON.stringify(input.usage),
        input.upstreamCostCredits,
        input.outcome,
        input.now.toISOString(),
      ],
    );
    const result = rows[0]?.result as Record<string, unknown> | undefined;
    if (!result || result.success !== true) {
      throw new Error(String(result?.error ?? 'Studio attempt cost RPC failed'));
    }
  }

  async getRecordedAttemptCostTotal(input: {
    jobId: string;
    workerId: string;
    now: Date;
  }): Promise<number> {
    const rows = await this.client.unsafe(
      `
      WITH owned AS (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $2
          AND lease_expires_at > GREATEST(clock_timestamp(), $3::timestamptz)
          AND status IN ('queued', 'running')
      )
      SELECT COALESCE(SUM(attempt.upstream_cost_credits), 0) AS total
      FROM owned
      LEFT JOIN kortix.studio_job_attempts attempt
        ON attempt.job_id = owned.job_id
       AND attempt.cost_recorded_at IS NOT NULL
      GROUP BY owned.job_id
    `,
      [input.jobId, input.workerId, input.now.toISOString()],
    );
    if (!rows[0]) throw new Error('Studio job lease is not owned by this worker');
    const total = Number(rows[0].total ?? 0);
    if (!Number.isFinite(total) || total < 0) {
      throw new Error('Studio recorded attempt cost total is invalid');
    }
    return total;
  }

  async markFailed(input: {
    jobId: string;
    attemptId?: string;
    workerId: string;
    code: string;
    message: string;
    classification?: StudioRetryClassification;
    now: Date;
  }): Promise<void> {
    await this.terminalMutation({
      ...input,
      status: 'failed',
      releaseReason: 'terminal_failure',
    });
  }

  async markCancelled(input: {
    jobId: string;
    attemptId?: string;
    workerId: string;
    reason: string;
    code?: string;
    message?: string;
    now: Date;
  }): Promise<void> {
    await this.terminalMutation({
      ...input,
      status: 'cancelled',
      releaseReason: input.reason,
    });
  }

  async abandonLease(input: {
    jobId: string;
    workerId: string;
    availableAt: Date;
    now: Date;
  }): Promise<void> {
    await this.requireOwnedMutation(
      `
      UPDATE kortix.studio_jobs
      SET lease_owner = NULL, lease_expires_at = NULL, available_at = $3::timestamptz, updated_at = now()
      WHERE job_id = $1::uuid
        AND lease_owner = $2
        AND lease_expires_at > GREATEST(clock_timestamp(), $4::timestamptz)
      RETURNING job_id
    `,
      [input.jobId, input.workerId, input.availableAt.toISOString(), input.now.toISOString()],
    );
  }

  private async updateAttemptAndRelease(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    availableAt: Date;
    now: Date;
    attemptStatus: string;
    retryClassification: StudioRetryClassification | null;
    errorCode: string | null;
    message: string;
    eventType: string;
    eventPayload: Record<string, unknown>;
  }) {
    await this.requireOwnedMutation(
      `
      WITH owned AS (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $3
          AND lease_expires_at > GREATEST(clock_timestamp(), $8::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      ), attempt_update AS (
        UPDATE kortix.studio_job_attempts attempt
        SET status = $4::kortix.studio_attempt_status,
            retry_classification = $5,
            ended_at = CASE WHEN $4 = 'failed' THEN $8::timestamptz ELSE ended_at END
        FROM owned
        WHERE attempt.attempt_id = $2::uuid
          AND attempt.job_id = owned.job_id
        RETURNING attempt.job_id
      ), job_update AS (
        UPDATE kortix.studio_jobs j
        SET provider_handle = CASE WHEN $4 = 'failed' THEN NULL ELSE provider_handle END,
            available_at = $6::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            error_code = $7,
            error_message = NULLIF($9, ''),
            updated_at = $8::timestamptz
        FROM attempt_update
        WHERE j.job_id = attempt_update.job_id AND j.lease_owner = $3
        RETURNING j.job_id
      ), next_cursor AS (
        SELECT COALESCE(MAX(event.cursor), 0) + 1 AS cursor
        FROM kortix.studio_job_events event
        JOIN job_update ON job_update.job_id = event.job_id
      ), durable_event AS (
        INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
        SELECT job_update.job_id, next_cursor.cursor, $10, $11::jsonb, $8::timestamptz
        FROM job_update CROSS JOIN next_cursor
        RETURNING job_id
      )
      SELECT job_id FROM durable_event
    `,
      [
        input.jobId,
        input.attemptId,
        input.workerId,
        input.attemptStatus,
        input.retryClassification,
        input.availableAt.toISOString(),
        input.errorCode,
        input.now.toISOString(),
        input.message,
        input.eventType,
        JSON.stringify(input.eventPayload),
      ],
    );
  }

  private async terminalMutation(input: {
    jobId: string;
    attemptId?: string;
    workerId: string;
    status: 'failed' | 'cancelled';
    releaseReason: string;
    code?: string;
    message?: string;
    classification?: StudioRetryClassification;
    now: Date;
  }) {
    const rows = await this.client.unsafe(
      `
      WITH owned AS MATERIALIZED (
        SELECT job_id
        FROM kortix.studio_jobs
        WHERE job_id = $1::uuid
          AND lease_owner = $3
          AND lease_expires_at > GREATEST(clock_timestamp(), $9::timestamptz)
          AND status IN ('queued', 'running')
        FOR UPDATE
      )
      SELECT public.atomic_finalize_studio_job_terminal(
        $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz
      ) AS result
      FROM owned
    `,
      [
        input.jobId,
        input.attemptId ?? null,
        input.workerId,
        input.status,
        input.code ?? null,
        input.message ?? null,
        input.classification ?? null,
        input.releaseReason,
        input.now.toISOString(),
      ],
    );
    const result = rows[0]?.result as Record<string, unknown> | undefined;
    if (!result || result.success !== true) {
      throw new Error(String(result?.error ?? 'Studio terminal finalization RPC failed'));
    }
  }

  private async requireOwnedMutation(text: string, values: unknown[]) {
    const rows = await this.client.unsafe(text, values);
    if (!rows[0]) throw new Error('Studio job lease is not owned by this worker');
  }
}

function providerDefinitionId(capabilityMap: unknown, provider: unknown): string {
  if (capabilityMap && typeof capabilityMap === 'object') {
    const definitionId = (capabilityMap as Record<string, unknown>).definition_id;
    if (typeof definitionId === 'string' && definitionId.trim()) {
      return definitionId;
    }
  }
  return String(provider);
}

export class PostgresStudioMaintenanceRepository implements StudioMaintenanceRepository {
  constructor(private readonly client: StudioSqlClient) {}

  async acquireOrRenewLease(input: {
    lockKey: string;
    ownerId: string;
    expiresAt: Date;
    now: Date;
  }): Promise<boolean> {
    const rows = await this.client.unsafe(
      `
      INSERT INTO kortix.worker_leader_lease AS lease(lock_key, owner_id, expires_at, updated_at)
      VALUES ($1, $2, $3::timestamptz, $4::timestamptz)
      ON CONFLICT (lock_key) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            expires_at = EXCLUDED.expires_at,
            updated_at = EXCLUDED.updated_at
        WHERE lease.owner_id = EXCLUDED.owner_id OR lease.expires_at < $4::timestamptz
      RETURNING owner_id
    `,
      [input.lockKey, input.ownerId, input.expiresAt.toISOString(), input.now.toISOString()],
    );
    return rows[0]?.owner_id === input.ownerId;
  }

  async releaseLease(input: { lockKey: string; ownerId: string }): Promise<void> {
    await this.client.unsafe(
      `
      DELETE FROM kortix.worker_leader_lease WHERE lock_key = $1 AND owner_id = $2
    `,
      [input.lockKey, input.ownerId],
    );
  }

  async requeueExpiredJobLeases(now: Date): Promise<void> {
    await this.client.unsafe(
      `
      UPDATE kortix.studio_jobs
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1::timestamptz
      WHERE status IN ('queued', 'running') AND lease_expires_at <= $1::timestamptz
    `,
      [now.toISOString()],
    );
  }

  async failStuckUnknownOutcomes(now: Date): Promise<void> {
    await this.client.unsafe(
      `
      WITH candidates AS (
        SELECT j.job_id, a.attempt_id
        FROM kortix.studio_jobs j
        JOIN kortix.studio_job_attempts a ON a.job_id = j.job_id
        WHERE j.status = 'running'
          AND (
            a.status = 'reconciling'
            OR (
              a.status = 'polling'
              AND a.retry_classification = 'unknown_outcome'
            )
          )
          AND j.available_at <= $1::timestamptz
          AND a.started_at <= $1::timestamptz - interval '15 minutes'
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= $1::timestamptz)
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 100
      ), released AS (
        UPDATE kortix.studio_jobs j
        SET error_code = 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
            error_message = 'Provider submission outcome requires operator recovery',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $1::timestamptz
        FROM candidates
        WHERE j.job_id = candidates.job_id
          AND j.status = 'running'
        RETURNING j.job_id, candidates.attempt_id
      ), next_cursor AS (
        SELECT released.job_id, released.attempt_id,
               COALESCE(MAX(event.cursor), 0) + 1 AS cursor
        FROM released
        LEFT JOIN kortix.studio_job_events event ON event.job_id = released.job_id
        GROUP BY released.job_id, released.attempt_id
      )
      INSERT INTO kortix.studio_job_events(job_id, cursor, event_type, payload, created_at)
      SELECT next_cursor.job_id, next_cursor.cursor, 'progress',
             jsonb_build_object(
               'phase', 'operator-review',
               'attempt_id', next_cursor.attempt_id,
               'code', 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN'
             ),
             $1::timestamptz
      FROM next_cursor
      WHERE NOT EXISTS (
        SELECT 1
        FROM kortix.studio_job_events existing
        WHERE existing.job_id = next_cursor.job_id
          AND existing.event_type = 'progress'
          AND existing.payload ->> 'phase' = 'operator-review'
      )
    `,
      [now.toISOString()],
    );
    await this.client.unsafe(
      `
      SELECT public.atomic_expire_studio_unknown_hold(
        candidate.job_id,
        candidate.attempt_id,
        $1::timestamptz
      ) AS result
      FROM (
        SELECT j.job_id, attempt.attempt_id
        FROM kortix.studio_jobs j
        JOIN kortix.studio_job_attempts attempt
          ON attempt.job_id = j.job_id
         AND (
           attempt.status = 'reconciling'
           OR (
             attempt.status = 'polling'
             AND attempt.retry_classification = 'unknown_outcome'
           )
         )
        JOIN kortix.studio_credit_reservations reservation
          ON reservation.job_id = j.job_id
         AND reservation.status = 'active'
        WHERE j.status = 'running'
          AND reservation.created_at + interval '30 days' <= $1::timestamptz
          AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= $1::timestamptz)
        ORDER BY reservation.created_at ASC
        LIMIT 100
      ) candidate
    `,
      [now.toISOString()],
    );
  }

  async compactProgressEvents(now: Date): Promise<void> {
    await this.client.unsafe(
      `
      WITH candidates AS (
        SELECT event.event_id
        FROM kortix.studio_job_events event
        WHERE event_type = 'progress'
          AND created_at < $1::timestamptz - interval '7 days'
          AND EXISTS (
            SELECT 1
            FROM kortix.studio_job_events newer
            WHERE newer.job_id = event.job_id
              AND newer.cursor > event.cursor
          )
        ORDER BY created_at ASC
        LIMIT 1000
      )
      DELETE FROM kortix.studio_job_events e USING candidates
      WHERE e.event_id = candidates.event_id
    `,
      [now.toISOString()],
    );
  }

  async expireUploads(now: Date): Promise<void> {
    await this.client.unsafe(
      `
      UPDATE kortix.studio_asset_uploads
      SET status = 'expired', updated_at = $1::timestamptz
      WHERE status = 'pending' AND expires_at <= $1::timestamptz
    `,
      [now.toISOString()],
    );
  }

  async reconcileCreditReservations(now: Date): Promise<void> {
    const rows = await this.client.unsafe(
      `
      SELECT r.job_id
      FROM kortix.studio_credit_reservations r
      JOIN kortix.studio_jobs j ON j.job_id = r.job_id
      WHERE r.status = 'active'
        AND r.expires_at <= $1::timestamptz
        AND j.status IN ('succeeded', 'failed', 'cancelled')
        AND COALESCE(j.error_code, '') <> 'STUDIO_SUBMISSION_OUTCOME_UNKNOWN'
      ORDER BY r.expires_at ASC
      LIMIT 100
    `,
      [now.toISOString()],
    );
    for (const row of rows) {
      await this.client.unsafe(
        `
        SELECT public.atomic_release_studio_job($1::uuid, $2, $3) AS result
      `,
        [
          String(row.job_id),
          `studio:maintenance-release:${row.job_id}`,
          'expired_terminal_reservation',
        ],
      );
    }
  }

  async listOrphanStagingCandidates(input: {
    retentionBefore: Date;
    after?: { terminalAt: Date; attemptId: string };
    limit: number;
  }): Promise<StudioOrphanStagingCandidate[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('Studio orphan candidate limit must be between 1 and 100');
    }
    if (
      input.after &&
      (!Number.isFinite(input.after.terminalAt.getTime()) || !input.after.attemptId.trim())
    ) {
      throw new Error('Studio orphan candidate cursor is invalid');
    }
    const rows = await this.client.unsafe(
      `
      SELECT
        job.account_id,
        job.project_id,
        job.job_id,
        attempt.attempt_id,
        attempt.submission_key,
        COALESCE(attempt.ended_at, job.completed_at) AS terminal_at
      FROM kortix.studio_job_attempts attempt
      JOIN kortix.studio_jobs job ON job.job_id = attempt.job_id
      WHERE job.status IN ('succeeded', 'failed', 'cancelled')
        AND attempt.status IN ('succeeded', 'failed', 'cancelled')
        AND attempt.retry_classification IS DISTINCT FROM 'unknown_outcome'
        AND attempt.staging_manifest_key IS NULL
        AND attempt.staging_manifest_checksum IS NULL
        AND job.error_code IS DISTINCT FROM 'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED'
        AND NOT EXISTS (
          SELECT 1
          FROM kortix.studio_billing_incidents incident
          WHERE incident.job_id = job.job_id
            AND incident.attempt_id = attempt.attempt_id
            AND incident.status = 'open'
        )
        AND COALESCE(attempt.ended_at, job.completed_at) <= $1::timestamptz
        AND (
          $2::timestamptz IS NULL
          OR COALESCE(attempt.ended_at, job.completed_at) > $2::timestamptz
          OR (
            COALESCE(attempt.ended_at, job.completed_at) = $2::timestamptz
            AND attempt.attempt_id > $3::uuid
          )
        )
      ORDER BY COALESCE(attempt.ended_at, job.completed_at) ASC, attempt.attempt_id ASC
      LIMIT $4
    `,
      [
        input.retentionBefore.toISOString(),
        input.after?.terminalAt.toISOString() ?? null,
        input.after?.attemptId ?? null,
        input.limit,
      ],
    );
    return rows.map((row) => {
      const terminalAt = nullableDate(row.terminal_at);
      if (!terminalAt) throw new Error('Studio orphan candidate terminal time is invalid');
      return {
        accountId: String(row.account_id),
        projectId: String(row.project_id),
        jobId: String(row.job_id),
        attemptId: String(row.attempt_id),
        submissionKey: String(row.submission_key),
        terminalAt,
      };
    });
  }

  async isOrphanStagingCandidate(input: {
    candidate: StudioOrphanStagingCandidate;
    retentionBefore: Date;
  }): Promise<boolean> {
    const rows = await this.client.unsafe(
      `
      SELECT 1 AS eligible
      FROM kortix.studio_job_attempts attempt
      JOIN kortix.studio_jobs job ON job.job_id = attempt.job_id
      WHERE job.account_id = $1::uuid
        AND job.project_id = $2::uuid
        AND job.job_id = $3::uuid
        AND attempt.attempt_id = $4::uuid
        AND attempt.submission_key = $5
        AND COALESCE(attempt.ended_at, job.completed_at) = $6::timestamptz
        AND COALESCE(attempt.ended_at, job.completed_at) <= $7::timestamptz
        AND job.status IN ('succeeded', 'failed', 'cancelled')
        AND attempt.status IN ('succeeded', 'failed', 'cancelled')
        AND attempt.retry_classification IS DISTINCT FROM 'unknown_outcome'
        AND attempt.staging_manifest_key IS NULL
        AND attempt.staging_manifest_checksum IS NULL
        AND job.error_code IS DISTINCT FROM 'STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED'
        AND NOT EXISTS (
          SELECT 1
          FROM kortix.studio_billing_incidents incident
          WHERE incident.job_id = job.job_id
            AND incident.attempt_id = attempt.attempt_id
            AND incident.status = 'open'
        )
      LIMIT 1
    `,
      [
        input.candidate.accountId,
        input.candidate.projectId,
        input.candidate.jobId,
        input.candidate.attemptId,
        input.candidate.submissionKey,
        input.candidate.terminalAt.toISOString(),
        input.retentionBefore.toISOString(),
      ],
    );
    return rows.length > 0;
  }
}

export function createPostgresStudioTokenLoader(client: StudioSqlClient) {
  return async (tokenId: string): Promise<StudioWorkerTokenRow | null> => {
    const rows = await client.unsafe(
      `
      SELECT
        status, revoked_at, expires_at, project_id, account_id, user_id,
        session_id, service_account_id, agent_grant
      FROM kortix.account_tokens WHERE token_id = $1::uuid LIMIT 1
    `,
      [tokenId],
    );
    if (!rows[0]) return null;
    return {
      status: String(rows[0].status),
      revokedAt: nullableDate(rows[0].revoked_at),
      expiresAt: nullableDate(rows[0].expires_at),
      projectId: nullableString(rows[0].project_id),
      accountId: String(rows[0].account_id),
      userId: String(rows[0].user_id),
      sessionId: nullableString(rows[0].session_id),
      serviceAccountId: nullableString(rows[0].service_account_id),
      agentGrant: (rows[0].agent_grant ?? null) as AgentGrant | null,
    };
  };
}

export function createPostgresStudioServiceAccountLoader(client: StudioSqlClient) {
  return async (serviceAccountId: string): Promise<StudioWorkerServiceAccountRow | null> => {
    const rows = await client.unsafe(
      `
      SELECT status, expires_at, account_id, project_id, agent_name
      FROM kortix.service_accounts
      WHERE service_account_id = $1::uuid
      LIMIT 1
    `,
      [serviceAccountId],
    );
    if (!rows[0]) return null;
    return {
      status: String(rows[0].status),
      expiresAt: nullableDate(rows[0].expires_at),
      accountId: String(rows[0].account_id),
      projectId: nullableString(rows[0].project_id),
      agentName: nullableString(rows[0].agent_name),
    };
  };
}

export function createPostgresStudioCredentialValidator(client: StudioSqlClient) {
  return async (input: {
    accountId: string;
    projectId: string;
    binding: StudioCredentialBinding;
  }): Promise<boolean> => {
    if (input.binding.kind === 'none') return true;
    if (input.binding.kind === 'secret') {
      const rows = await client.unsafe(
        `
        SELECT 1
        FROM kortix.project_secrets secret
        JOIN kortix.projects project ON project.project_id = secret.project_id
        WHERE secret.project_id = $1::uuid
          AND project.account_id = $2::uuid
          AND secret.identifier = $3
          AND secret.owner_user_id IS NULL
          AND secret.active = true
          AND btrim(secret.value_enc) <> ''
        LIMIT 1
      `,
        [input.projectId, input.accountId, input.binding.identifier],
      );
      return rows.length > 0;
    }
    const rows = await client.unsafe(
      `
      SELECT 1
      FROM kortix.executor_connectors connector
      JOIN kortix.executor_connection_profiles profile
        ON profile.connector_id = connector.connector_id
       AND profile.account_id = connector.account_id
       AND profile.project_id = connector.project_id
       AND profile.is_default = true
       AND profile.status = 'active'
      JOIN kortix.executor_credentials credential
        ON credential.connector_id = connector.connector_id
       AND credential.profile_id = profile.profile_id
      WHERE connector.project_id = $1::uuid
        AND connector.account_id = $2::uuid
        AND connector.slug = $3
        AND connector.enabled = true
        AND connector.status = 'active'
        AND btrim(credential.value_enc) <> ''
      LIMIT 1
    `,
      [input.projectId, input.accountId, input.binding.slug],
    );
    return rows.length > 0;
  };
}

function mapJob(row: Record<string, unknown>): StudioWorkerJob {
  return {
    jobId: String(row.job_id),
    accountId: String(row.account_id),
    projectId: String(row.project_id),
    actorUserId: nullableString(row.actor_user_id),
    actorType: String(row.actor_type) as StudioWorkerJob['actorType'],
    actingTokenId: nullableString(row.acting_token_id),
    agentName: nullableString(row.agent_name),
    sessionId: nullableString(row.session_id),
    capability: 'image.generate',
    providerConfigId: String(row.provider_config_id),
    providerConfigVersion: nullableString(row.provider_config_version),
    providerEnabled: row.provider_enabled === true,
    provider: String(row.provider),
    model: String(row.model),
    input: row.input as StudioWorkerJob['input'],
    status: String(row.status) as StudioWorkerJob['status'],
    attemptCount: Number(row.attempt_count ?? 0),
    providerHandle: parseHandle(row.provider_handle),
    cancellationRequestedAt: nullableDate(row.cancellation_requested_at),
    reservedCredits: Number(row.reserved_credits ?? 0),
    actualCredits: row.actual_credits == null ? null : Number(row.actual_credits),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    availableAt: nullableDate(row.available_at) ?? new Date(),
    createdAt: nullableDate(row.created_at) ?? new Date(),
    leaseOwner: nullableString(row.lease_owner),
    leaseExpiresAt: nullableDate(row.lease_expires_at),
    credentialBinding: (row.credential_binding ?? {}) as Record<string, unknown>,
    pricingSnapshot: (row.pricing_snapshot ?? null) as StudioWorkerJob['pricingSnapshot'],
  };
}

function mapAttempt(row: Record<string, unknown>): StudioWorkerAttempt {
  return {
    attemptId: String(row.attempt_id),
    jobId: String(row.job_id),
    attemptNumber: Number(row.attempt_number ?? 0),
    submissionKey: String(row.submission_key),
    status: String(row.status) as StudioWorkerAttempt['status'],
    providerHandle: parseHandle(row.provider_handle),
    retryClassification: (row.retry_classification ?? null) as StudioRetryClassification | null,
    startedAt: nullableDate(row.started_at) ?? new Date(),
    endedAt: nullableDate(row.ended_at),
    providerConfigVersion: nullableString(row.provider_config_version),
    submissionKind: nullableString(row.submission_kind) as StudioWorkerAttempt['submissionKind'],
    stagingManifestKey: nullableString(row.staging_manifest_key),
    stagingManifestChecksum: nullableString(row.staging_manifest_checksum),
    costOutcome: nullableString(row.cost_outcome) as StudioWorkerAttempt['costOutcome'],
    costRecordedAt: nullableDate(row.cost_recorded_at),
    upstreamUsage: (row.upstream_usage ?? null) as StudioWorkerAttempt['upstreamUsage'],
    upstreamCostCredits:
      row.upstream_cost_credits == null ? null : Number(row.upstream_cost_credits),
  };
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableDate(value: unknown): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseHandle(value: unknown): StudioProviderHandle | null {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Record<string, unknown>;
    if (!candidate.provider || !candidate.id || !candidate.submission_key) return null;
    return {
      provider: String(candidate.provider),
      id: String(candidate.id),
      submission_key: String(candidate.submission_key),
    };
  } catch {
    return null;
  }
}
