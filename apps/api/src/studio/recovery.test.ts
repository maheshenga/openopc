import { describe, expect, test } from 'bun:test';
import { StudioRecoveryResponseSchema } from '@kortix/api-contract';
import {
  InMemoryStudioObjectStore,
  type StudioObjectMetadata,
  StudioStorageUnavailableError,
} from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { createStudioProjectRoutes } from './index';
import {
  StudioRecoveryServiceError,
  StudioRecoveryService,
  type StudioRecoveryLockedContext,
  type StudioRecoveryPreparedInput,
  type StudioRecoveryRepository,
  type StudioRecoveryRepositoryInput,
} from './recovery';
import { createMemoryStudioRepository } from './repositories/memory';

const ACCOUNT_ID = '81000000-0000-4000-a000-000000000001';
const PROJECT_ID = '82000000-0000-4000-a000-000000000001';
const USER_ID = '83000000-0000-4000-a000-000000000001';
const JOB_ID = '84000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '85000000-0000-4000-a000-000000000001';
const RECOVERY_ID = '86000000-0000-4000-a000-000000000001';
const NOW = new Date('2026-07-17T08:00:00.000Z');

const lockedContext: StudioRecoveryLockedContext = {
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  job_id: JOB_ID,
  attempt_id: ATTEMPT_ID,
  job_status: 'running',
  attempt_status: 'reconciling',
  reservation_status: 'active',
  reservation_created_at: '2026-07-16T08:00:00.000Z',
  reservation_expires_at: '2026-07-18T08:00:00.000Z',
  job_available_at: '2026-07-18T08:00:00.000Z',
  cancellation_requested_at: null,
  lease_owner: null,
  lease_expires_at: null,
  submission_key: 'durable-submission-key',
  provider_request_id: 'provider-request-1',
  provider_config_id: '87000000-0000-4000-a000-000000000001',
  provider_config_version: 'provider-version-1',
  attempt_provider_config_version: 'provider-version-1',
  pricing_catalog_id: '88000000-0000-4000-a000-000000000001',
  pricing_version: 3,
  pricing_snapshot: {
    pricing_catalog_id: '88000000-0000-4000-a000-000000000001',
    version: 3,
    provider: 'openai-compatible',
    model: 'gpt-image-1',
    unit: 'image',
    rate_credits: 2,
    max_provider_credits: 8,
    markup_credits: 0.25,
  },
  staging_manifest_key: null,
  staging_manifest_checksum: null,
  current_attempt_usage: {},
  current_attempt_cost_credits: null,
  current_attempt_cost_recorded_at: null,
  verified_attempt_cost_total: 1.5,
};

class RecordingRecoveryRepository implements StudioRecoveryRepository {
  readonly calls: StudioRecoveryRepositoryInput[] = [];
  readonly prepared: StudioRecoveryPreparedInput[] = [];
  commits = 0;

  constructor(
    private readonly response: ReturnType<typeof StudioRecoveryResponseSchema.parse>,
    private readonly context: StudioRecoveryLockedContext = lockedContext,
  ) {}

  async recoverLocked(
    input: StudioRecoveryRepositoryInput,
    prepare: (context: StudioRecoveryLockedContext) => Promise<StudioRecoveryPreparedInput>,
  ) {
    this.calls.push(input);
    this.prepared.push(await prepare(this.context));
    this.commits += 1;
    return this.response;
  }
}

function validRouteRecoveryRequest() {
  return {
    decision: 'confirm_not_created' as const,
    idempotency_key: 'operator-recovery-key-0001',
    reason: 'Provider confirms no upstream request was created.',
    evidence: { provider_request_id: 'provider-request-1' },
  };
}

function recoveryRouteApp(recoveryService: { recover(input: unknown): Promise<unknown> }) {
  const app = new Hono();
  app.route(
    '/v1/projects',
    createStudioProjectRoutes({
      repository: createMemoryStudioRepository(),
      loadProjectForUser: async () => ({
        row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
        userId: USER_ID,
      }),
      assertProjectCapability: async () => {},
      assertAccountCapability: async () => {},
      recoveryService: recoveryService as NonNullable<
        Parameters<typeof createStudioProjectRoutes>[0]
      >['recoveryService'],
      estimateSigningSecret: 'recovery-route-test-secret',
    }),
  );
  return app;
}

describe('Studio recovery route', () => {
  test('mounts the operator route with both permissions and normal-user attribution', async () => {
    const projectActions: string[] = [];
    const accountActions: string[] = [];
    const calls: unknown[] = [];
    const response = StudioRecoveryResponseSchema.parse({
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'confirm_not_created',
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'released',
      hold_expires_at: null,
    });
    const deps = {
      repository: createMemoryStudioRepository(),
      loadProjectForUser: async () => ({
        row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
        userId: USER_ID,
      }),
      assertProjectCapability: async (
        _context: unknown,
        _userId: string,
        _accountId: string,
        _projectId: string,
        action: string,
      ) => {
        projectActions.push(action);
      },
      assertAccountCapability: async (
        _context: unknown,
        _userId: string,
        _accountId: string,
        action: string,
      ) => {
        accountActions.push(action);
      },
      recoveryService: {
        recover: async (input: unknown) => {
          calls.push(input);
          return response;
        },
      },
      estimateSigningSecret: 'recovery-route-test-secret',
    };
    const app = new Hono();
    app.route(
      '/v1/projects',
      createStudioProjectRoutes(
        deps as unknown as Parameters<typeof createStudioProjectRoutes>[0],
      ),
    );

    const result = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision: 'confirm_not_created',
          idempotency_key: 'operator-recovery-key-0001',
          reason: 'Provider confirms no upstream request was created.',
          evidence: { provider_request_id: 'provider-request-1' },
        }),
      },
    );

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(response);
    expect(projectActions).toEqual(['project.studio.jobs.cancel']);
    expect(accountActions).toEqual(['billing.write']);
    expect(calls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'confirm_not_created',
          idempotency_key: 'operator-recovery-key-0001',
          reason: 'Provider confirms no upstream request was created.',
          evidence: { provider_request_id: 'provider-request-1' },
        },
      },
    ]);
  });

  test('maps recovery failures without leaking internals and rejects overposting', async () => {
    const cases: Array<[
      string,
      StudioRecoveryServiceError,
      number,
      Record<string, unknown>,
    ]> = [
      ['not found', new StudioRecoveryServiceError('STUDIO_JOB_CONFLICT', 404), 404, { error: 'Not found' }],
      [
        'invalid asset',
        new StudioRecoveryServiceError('STUDIO_ASSET_INVALID', 400),
        400,
        { code: 'STUDIO_ASSET_INVALID' },
      ],
      [
        'storage unavailable',
        new StudioRecoveryServiceError('STUDIO_STORAGE_UNAVAILABLE', 503),
        503,
        { code: 'STUDIO_STORAGE_UNAVAILABLE' },
      ],
      [
        'idempotency conflict',
        new StudioRecoveryServiceError('STUDIO_RECOVERY_CONFLICT', 409),
        409,
        { code: 'STUDIO_RECOVERY_CONFLICT' },
      ],
      [
        'job conflict',
        new StudioRecoveryServiceError('STUDIO_JOB_CONFLICT', 409),
        409,
        { code: 'STUDIO_JOB_CONFLICT' },
      ],
      [
        'billing incident',
        new StudioRecoveryServiceError('STUDIO_BILLING_INCIDENT_REQUIRED', 409),
        409,
        { code: 'STUDIO_BILLING_INCIDENT_REQUIRED' },
      ],
      [
        'internal',
        new StudioRecoveryServiceError('STUDIO_INTERNAL_ERROR', 500),
        500,
        { code: 'STUDIO_INTERNAL_ERROR' },
      ],
    ];

    for (const [name, error, status, body] of cases) {
      const app = recoveryRouteApp({
        recover: async () => {
          throw error;
        },
      });
      const result = await app.request(
        `/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(validRouteRecoveryRequest()),
        },
      );
      expect(result.status, name).toBe(status);
      expect(await result.json(), name).toMatchObject(body);
    }

    const app = recoveryRouteApp({
      recover: async () => {
        throw new Error('must not be called');
      },
    });
    const overposted = await app.request(
      `/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/recovery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...validRouteRecoveryRequest(),
          actor_user_id: '00000000-0000-4000-a000-000000000001',
        }),
      },
    );
    expect(overposted.status).toBe(400);
    expect(await overposted.json()).toMatchObject({ code: 'STUDIO_VALIDATION_ERROR' });
  });

  test('keeps the internal recovery route out of the public SDK root export', async () => {
    const sdkRoot = await Bun.file(
      new URL('../../../../packages/sdk/src/index.ts', import.meta.url),
    ).text();
    expect(sdkRoot).not.toContain('StudioRecovery');
    expect(sdkRoot).not.toContain('studio/jobs/:jobId/recovery');
  });
});

describe('Studio recovery service', () => {
  test('forwards a confirmed-not-created decision through the locked atomic boundary', async () => {
    const response = StudioRecoveryResponseSchema.parse({
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'confirm_not_created',
      job_status: 'failed',
      attempt_status: 'failed',
      reservation_status: 'released',
      hold_expires_at: null,
    });
    const repository = new RecordingRecoveryRepository(response);
    const service = new StudioRecoveryService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'recovery-test', ready: true }),
      now: () => NOW,
    });
    const request = {
      decision: 'confirm_not_created' as const,
      idempotency_key: 'operator-recovery-key-0001',
      reason: 'Provider confirms no upstream request was created.',
      evidence: { provider_request_id: 'provider-request-1' },
    };

    await expect(
      service.recover({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        request,
      }),
    ).resolves.toEqual(response);
    expect(repository.calls).toEqual([
      {
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        job_id: JOB_ID,
        actor_user_id: USER_ID,
        actor_type: 'user',
        acting_token_id: null,
        decision: 'confirm_not_created',
        idempotency_key: 'operator-recovery-key-0001',
        request_hash: canonicalStudioRequestHash({
          decision: request.decision,
          reason: request.reason,
          evidence: request.evidence,
        }),
        reason: 'Provider confirms no upstream request was created.',
        recovered_at: NOW.toISOString(),
      },
    ]);
    expect(repository.prepared).toEqual([
      {
        evidence: { provider_request_id: 'provider-request-1' },
        result_assets: null,
        actual_credits: null,
        keep_unknown_until: null,
      },
    ]);
  });

  test('extends an unknown-outcome hold by at most seven days without terminal assets or cost', async () => {
    const response = StudioRecoveryResponseSchema.parse({
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'keep_unknown',
      job_status: 'running',
      attempt_status: 'reconciling',
      reservation_status: 'active',
      hold_expires_at: '2026-07-18T08:00:00.000Z',
    });
    const repository = new RecordingRecoveryRepository(response, {
      ...lockedContext,
      reservation_expires_at: '2026-07-17T12:00:00.000Z',
      job_available_at: '2026-07-17T12:00:00.000Z',
    });
    const service = new StudioRecoveryService({
      repository,
      store: new InMemoryStudioObjectStore({ namespace: 'recovery-test', ready: true }),
      now: () => NOW,
    });

    await expect(
      service.recover({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'keep_unknown',
          idempotency_key: 'operator-recovery-key-0002',
          reason: 'Provider outcome remains unknown after operator review.',
          evidence: { provider_request_id: 'provider-request-1' },
        },
      }),
    ).resolves.toEqual(response);
    expect(repository.prepared).toEqual([
      {
        evidence: { provider_request_id: 'provider-request-1' },
        result_assets: null,
        actual_credits: null,
        keep_unknown_until: '2026-07-18T08:00:00.000Z',
      },
    ]);
  });

  test('verifies a database-derived staging manifest and every object before confirming success', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'recovery-test', ready: true });
    const submissionHash = sha256(new TextEncoder().encode(lockedContext.submission_key));
    const prefix =
      `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/jobs/${JOB_ID}` +
      `/attempts/${ATTEMPT_ID}/submissions/${submissionHash}/`;
    const assetKey = `${prefix}assets/image-1.png`;
    const manifestKey = `${prefix}manifest.json`;
    const assetBytes = new Uint8Array([137, 80, 78, 71]);
    const assetChecksum = sha256(assetBytes);
    await store.putObject({
      key: assetKey,
      body: new Blob([assetBytes]).stream(),
      content_type: 'image/png',
      size_bytes: assetBytes.byteLength,
      checksum_sha256: assetChecksum,
      metadata: {},
    });
    const manifest = {
      version: 1,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      submission_key_hash: submissionHash,
      provider_config_id: lockedContext.provider_config_id,
      provider_config_version: lockedContext.provider_config_version,
      pricing_catalog_id: lockedContext.pricing_catalog_id,
      pricing_version: lockedContext.pricing_version,
      assets: [
        {
          kind: 'image',
          key: assetKey,
          filename: 'image-1.png',
          mime_type: 'image/png',
          size_bytes: assetBytes.byteLength,
          checksum_sha256: assetChecksum,
        },
      ],
      usage: { output_count: 1 },
    };
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const manifestChecksum = sha256(manifestBytes);
    await store.putObject({
      key: manifestKey,
      body: new Blob([manifestBytes]).stream(),
      content_type: 'application/json',
      size_bytes: manifestBytes.byteLength,
      checksum_sha256: manifestChecksum,
      metadata: {},
    });
    const response = StudioRecoveryResponseSchema.parse({
      recovery_id: RECOVERY_ID,
      job_id: JOB_ID,
      attempt_id: ATTEMPT_ID,
      decision: 'confirm_succeeded',
      job_status: 'succeeded',
      attempt_status: 'succeeded',
      reservation_status: 'settled',
      hold_expires_at: null,
    });
    const repository = new RecordingRecoveryRepository(response, {
      ...lockedContext,
      staging_manifest_key: manifestKey,
      staging_manifest_checksum: manifestChecksum,
    });
    const service = new StudioRecoveryService({ repository, store, now: () => NOW });

    await expect(
      service.recover({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        request: {
          decision: 'confirm_succeeded',
          idempotency_key: 'operator-recovery-key-0003',
          reason: 'Durable staging evidence confirms provider success.',
          evidence: {
            staging_manifest_key: manifestKey,
            staging_manifest_checksum: manifestChecksum,
            provider_request_id: 'provider-request-1',
          },
        },
      }),
    ).resolves.toEqual(response);
    expect(repository.prepared).toEqual([
      {
        evidence: {
          staging_manifest_key: manifestKey,
          staging_manifest_checksum: manifestChecksum,
          provider_request_id: 'provider-request-1',
          upstream_usage: { output_count: 1 },
          upstream_cost_credits: 2,
        },
        result_assets: [
          {
            kind: 'image',
            filename: 'image-1.png',
            mimeType: 'image/png',
            bucket: 'recovery-test',
            objectKey: assetKey,
            checksumSha256: assetChecksum,
            sizeBytes: assetBytes.byteLength,
          },
        ],
        actual_credits: 3.75,
        keep_unknown_until: null,
      },
    ]);
  });

  test('rejects every substituted staging identity before the atomic recovery call', async () => {
    const mutations: Array<[string, (manifest: Record<string, unknown>) => void]> = [
      ['account', (manifest) => (manifest.account_id = '81000000-0000-4000-a000-000000000099')],
      ['project', (manifest) => (manifest.project_id = '82000000-0000-4000-a000-000000000099')],
      ['job', (manifest) => (manifest.job_id = '84000000-0000-4000-a000-000000000099')],
      ['attempt', (manifest) => (manifest.attempt_id = '85000000-0000-4000-a000-000000000099')],
      ['submission', (manifest) => (manifest.submission_key_hash = 'f'.repeat(64))],
      ['provider id', (manifest) => (manifest.provider_config_id = '87000000-0000-4000-a000-000000000099')],
      ['provider version', (manifest) => (manifest.provider_config_version = 'substituted-version')],
      ['pricing id', (manifest) => (manifest.pricing_catalog_id = '88000000-0000-4000-a000-000000000099')],
      ['pricing version', (manifest) => (manifest.pricing_version = 99)],
      [
        'asset key',
        (manifest) => {
          const assets = manifest.assets as Array<Record<string, unknown>>;
          if (assets[0]) assets[0].key = `accounts/${ACCOUNT_ID}/projects/other/secret.png`;
        },
      ],
    ];

    for (const [name, mutate] of mutations) {
      const fixture = await createStagedSuccessFixture(mutate);
      await expect(fixture.service.recover(fixture.input)).rejects.toMatchObject({
        code: 'STUDIO_ASSET_INVALID',
        status: 400,
      });
      expect(fixture.repository.commits, name).toBe(0);
      expect(fixture.headKeys, name).not.toContain(`accounts/${ACCOUNT_ID}/projects/other/secret.png`);
    }

    for (const field of ['staging_manifest_key', 'staging_manifest_checksum'] as const) {
      const fixture = await createStagedSuccessFixture();
      fixture.input.request.evidence[field] =
        field === 'staging_manifest_key' ? `${fixture.prefix}other.json` : '0'.repeat(64);
      await expect(fixture.service.recover(fixture.input)).rejects.toMatchObject({
        code: 'STUDIO_ASSET_INVALID',
        status: 400,
      });
      expect(fixture.repository.commits, field).toBe(0);
      expect(fixture.headKeys, field).toEqual([]);
    }
  });

  test('rejects re-HEAD metadata or encryption drift and distinguishes storage outages', async () => {
    const mismatches: Array<[
      string,
      (head: StudioObjectMetadata) => StudioObjectMetadata,
    ]> = [
      ['namespace', (head) => ({ ...head, namespace: 'other-bucket' })],
      ['key', (head) => ({ ...head, key: `${head.key}.substituted` })],
      ['MIME', (head) => ({ ...head, content_type: 'image/jpeg' })],
      ['size', (head) => ({ ...head, size_bytes: head.size_bytes + 1 })],
      ['checksum', (head) => ({ ...head, checksum_sha256: '0'.repeat(64) })],
      ['SSE', (head) => ({ ...head, server_side_encryption: 'aws:kms' })],
      ['KMS', (head) => ({ ...head, sse_kms_key_id: 'wrong-key' })],
    ];
    for (const [name, mutate] of mismatches) {
      const fixture = await createStagedSuccessFixture();
      const headObject = fixture.store.headObject.bind(fixture.store);
      fixture.store.headObject = async (ref) => {
        const head = await headObject(ref);
        return ref.key.endsWith('/manifest.json') ? head : mutate(head);
      };
      await expect(fixture.service.recover(fixture.input)).rejects.toMatchObject({
        code: 'STUDIO_ASSET_INVALID',
        status: 400,
      });
      expect(fixture.repository.commits, name).toBe(0);
    }

    const unavailable = await createStagedSuccessFixture();
    unavailable.store.headObject = async () => {
      throw new StudioStorageUnavailableError();
    };
    await expect(unavailable.service.recover(unavailable.input)).rejects.toMatchObject({
      code: 'STUDIO_STORAGE_UNAVAILABLE',
      status: 503,
    });
    expect(unavailable.repository.commits).toBe(0);
  });
});

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

async function createStagedSuccessFixture(
  mutate?: (manifest: Record<string, unknown>) => void,
) {
  const store = new InMemoryStudioObjectStore({ namespace: 'recovery-test', ready: true });
  const submissionHash = sha256(new TextEncoder().encode(lockedContext.submission_key));
  const prefix =
    `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/jobs/${JOB_ID}` +
    `/attempts/${ATTEMPT_ID}/submissions/${submissionHash}/`;
  const assetKey = `${prefix}assets/image-1.png`;
  const manifestKey = `${prefix}manifest.json`;
  const assetBytes = new Uint8Array([137, 80, 78, 71]);
  const assetChecksum = sha256(assetBytes);
  await store.putObject({
    key: assetKey,
    body: new Blob([assetBytes]).stream(),
    content_type: 'image/png',
    size_bytes: assetBytes.byteLength,
    checksum_sha256: assetChecksum,
    metadata: {},
  });
  const manifest: Record<string, unknown> = {
    version: 1,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    job_id: JOB_ID,
    attempt_id: ATTEMPT_ID,
    submission_key_hash: submissionHash,
    provider_config_id: lockedContext.provider_config_id,
    provider_config_version: lockedContext.provider_config_version,
    pricing_catalog_id: lockedContext.pricing_catalog_id,
    pricing_version: lockedContext.pricing_version,
    assets: [
      {
        kind: 'image',
        key: assetKey,
        filename: 'image-1.png',
        mime_type: 'image/png',
        size_bytes: assetBytes.byteLength,
        checksum_sha256: assetChecksum,
      },
    ],
    usage: { output_count: 1 },
  };
  mutate?.(manifest);
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const manifestChecksum = sha256(manifestBytes);
  await store.putObject({
    key: manifestKey,
    body: new Blob([manifestBytes]).stream(),
    content_type: 'application/json',
    size_bytes: manifestBytes.byteLength,
    checksum_sha256: manifestChecksum,
    metadata: {},
  });
  const response = StudioRecoveryResponseSchema.parse({
    recovery_id: RECOVERY_ID,
    job_id: JOB_ID,
    attempt_id: ATTEMPT_ID,
    decision: 'confirm_succeeded',
    job_status: 'succeeded',
    attempt_status: 'succeeded',
    reservation_status: 'settled',
    hold_expires_at: null,
  });
  const repository = new RecordingRecoveryRepository(response, {
    ...lockedContext,
    staging_manifest_key: manifestKey,
    staging_manifest_checksum: manifestChecksum,
  });
  const headKeys: string[] = [];
  const headObject = store.headObject.bind(store);
  store.headObject = async (ref) => {
    headKeys.push(ref.key);
    return headObject(ref);
  };
  const service = new StudioRecoveryService({ repository, store, now: () => NOW });
  const input = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    actorUserId: USER_ID,
    actorType: 'user' as const,
    actingTokenId: null,
    request: {
      decision: 'confirm_succeeded' as const,
      idempotency_key: 'operator-recovery-key-attack',
      reason: 'Durable staging evidence confirms provider success.',
      evidence: {
        staging_manifest_key: manifestKey,
        staging_manifest_checksum: manifestChecksum,
        provider_request_id: 'provider-request-1',
      },
    },
  };
  return { store, repository, service, input, prefix, headKeys };
}
