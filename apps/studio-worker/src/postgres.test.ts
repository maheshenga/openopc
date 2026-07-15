import { describe, expect, test } from 'bun:test';
import {
  PostgresStudioMaintenanceRepository,
  PostgresStudioWorkerRepository,
  createPostgresStudioCredentialValidator,
} from './postgres';

describe('PostgresStudioWorkerRepository', () => {
  test('claims work atomically with FOR UPDATE SKIP LOCKED and a bounded lease', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      unsafe: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return [];
      },
    };
    const repository = new PostgresStudioWorkerRepository(client);

    await repository.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a',
      now: new Date('2026-07-15T10:00:00.000Z'),
      leaseMs: 30_000,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('FOR UPDATE OF j SKIP LOCKED');
    expect(queries[0]?.text).toContain('lease_owner');
    expect(queries[0]?.text).toContain('lease_expires_at');
    expect(queries[0]?.text).toContain('INSERT INTO kortix.studio_job_events');
    expect(queries[0]?.text).toContain("'claimed'");
    expect(queries[0]?.values).toContain('worker-a');
  });

  test('prepares the attempt and increments the attempt budget in one owner-guarded statement', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      unsafe: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return [
          {
            attempt_id: '11111111-1111-4111-8111-111111111111',
            job_id: '22222222-2222-4222-8222-222222222222',
            attempt_number: 1,
            submission_key: 'submission-1',
            status: 'submitting',
            started_at: '2026-07-15T10:00:00.000Z',
          },
        ];
      },
    };
    const repository = new PostgresStudioWorkerRepository(client);

    const attempt = await repository.prepareAttempt({
      jobId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a',
      submissionKey: 'submission-1',
      adapterVersion: 'worker-v1',
      providerConfigVersion: '2026-07-15 09:59:00+00',
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(attempt).toMatchObject({
      attemptNumber: 1,
      submissionKey: 'submission-1',
      status: 'submitting',
    });
    expect(queries[0]?.text).toContain('INSERT INTO kortix.studio_job_attempts');
    expect(queries[0]?.text).toContain('attempt_count < 3');
    expect(queries[0]?.text).toContain('lease_owner =');
    expect(queries[0]?.text).toContain('md5(jsonb_build_object(');
  });

  test('finalizes success, settlement, assets, usage, and terminal events in one RPC', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      unsafe: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return [{ result: { success: true, outcome: 'succeeded' } }];
      },
    };
    const repository = new PostgresStudioWorkerRepository(client);

    const outcome = await repository.finalizeSuccess({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a:claim-1',
      actualCredits: 1.25,
      assets: [
        {
          kind: 'image',
          mimeType: 'image/png',
          bucket: 'studio-test',
          objectKey: 'jobs/job-1/attempt-1/result.png',
          checksumSha256: 'abc123',
          sizeBytes: 4,
          filename: 'result.png',
        },
      ],
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(outcome).toBe('succeeded');
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('public.atomic_finalize_studio_job_success');
    expect(queries[0]?.values).toContain('worker-a:claim-1');
    expect(String(queries[0]?.values.at(4))).toContain('result.png');
  });

  test('rechecks cancellation against the currently owned row before local finalization work', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresStudioWorkerRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [{ cancellation_requested_at: '2026-07-15T10:00:01.000Z' }];
      },
    });

    const requested = await repository.isCancellationRequested({
      jobId: '11111111-1111-4111-8111-111111111111',
      workerId: 'worker-a:claim-1',
    });

    expect(requested).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('lease_owner = $2');
    expect(queries[0]?.values).toContain('worker-a:claim-1');
  });

  test('reloads the tenant-bound provider configuration from the owned job before submission', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresStudioWorkerRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [
          {
            provider_config_id: '33333333-3333-4333-8333-333333333333',
            account_id: '44444444-4444-4444-8444-444444444444',
            project_id: '55555555-5555-4555-8555-555555555555',
            provider: 'fake',
            enabled: true,
            credential_binding: { kind: 'none' },
            capability_map: { capabilities: ['image.generate'] },
            version_token: '2026-07-15 10:00:00+00',
          },
        ];
      },
    });

    const config = await repository.loadProviderConfigForSubmission({
      jobId: '11111111-1111-4111-8111-111111111111',
      workerId: 'worker-a:claim-1',
    });

    expect(config).toMatchObject({ provider: 'fake', enabled: true });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('config.account_id = job.account_id');
    expect(queries[0]?.text).toContain('config.project_id = job.project_id');
    expect(queries[0]?.values).toContain('worker-a:claim-1');
  });

  test('validates tenant credentials against non-empty active secrets and default connector credentials', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const validator = createPostgresStudioCredentialValidator({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [{ exists: 1 }];
      },
    });

    await validator({
      accountId: '44444444-4444-4444-8444-444444444444',
      projectId: '55555555-5555-4555-8555-555555555555',
      binding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
    });
    await validator({
      accountId: '44444444-4444-4444-8444-444444444444',
      projectId: '55555555-5555-4555-8555-555555555555',
      binding: { kind: 'connector', slug: 'aliyun-media' },
    });

    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("btrim(secret.value_enc) <> ''");
    expect(queries[1]?.text).toContain('JOIN kortix.executor_connection_profiles profile');
    expect(queries[1]?.text).toContain('profile.is_default = true');
    expect(queries[1]?.text).toContain("profile.status = 'active'");
    expect(queries[1]?.text).toContain('JOIN kortix.executor_credentials credential');
    expect(queries[1]?.text).toContain("btrim(credential.value_enc) <> ''");
  });

  test('commits the provider handle and provider-submitted event in one owner-fenced statement', async () => {
    const queries: string[] = [];
    const repository = new PostgresStudioWorkerRepository({
      unsafe: async (text) => {
        queries.push(text);
        return [{ job_id: '11111111-1111-4111-8111-111111111111' }];
      },
    });

    await repository.markSubmitted({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a:claim-1',
      handle: { provider: 'fake', id: 'provider-1', submission_key: 'submission-1' },
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('provider-submitted');
    expect(queries[0]).toContain('INSERT INTO kortix.studio_job_events');
    expect(queries[0]).toContain(
      "attempt.status IN ('submitting', 'submitted', 'polling', 'reconciling')",
    );
    expect(queries[0]).toContain('attempt.submission_key = $7');
    expect(queries[0]).toContain("existing.event_type = 'provider-submitted'");
  });

  test('commits retry scheduling and its durable event in one owner-fenced statement', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresStudioWorkerRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [{ job_id: '11111111-1111-4111-8111-111111111111' }];
      },
    });

    await repository.scheduleRetry({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a:claim-1',
      classification: 'retryable',
      availableAt: new Date('2026-07-15T10:01:00.000Z'),
      message: 'retry later',
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('INSERT INTO kortix.studio_job_events');
    expect(queries[0]?.values).toContain('retry-scheduled');
  });

  test('reschedules polling on the same attempt without clearing the accepted provider handle', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresStudioWorkerRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [{ job_id: '11111111-1111-4111-8111-111111111111' }];
      },
    });

    await repository.scheduleContinuation({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a:claim-1',
      phase: 'polling',
      classification: 'retryable',
      availableAt: new Date('2026-07-15T10:01:00.000Z'),
      code: 'STUDIO_PROVIDER_TIMEOUT',
      message: 'poll transport failed',
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain(
      "provider_handle = CASE WHEN $4 = 'failed' THEN NULL ELSE provider_handle END",
    );
    expect(queries[0]?.values).toContain('polling');
    expect(queries[0]?.values).toContain('retry-scheduled');
  });

  test('commits terminal state and its durable event in one owner-guarded statement', async () => {
    const queries: string[] = [];
    const client = {
      unsafe: async (text: string) => {
        queries.push(text);
        return [{ result: { success: true, outcome: 'failed' } }];
      },
    };
    const repository = new PostgresStudioWorkerRepository(client);

    await repository.markFailed({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a',
      code: 'STUDIO_PROVIDER_REJECTED',
      message: 'provider rejected the job',
      classification: 'terminal',
      now: new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('public.atomic_finalize_studio_job_terminal');
  });

  test('guards every attempt mutation behind the currently owned job row', async () => {
    const queries: string[] = [];
    const client = {
      unsafe: async (text: string) => {
        queries.push(text);
        return [{ job_id: '11111111-1111-4111-8111-111111111111' }];
      },
    };
    const repository = new PostgresStudioWorkerRepository(client);
    const now = new Date('2026-07-15T10:00:00.000Z');

    await repository.markSubmitted({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a',
      handle: { provider: 'fake', id: 'provider-1', submission_key: 'submission-1' },
      now,
    });
    await repository.scheduleRetry({
      jobId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222',
      workerId: 'worker-a',
      classification: 'retryable',
      availableAt: new Date('2026-07-15T10:01:00.000Z'),
      message: 'retry',
      now,
    });
    const mutations = queries.filter((query) =>
      query.includes('UPDATE kortix.studio_job_attempts'),
    );
    expect(mutations).toHaveLength(2);
    for (const mutation of mutations) {
      const ownedRow = mutation.indexOf('WITH owned AS');
      const attemptUpdate = mutation.indexOf('attempt_update AS');
      expect(ownedRow).toBeGreaterThanOrEqual(0);
      expect(attemptUpdate).toBeGreaterThan(ownedRow);
      expect(mutation).toContain('FROM owned');
    }
  });

  test('maintenance uses a parameterized lease row and runs bounded cleanup statements', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const client = {
      unsafe: async (text: string, values: unknown[] = []) => {
        queries.push({ text, values });
        return text.includes('RETURNING owner_id') ? [{ owner_id: 'studio-owner' }] : [];
      },
    };
    const maintenance = new PostgresStudioMaintenanceRepository(client);
    const now = new Date('2026-07-15T10:00:00.000Z');

    expect(
      await maintenance.acquireOrRenewLease({
        lockKey: 'studio-maintenance',
        ownerId: 'studio-owner',
        expiresAt: new Date('2026-07-15T10:01:00.000Z'),
        now,
      }),
    ).toBe(true);
    await maintenance.requeueExpiredJobLeases(now);
    await maintenance.failStuckUnknownOutcomes(now);
    await maintenance.compactProgressEvents(now);
    await maintenance.expireUploads(now);
    await maintenance.reconcileCreditReservations(now);

    expect(queries[0]?.text).toContain('kortix.worker_leader_lease');
    expect(queries[0]?.values).toContain('studio-maintenance');
    expect(queries.map((query) => query.text).join('\n')).toContain(
      'STUDIO_SUBMISSION_OUTCOME_UNKNOWN',
    );
    expect(queries.map((query) => query.text).join('\n')).toContain(
      'j.lease_expires_at <= $1::timestamptz',
    );
    expect(queries.map((query) => query.text).join('\n')).toContain('studio_asset_uploads');
    expect(queries.map((query) => query.text).join('\n')).toContain('studio_credit_reservations');
  });

  test('progress event compaction preserves each job cursor high-water mark', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const maintenance = new PostgresStudioMaintenanceRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [];
      },
    });

    await maintenance.compactProgressEvents(new Date('2026-07-15T10:00:00.000Z'));

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('newer.job_id = event.job_id');
    expect(queries[0]?.text).toContain('newer.cursor > event.cursor');
  });

  test('unknown outcome maintenance waits for the attempt recovery deadline', async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const maintenance = new PostgresStudioMaintenanceRepository({
      unsafe: async (text, values = []) => {
        queries.push({ text, values });
        return [];
      },
    });

    await maintenance.failStuckUnknownOutcomes(new Date('2026-07-15T10:00:00.000Z'));

    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain("a.started_at <= $1::timestamptz - interval '15 minutes'");
  });
});
