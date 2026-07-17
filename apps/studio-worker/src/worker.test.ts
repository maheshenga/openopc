import { describe, expect, test } from 'bun:test';
import type { StudioProviderAdapter, StudioProviderHandle } from '@kortix/studio-runtime';
import {
  InMemoryStudioObjectStore,
  StudioProviderCallError,
  studioStagingManifestKey,
  studioSubmissionKeyHash,
} from '@kortix/studio-runtime';
import { createMemoryStudioWorkerRepository } from './memory-repository';
import { StudioResultStager } from './result-stager';
import {
  type StudioAssetWriter,
  type StudioSubmissionAuthorization,
  StudioWorker,
  createObjectStoreAssetWriter,
  redactStudioDiagnostic,
} from './worker';

const NOW = new Date('2026-07-15T10:00:00.000Z');

function imageInput(prompt = 'A professional product photograph') {
  return {
    capability: 'image.generate' as const,
    image: {
      prompt,
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    },
  };
}

function provider(overrides: Partial<StudioProviderAdapter> = {}): StudioProviderAdapter {
  return {
    id: 'fake',
    submit: async (ctx) => ({
      kind: 'async',
      handle: {
        provider: 'fake',
        id: `handle-${ctx.submissionKey}`,
        submission_key: ctx.submissionKey,
      },
    }),
    poll: async () => ({ status: 'succeeded', progress: 1 }),
    cancel: async () => {},
    reconcile: async () => 'unknown',
    fetchResult: async () => ({
      assets: [
        {
          kind: 'image',
          filename: 'result.png',
          mime_type: 'image/png',
          size_bytes: 4,
          replayable_within_attempt: true,
          async openBody() {
            return new Blob([new Uint8Array([137, 80, 78, 71])]).stream();
          },
        },
      ],
      usage: { actual_credits: 1 },
    }),
    ...overrides,
  };
}

const allow: StudioSubmissionAuthorization = {
  revalidate: async () => ({ authorized: true }),
};

function makeWorker(input: {
  workerId: string;
  repository: ReturnType<typeof createMemoryStudioWorkerRepository>;
  adapter?: StudioProviderAdapter | null;
  authorization?: StudioSubmissionAuthorization;
  leaseMs?: number;
  assets?: StudioAssetWriter;
  now?: () => Date;
  credentialResolver?: { resolve: () => Promise<null> };
  stager?: StudioResultStager;
}) {
  const objectStore = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
  return {
    worker: new StudioWorker({
      config: {
        workerId: input.workerId,
        leaseMs: input.leaseMs ?? 30_000,
        pollIntervalMs: 0,
        unknownOutcomeTimeoutMs: 15 * 60_000,
      },
      repository: input.repository,
      providers: {
        get: () => (input.adapter === null ? null : (input.adapter ?? provider())),
        resolve: async () => (input.adapter === null ? null : (input.adapter ?? provider())),
      },
      credentialResolver: input.credentialResolver ?? { resolve: async () => null },
      referenceAssets: { resolve: async () => [] },
      authorization: input.authorization ?? allow,
      assets: input.assets ?? createObjectStoreAssetWriter(objectStore),
      stager: input.stager,
      now: input.now ?? (() => NOW),
      random: () => 0,
    }),
  };
}

describe('StudioWorker', () => {
  test('binds the asset writer to the store namespace without a bucket argument', () => {
    expect(createObjectStoreAssetWriter.length).toBe(1);
  });

  test('redacts credential-shaped values from durable diagnostics', () => {
    const message = redactStudioDiagnostic(
      'request failed Authorization: Bearer sk-live-secret api_key=another-secret {"access_token":"json-secret"}',
    );

    expect(message).not.toContain('sk-live-secret');
    expect(message).not.toContain('another-secret');
    expect(message).not.toContain('json-secret');
    expect(message).toContain('[REDACTED]');
  });

  test('redacts provider diagnostics containing basic auth, passwords, tokens, and query keys', () => {
    const message = redactStudioDiagnostic(
      'Authorization: Basic dXNlcjpzZWNyZXQ= password=pwd-secret token=tok-secret https://provider.example/render?key=query-secret&safe=1',
    );

    expect(message).not.toContain('dXNlcjpzZWNyZXQ=');
    expect(message).not.toContain('pwd-secret');
    expect(message).not.toContain('tok-secret');
    expect(message).not.toContain('query-secret');
    expect(message).toContain('[REDACTED]');
  });

  test('redacts complete provider output and signed storage URLs', () => {
    const signedStorageUrl = [
      'https://bucket.example.invalid/generated.png',
      [
        'X-Amz-Credential=test-only',
        'X-Amz-Signature=test-only',
        'X-Amz-Security-Token=test-only',
      ].join('&'),
    ].join('?');
    const message = redactStudioDiagnostic(
      `provider output https://provider.example.invalid/output.png storage ${signedStorageUrl}`,
    );

    expect(message).not.toContain('provider.example.invalid');
    expect(message).not.toContain('bucket.example.invalid');
    expect(message).not.toContain('X-Amz-');
    expect(message).toContain('[REDACTED_URL]');
  });

  test('concurrent workers claim each job only once', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const first = repository.seedJob({ input: imageInput('first') });
    const second = repository.seedJob({ input: imageInput('second') });
    const submissions: string[] = [];
    const adapter = provider({
      submit: async (ctx, input) => {
        submissions.push(input.image.prompt);
        await Promise.resolve();
        return {
          kind: 'async',
          handle: {
            provider: 'fake',
            id: `handle-${ctx.submissionKey}`,
            submission_key: ctx.submissionKey,
          },
        };
      },
    });
    const a = makeWorker({ workerId: 'worker-a', repository, adapter }).worker;
    const b = makeWorker({ workerId: 'worker-b', repository, adapter }).worker;

    await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);

    expect(submissions.sort()).toEqual(['first', 'second']);
    expect(repository.getJob(first.jobId)?.status).toBe('succeeded');
    expect(repository.getJob(second.jobId)?.status).toBe('succeeded');
  });

  test('uses a fresh per-claim fencing owner even when the configured worker id is reused', async () => {
    const repository = createMemoryStudioWorkerRepository();
    repository.seedJob({ input: imageInput('first') });
    repository.seedJob({ input: imageInput('second') });
    const claimOwners: string[] = [];
    const claimNextJob = repository.claimNextJob.bind(repository);
    repository.claimNextJob = async (input) => {
      claimOwners.push(input.workerId);
      return claimNextJob(input);
    };
    const worker = makeWorker({ workerId: 'worker-a', repository }).worker;

    await worker.runOnce();
    await worker.runOnce();

    expect(claimOwners).toHaveLength(2);
    expect(claimOwners[0]).toStartWith('worker-a:');
    expect(claimOwners[1]).toStartWith('worker-a:');
    expect(claimOwners[0]).not.toBe(claimOwners[1]);
  });

  test('claim lease expiry permits recovery and rejects API claimers', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const first = await repository.claimNextJob({
      processRole: 'studio-worker',
      workerId: 'worker-a',
      now: NOW,
      leaseMs: 1_000,
    });
    expect(first?.jobId).toBe(job.jobId);

    expect(
      await repository.claimNextJob({
        processRole: 'studio-worker',
        workerId: 'worker-b',
        now: new Date(NOW.getTime() + 999),
        leaseMs: 1_000,
      }),
    ).toBeNull();

    expect(
      (
        await repository.claimNextJob({
          processRole: 'studio-worker',
          workerId: 'worker-b',
          now: new Date(NOW.getTime() + 1_001),
          leaseMs: 1_000,
        })
      )?.jobId,
    ).toBe(job.jobId);

    await expect(
      repository.claimNextJob({
        processRole: 'api' as 'studio-worker',
        workerId: 'api-pod',
        now: NOW,
        leaseMs: 1_000,
      }),
    ).rejects.toThrow('Studio jobs may only be claimed by the studio-worker process');
  });

  test('commits a unique submission key before provider I/O', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let submittedKey = '';
    const adapter = provider({
      submit: async (ctx) => {
        submittedKey = ctx.submissionKey;
        const attempt = repository.getAttempts(job.jobId)[0];
        expect(attempt?.submissionKey).toBe(ctx.submissionKey);
        expect(attempt?.status).toBe('submitting');
        return {
          kind: 'async',
          handle: {
            provider: 'fake',
            id: 'accepted',
            submission_key: ctx.submissionKey,
          },
        };
      },
    });

    await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(submittedKey).toMatch(new RegExp(`^${job.jobId}:1:`));
  });

  test('fails closed on completed submissions until result finalization is enabled', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let reconcileCalls = 0;
    const adapter = provider({
      submit: async (ctx) => ({
        kind: 'completed',
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: { assets: [], usage: {} },
      }),
      reconcile: async () => {
        reconcileCalls += 1;
        return 'not-found';
      },
    });

    const result = await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'failed' });
    expect(reconcileCalls).toBe(0);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_PROVIDER_REJECTED');
  });

  test('stages a completed submission, records verified cost, and finalizes without polling', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
      reservedCredits: 2.25,
    });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    let polls = 0;
    const adapter = provider({
      submit: async (ctx) => ({
        kind: 'completed',
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: {
          assets: [
            {
              kind: 'image',
              filename: 'completed.png',
              mime_type: 'image/png',
              size_bytes: png.byteLength,
              replayable_within_attempt: true,
              openBody: async () => new Blob([png]).stream(),
            },
          ],
          usage: { ignored_provider_cost: 99 },
        },
      }),
      poll: async () => {
        polls += 1;
        return { status: 'succeeded' };
      },
    });
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      stager: new StudioResultStager(store),
    });

    expect(await worker.runOnce()).toEqual({
      kind: 'processed',
      jobId: job.jobId,
      status: 'succeeded',
    });
    expect(polls).toBe(0);
    expect(repository.getAttempts(job.jobId)[0]).toMatchObject({
      submissionKind: 'completed',
      upstreamUsage: { output_count: 1 },
      upstreamCostCredits: 1,
      costOutcome: 'succeeded',
      status: 'succeeded',
    });
    expect(repository.getJob(job.jobId)?.actualCredits).toBe(1.25);
  });

  test('final charge includes verified cost from an earlier failed attempt plus current output markup', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      attemptCount: 1,
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 4,
        markup_credits: 0.25,
      },
      reservedCredits: 4.25,
    });
    repository.seedAttempt(job.jobId, {
      attemptNumber: 1,
      status: 'failed',
      endedAt: NOW,
      costOutcome: 'failed',
      costRecordedAt: NOW,
      upstreamUsage: { output_count: 1 },
      upstreamCostCredits: 0.75,
    });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const adapter = provider({
      submit: async (ctx) => ({
        kind: 'completed',
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: {
          assets: [
            {
              kind: 'image',
              filename: 'retry.png',
              mime_type: 'image/png',
              size_bytes: png.byteLength,
              replayable_within_attempt: true,
              openBody: async () => new Blob([png]).stream(),
            },
          ],
        },
      }),
    });
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      stager: new StudioResultStager(store),
    });

    expect(await worker.runOnce()).toMatchObject({ status: 'succeeded' });
    expect(repository.getJob(job.jobId)?.actualCredits).toBe(2);
  });

  test('a terminal durable manifest failure stops before provider reconciliation', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      status: 'running',
      attemptCount: 1,
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
    });
    const attempt = repository.seedAttempt(job.jobId, { status: 'reconciling' });
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const manifestKey = studioStagingManifestKey({
      accountId: job.accountId,
      projectId: job.projectId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      submissionKeyHash: studioSubmissionKeyHash(attempt.submissionKey),
    });
    const invalid = new TextEncoder().encode('{}');
    await store.putObject({
      key: manifestKey,
      body: new Blob([invalid]).stream(),
      content_type: 'application/json',
      size_bytes: invalid.byteLength,
      checksum_sha256: new Bun.CryptoHasher('sha256').update(invalid).digest('hex'),
      metadata: { kind: 'studio-staging-manifest' },
    });
    let reconciliations = 0;
    const adapter = provider({
      reconcile: async () => {
        reconciliations += 1;
        return 'unknown';
      },
    });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      stager: new StudioResultStager(store),
    });

    expect(await worker.runOnce()).toMatchObject({ status: 'failed' });
    expect(reconciliations).toBe(0);
  });

  test('an unresolved completed attempt without a reconciliation adapter remains operator-recoverable', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ status: 'running', attemptCount: 1 });
    repository.seedAttempt(job.jobId, { status: 'reconciling' });
    const { worker } = makeWorker({ workerId: 'worker-a', repository, adapter: null });

    expect(await worker.runOnce()).toMatchObject({ status: 'running' });
    expect(repository.getAttempts(job.jobId).at(-1)?.status).toBe('reconciling');
    expect(repository.getEvents(job.jobId).some((event) => event.type === 'failed')).toBe(false);
  });

  test('records trusted completed usage before terminal staging failure', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
    });
    const invalid = new TextEncoder().encode('not-an-image');
    const adapter = provider({
      submit: async (ctx) => ({
        kind: 'completed',
        provider: 'fake',
        submission_key: ctx.submissionKey,
        result: {
          assets: [
            {
              kind: 'image',
              filename: 'invalid.png',
              mime_type: 'image/png',
              size_bytes: invalid.byteLength,
              replayable_within_attempt: true,
              openBody: async () => new Blob([invalid]).stream(),
            },
          ],
        },
      }),
    });
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      stager: new StudioResultStager(store),
    });

    expect(await worker.runOnce()).toMatchObject({ status: 'failed' });
    expect(repository.getAttempts(job.jobId)[0]).toMatchObject({
      upstreamCostCredits: 1,
      costOutcome: 'failed',
      status: 'failed',
    });
  });

  test('reuses an immutable unknown attempt cost when a durable manifest proves success', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      status: 'running',
      attemptCount: 1,
      pricingSnapshot: {
        pricing_catalog_id: '77777777-7777-4777-8777-777777777777',
        version: 1,
        provider: 'fake',
        model: 'fake-image-v1',
        unit: 'image',
        rate_credits: 1,
        max_provider_credits: 2,
        markup_credits: 0.25,
      },
    });
    const attempt = repository.seedAttempt(job.jobId, {
      status: 'reconciling',
      submissionKind: 'completed',
      costOutcome: 'unknown',
      costRecordedAt: NOW,
      upstreamUsage: { output_count: 1 },
      upstreamCostCredits: 1,
    });
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const stager = new StudioResultStager(store);
    await stager.stage({
      accountId: job.accountId,
      projectId: job.projectId,
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      submissionKey: attempt.submissionKey,
      providerConfigId: job.providerConfigId,
      providerConfigVersion: attempt.providerConfigVersion!,
      pricingCatalogId: job.pricingSnapshot!.pricing_catalog_id,
      pricingVersion: job.pricingSnapshot!.version,
      assets: [
        {
          kind: 'image',
          filename: 'recovered.png',
          mime_type: 'image/png',
          size_bytes: png.byteLength,
          replayable_within_attempt: true,
          openBody: async () => new Blob([png]).stream(),
        },
      ],
      usage: { output_count: 1 },
    });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter: null,
      stager,
    });

    expect(await worker.runOnce()).toMatchObject({ status: 'succeeded' });
    expect(repository.getAttempts(job.jobId)[0]?.costOutcome).toBe('unknown');
    expect(repository.getJob(job.jobId)?.actualCredits).toBe(1.25);
  });

  test('releases the claim when the provider-config prepare fence loses a race', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    repository.prepareAttempt = async () => null;
    let submitCalls = 0;
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter: provider({
        submit: async () => {
          submitCalls += 1;
          throw new Error('must not submit after losing the prepare fence');
        },
      }),
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'error', code: 'STUDIO_ATTEMPT_CONFLICT' });
    expect(submitCalls).toBe(0);
    expect(repository.getJob(job.jobId)?.leaseOwner).toBeNull();
  });

  test('heartbeats the owned row lease during slow provider I/O', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const adapter = provider({
      submit: async (ctx) => {
        await Bun.sleep(35);
        return {
          kind: 'async',
          handle: { provider: 'fake', id: 'slow', submission_key: ctx.submissionKey },
        };
      },
    });

    await makeWorker({ workerId: 'worker-a', repository, adapter, leaseMs: 15 }).worker.runOnce();

    expect(repository.getHeartbeatCount(job.jobId)).toBeGreaterThanOrEqual(2);
  });

  test('reconciles an unknown submission outcome instead of blindly resubmitting', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const reconciled: string[] = [];
    let submitCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new StudioProviderCallError('unknown_outcome', 'connection closed after submit');
      },
      reconcile: async (_ctx, submissionKey) => {
        reconciled.push(submissionKey);
        return { provider: 'fake', id: 'recovered', submission_key: submissionKey };
      },
    });

    await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(submitCalls).toBe(1);
    expect(reconciled).toEqual([repository.getAttempts(job.jobId)[0]?.submissionKey]);
    expect(repository.getJob(job.jobId)?.status).toBe('succeeded');
  });

  test('reconciles after provider acceptance when handle persistence fails', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const persistedMarkSubmitted = repository.markSubmitted.bind(repository);
    let failPersistence = true;
    repository.markSubmitted = async (input) => {
      if (failPersistence) throw new Error('database response lost after provider acceptance');
      return persistedMarkSubmitted(input);
    };
    let submitCalls = 0;
    const reconciled: string[] = [];
    const adapter = provider({
      submit: async (ctx) => {
        submitCalls += 1;
        return {
          kind: 'async',
          handle: { provider: 'fake', id: 'accepted', submission_key: ctx.submissionKey },
        };
      },
      reconcile: async (_ctx, submissionKey) => {
        reconciled.push(submissionKey);
        return { provider: 'fake', id: 'accepted', submission_key: submissionKey };
      },
    });
    let clock = NOW;
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      now: () => clock,
    });

    const first = await worker.runOnce();
    failPersistence = false;
    clock = new Date(NOW.getTime() + 5_001);
    const second = await worker.runOnce();

    expect(first).toMatchObject({ kind: 'error', jobId: job.jobId });
    expect(second).toMatchObject({ kind: 'processed', status: 'succeeded' });
    expect(submitCalls).toBe(1);
    expect(reconciled).toEqual([repository.getAttempts(job.jobId)[0]?.submissionKey]);
  });

  test('retries polling the same accepted provider handle without creating another submission', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const handle: StudioProviderHandle = {
      provider: 'fake',
      id: 'accepted-provider-job',
      submission_key: 'durable-submission-key',
    };
    const job = repository.seedJob({
      status: 'running',
      attemptCount: 1,
      providerHandle: handle,
    });
    repository.seedAttempt(job.jobId, {
      status: 'polling',
      submissionKey: handle.submission_key,
      providerHandle: handle,
    });
    let submitCalls = 0;
    let pollCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new Error('an accepted provider job must not be submitted again');
      },
      poll: async () => {
        pollCalls += 1;
        if (pollCalls === 1) {
          throw new StudioProviderCallError('retryable', 'temporary poll transport failure');
        }
        return { status: 'succeeded', progress: 1 };
      },
    });
    const worker = makeWorker({ workerId: 'worker-a', repository, adapter }).worker;

    const first = await worker.runOnce();
    const second = await worker.runOnce();

    expect(first).toMatchObject({ kind: 'processed', status: 'running' });
    expect(second).toMatchObject({ kind: 'processed', status: 'succeeded' });
    expect(submitCalls).toBe(0);
    expect(pollCalls).toBe(2);
    expect(repository.getAttempts(job.jobId)).toHaveLength(1);
  });

  test('retries reconciliation without resubmitting an unresolved provider outcome', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ status: 'running', attemptCount: 1 });
    const attempt = repository.seedAttempt(job.jobId, {
      status: 'reconciling',
      submissionKey: 'durable-submission-key',
    });
    let submitCalls = 0;
    let reconcileCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new Error('an unresolved submission must not be submitted again');
      },
      reconcile: async (_ctx, submissionKey) => {
        reconcileCalls += 1;
        if (reconcileCalls === 1) {
          throw new StudioProviderCallError('retryable', 'temporary reconciliation failure');
        }
        return { provider: 'fake', id: 'recovered', submission_key: submissionKey };
      },
    });
    const worker = makeWorker({ workerId: 'worker-a', repository, adapter }).worker;

    const first = await worker.runOnce();
    const second = await worker.runOnce();

    expect(first).toMatchObject({ kind: 'processed', status: 'running' });
    expect(second).toMatchObject({ kind: 'processed', status: 'succeeded' });
    expect(submitCalls).toBe(0);
    expect(reconcileCalls).toBe(2);
    expect(repository.getAttempts(job.jobId)).toEqual([
      expect.objectContaining({ attemptId: attempt.attemptId, status: 'succeeded' }),
    ]);
  });

  test('quarantines a reconciled handle whose submission key differs from the durable attempt', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ status: 'running', attemptCount: 1 });
    const attempt = repository.seedAttempt(job.jobId, {
      status: 'reconciling',
      submissionKey: 'durable-submission-key',
    });
    let pollCalls = 0;
    const adapter = provider({
      reconcile: async () => ({
        provider: 'fake',
        id: 'wrong-provider-job',
        submission_key: 'different-submission-key',
      }),
      poll: async () => {
        pollCalls += 1;
        return { status: 'succeeded', progress: 1 };
      },
    });
    const worker = makeWorker({ workerId: 'worker-a', repository, adapter }).worker;

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', status: 'running' });
    expect(pollCalls).toBe(0);
    expect(repository.getAttempts(job.jobId)).toEqual([
      expect.objectContaining({
        attemptId: attempt.attemptId,
        status: 'reconciling',
        providerHandle: null,
      }),
    ]);
    expect(repository.getJob(job.jobId)?.providerHandle).toBeNull();
  });

  test('keeps local finalization faults resumable without releasing the reservation', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      assets: {
        persist: async () => {
          throw new Error('object store temporarily unavailable');
        },
      },
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'error', jobId: job.jobId });
    expect(repository.getJob(job.jobId)?.status).toBe('running');
  });

  test('rejects non-replayable provider assets before opening their body', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let openBodyCalls = 0;
    const adapter = provider({
      fetchResult: async () => ({
        assets: [
          {
            kind: 'image',
            filename: 'single-use.png',
            mime_type: 'image/png',
            size_bytes: 4,
            replayable_within_attempt: false,
            async openBody() {
              openBodyCalls += 1;
              return new Blob([new Uint8Array([137, 80, 78, 71])]).stream();
            },
          },
        ],
        usage: { actual_credits: 1 },
      }),
    });

    const result = await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'failed' });
    expect(openBodyCalls).toBe(0);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_ASSET_INVALID');
  });

  test('fails terminally when a replayable provider asset declares the wrong size', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let openBodyCalls = 0;
    const adapter = provider({
      fetchResult: async () => ({
        assets: [
          {
            kind: 'image',
            filename: 'wrong-size.png',
            mime_type: 'image/png',
            size_bytes: 5,
            replayable_within_attempt: true,
            async openBody() {
              openBodyCalls += 1;
              return new Blob([new Uint8Array([137, 80, 78, 71])]).stream();
            },
          },
        ],
        usage: { actual_credits: 1 },
      }),
    });

    const result = await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'failed' });
    expect(openBodyCalls).toBe(1);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_ASSET_INVALID');
  });

  test('fails terminally when a replayable provider asset returns different bytes', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let openBodyCalls = 0;
    const adapter = provider({
      fetchResult: async () => ({
        assets: [
          {
            kind: 'image',
            filename: 'unstable.png',
            mime_type: 'image/png',
            size_bytes: 4,
            replayable_within_attempt: true,
            async openBody() {
              openBodyCalls += 1;
              const lastByte = openBodyCalls === 1 ? 71 : 72;
              return new Blob([new Uint8Array([137, 80, 78, lastByte])]).stream();
            },
          },
        ],
        usage: { actual_credits: 1 },
      }),
    });

    const result = await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'failed' });
    expect(openBodyCalls).toBe(2);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_ASSET_INVALID');
  });

  test('fails terminally when a replayable provider asset changes size between reads', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let openBodyCalls = 0;
    const adapter = provider({
      fetchResult: async () => ({
        assets: [
          {
            kind: 'image',
            filename: 'unstable-size.png',
            mime_type: 'image/png',
            size_bytes: 4,
            replayable_within_attempt: true,
            async openBody() {
              openBodyCalls += 1;
              const bytes =
                openBodyCalls === 1
                  ? new Uint8Array([137, 80, 78, 71])
                  : new Uint8Array([137, 80, 78]);
              return new Blob([bytes]).stream();
            },
          },
        ],
        usage: { actual_credits: 1 },
      }),
    });

    const result = await makeWorker({ workerId: 'worker-a', repository, adapter }).worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'failed' });
    expect(openBodyCalls).toBe(2);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_ASSET_INVALID');
  });

  test('fails terminal provider rejections without resubmitting', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let submitCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new StudioProviderCallError('terminal', 'provider rejected the request');
      },
    });
    const { worker } = makeWorker({ workerId: 'worker-a', repository, adapter });

    await worker.runOnce();
    await worker.runOnce();

    expect(submitCalls).toBe(1);
    expect(repository.getJob(job.jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'STUDIO_PROVIDER_REJECTED',
    });
  });

  test('calculates Retry-After from the time provider I/O completes', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let now = NOW;
    const adapter = provider({
      submit: async () => {
        now = new Date(NOW.getTime() + 60_000);
        throw new StudioProviderCallError('rate_limited', 'retry later', 10_000);
      },
    });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      now: () => now,
    });

    await worker.runOnce();

    expect(repository.getJob(job.jobId)?.availableAt.toISOString()).toBe(
      new Date(NOW.getTime() + 70_000).toISOString(),
    );
  });

  test('stops retrying after three total attempts', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let submitCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new StudioProviderCallError('retryable', 'temporary provider failure');
      },
    });
    const worker = makeWorker({ workerId: 'worker-a', repository, adapter }).worker;

    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();
    await worker.runOnce();

    expect(submitCalls).toBe(3);
    expect(repository.getAttempts(job.jobId)).toHaveLength(3);
    expect(repository.getJob(job.jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'STUDIO_PROVIDER_TIMEOUT',
    });
  });

  test('cancellation before submission releases the reservation without provider I/O', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ cancellationRequestedAt: NOW });
    let submitCalls = 0;
    const adapter = provider({
      submit: async () => {
        submitCalls += 1;
        throw new Error('must not submit');
      },
    });
    const { worker } = makeWorker({ workerId: 'worker-a', repository, adapter });

    await worker.runOnce();

    expect(submitCalls).toBe(0);
    expect(repository.getJob(job.jobId)?.status).toBe('cancelled');
  });

  test('cancellation after submission asks the adapter to cancel and remains definitive locally', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const handle: StudioProviderHandle = {
      provider: 'fake',
      id: 'provider-job',
      submission_key: 'submitted-key',
    };
    const job = repository.seedJob({
      status: 'running',
      attemptCount: 1,
      providerHandle: handle,
      cancellationRequestedAt: NOW,
    });
    repository.seedAttempt(job.jobId, {
      submissionKey: handle.submission_key,
      providerHandle: handle,
      status: 'submitted',
    });
    const cancellations: StudioProviderHandle[] = [];
    const adapter = provider({
      cancel: async (_ctx, value) => {
        cancellations.push(value);
      },
    });
    const { worker } = makeWorker({ workerId: 'worker-a', repository, adapter });

    await worker.runOnce();

    expect(cancellations).toEqual([handle]);
    expect(repository.getJob(job.jobId)?.status).toBe('cancelled');
  });

  test('a fresh cancellation after provider polling wins before result fetch or settlement', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const handle: StudioProviderHandle = {
      provider: 'fake',
      id: 'provider-job',
      submission_key: 'submitted-key',
    };
    const job = repository.seedJob({
      status: 'running',
      attemptCount: 1,
      providerHandle: handle,
    });
    repository.seedAttempt(job.jobId, {
      submissionKey: handle.submission_key,
      providerHandle: handle,
      status: 'polling',
    });
    let fetchCalls = 0;
    const adapter = provider({
      poll: async () => {
        repository.requestCancellation(job.jobId, new Date(NOW.getTime() + 1_000));
        return { status: 'succeeded', progress: 1 };
      },
      fetchResult: async () => {
        fetchCalls += 1;
        throw new Error('must not fetch after cancellation');
      },
    });
    const { worker } = makeWorker({ workerId: 'worker-a', repository, adapter });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'cancelled' });
    expect(fetchCalls).toBe(0);
    expect(repository.getAssets(job.jobId)).toEqual([]);
  });

  test('a cancellation during result fetch wins before output objects become visible', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    let persistCalls = 0;
    const adapter = provider({
      fetchResult: async () => {
        repository.requestCancellation(job.jobId, new Date(NOW.getTime() + 1_000));
        return {
          assets: [
            {
              kind: 'image',
              filename: 'late-result.png',
              mime_type: 'image/png',
              size_bytes: 4,
              replayable_within_attempt: true,
              async openBody() {
                return new Blob([new Uint8Array([137, 80, 78, 71])]).stream();
              },
            },
          ],
          usage: { actual_credits: 1 },
        };
      },
    });
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter,
      assets: {
        persist: async () => {
          persistCalls += 1;
          throw new Error('must not persist after cancellation');
        },
      },
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'cancelled' });
    expect(persistCalls).toBe(0);
    expect(repository.getAssets(job.jobId)).toEqual([]);
  });

  test('the atomic finalization CAS hides objects uploaded after cancellation wins', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      assets: {
        persist: async () => {
          repository.requestCancellation(job.jobId, new Date(NOW.getTime() + 1_000));
          return [
            {
              kind: 'image',
              mimeType: 'image/png',
              bucket: 'studio-test',
              objectKey: `jobs/${job.jobId}/late-result.png`,
              checksumSha256: 'abc123',
              sizeBytes: 4,
              filename: 'late-result.png',
            },
          ];
        },
      },
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'cancelled' });
    expect(repository.getAssets(job.jobId)).toEqual([]);
    expect(repository.getEvents(job.jobId).map((event) => event.type)).not.toContain('succeeded');
  });

  test('success atomically creates assets, settles billing, and emits durable terminal events', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ reservedCredits: 2 });
    const { worker } = makeWorker({ workerId: 'worker-a', repository });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'succeeded' });
    expect(repository.getAssets(job.jobId)).toHaveLength(1);
    expect(repository.getJob(job.jobId)?.actualCredits).toBe(1);
    expect(repository.getEvents(job.jobId).map((event) => event.type)).toEqual([
      'queued',
      'claimed',
      'provider-submitted',
      'asset-created',
      'billing-settled',
      'succeeded',
    ]);
  });

  test('reloads a disabled provider configuration before any new submission', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob();
    const loadConfig = repository.loadProviderConfigForSubmission.bind(repository);
    repository.loadProviderConfigForSubmission = async (input) => {
      const config = await loadConfig(input);
      return config ? { ...config, enabled: false } : null;
    };
    let submitCalls = 0;
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      adapter: provider({
        submit: async () => {
          submitCalls += 1;
          throw new Error('must not submit through a disabled provider configuration');
        },
      }),
    });

    const result = await worker.runOnce();

    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'cancelled' });
    expect(submitCalls).toBe(0);
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_PROVIDER_UNAVAILABLE');
  });

  test.each([
    ['token', 'STUDIO_TOKEN_REVOKED'],
    ['Agent grant', 'STUDIO_AGENT_GRANT_REVOKED'],
  ])('a revoked %s before submission cancels safely', async (_label, code) => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ actingTokenId: crypto.randomUUID(), actorType: 'agent' });
    let submitCalls = 0;
    const authorization: StudioSubmissionAuthorization = {
      revalidate: async () => ({ authorized: false, code, message: 'revoked before submission' }),
    };
    const { worker } = makeWorker({
      workerId: 'worker-a',
      repository,
      authorization,
      adapter: provider({
        submit: async () => {
          submitCalls += 1;
          throw new Error('must not submit');
        },
      }),
    });

    await worker.runOnce();

    expect(submitCalls).toBe(0);
    expect(repository.getJob(job.jobId)).toMatchObject({
      status: 'cancelled',
      errorCode: 'STUDIO_PERMISSION_DENIED',
    });
  });

  test('does not invoke the provider when credential resolution fails after authorization', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' } });
    let providerCalls = 0;
    const worker = new StudioWorker({
      config: {
        workerId: 'worker-a',
        leaseMs: 30_000,
        pollIntervalMs: 0,
        unknownOutcomeTimeoutMs: 15 * 60_000,
      },
      repository,
      providers: {
        get: () => {
          providerCalls += 1;
          return provider();
        },
      },
      credentialResolver: {
        resolve: async () => {
          throw new Error('cannot decrypt credential');
        },
      },
      referenceAssets: { resolve: async () => [] },
      authorization: allow,
      assets: createObjectStoreAssetWriter(new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true })),
      now: () => NOW,
    } as never);

    const result = await worker.runOnce();

    expect(providerCalls).toBe(0);
    expect(result).toMatchObject({ kind: 'processed', jobId: job.jobId, status: 'cancelled' });
    expect(repository.getJob(job.jobId)?.errorCode).toBe('STUDIO_PROVIDER_CREDENTIAL_UNAVAILABLE');
  });
});
