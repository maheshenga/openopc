import { describe, expect, test } from 'bun:test';
import type {
  ModuleServiceCapabilityClaimsV1,
  OpenOpcImageAsset,
  OpenOpcImageEstimate,
  OpenOpcImageJob,
  OpenOpcImageModel,
} from '@kortix/api-contract';
import type { RegistryModuleManifest } from '@kortix/registry';

import {
  COMPLETE_RUNTIME_TEST_PROFILE,
  RESTRICTED_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import { createModuleServicesApp } from './app';
import type {
  ModuleServiceCapabilityGrant,
  ModuleServiceConsent,
  ModuleServiceInstallationContext,
} from './capability-grants';
import {
  type ModuleImageBackend,
  type ModuleImageDependencies,
  createModuleImageRoutes,
} from './images';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const GRANT_ID = '60000000-0000-4000-8000-000000000001';
const USER_ID = '70000000-0000-4000-a000-000000000001';
const JOB_ID = '80000000-0000-4000-a000-000000000001';
const EVENT_ID = '81000000-0000-4000-a000-000000000001';
const ASSET_ID = '90000000-0000-4000-a000-000000000001';
const ESTIMATE_ID = 'a0000000-0000-4000-a000-000000000001';
const MODEL_ID = 'b0000000-0000-4000-a000-000000000001:fake/image-v1';
const AUTHORIZATION = 'Bearer v4.public.module-image-capability';
const NOW = new Date('2026-08-08T08:00:00.000Z');

const IMAGE_MODEL: OpenOpcImageModel = {
  id: MODEL_ID,
  object: 'image.model',
  owned_by: 'openopc',
  name: 'Test image model',
  capabilities: {
    prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
    reference_images: {
      max_images: 0,
      max_bytes_per_image: 32 * 1024 * 1024,
      max_total_bytes: 32 * 1024 * 1024,
      accepted_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
    },
    output: {
      min_images: 1,
      max_images: 8,
      max_bytes_per_image: 32 * 1024 * 1024,
      accepted_mime_types: ['image/png', 'image/jpeg', 'image/webp'],
      aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
      qualities: ['standard', 'high'],
    },
  },
};

const IMAGE_INPUT = {
  prompt: 'A bounded module image',
  reference_asset_ids: [],
  aspect_ratio: '1:1' as const,
  quality: 'standard' as const,
  output_count: 1,
};

const ESTIMATE: OpenOpcImageEstimate = {
  estimate_id: ESTIMATE_ID,
  estimate_token: 'studio-estimate-token-value',
  expires_at: '2026-08-08T08:15:00.000Z',
  valid_for_ms: 15 * 60 * 1000,
  retry: { on_expired: 'create-new-estimate', automatic_job_retry: false },
  currency: 'credits',
  provider_cost_credits: 1,
  platform_cost_credits: 0,
  max_approved_credits: 1,
  quota: {
    required_credits: 1,
    available_credits: null,
    remaining_after_estimate_credits: null,
  },
  settlement: {
    succeeded: 'settle-actual-usage',
    failed: 'settle-verified-usage',
    cancelled: 'settle-verified-usage',
    maximum_charge_credits: 1,
  },
  input_hash: '1'.repeat(64),
  line_items: [{ label: 'Image generation', credits: 1 }],
};

const JOB: OpenOpcImageJob = {
  job_id: JOB_ID,
  model: MODEL_ID,
  input: IMAGE_INPUT,
  status: 'queued',
  attempt_count: 0,
  reserved_credits: 1,
  actual_credits: null,
  error_code: null,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
  started_at: null,
  completed_at: null,
  cancellable: true,
};

const ASSET: OpenOpcImageAsset = {
  asset_id: ASSET_ID,
  source: { job_id: null, prompt: null },
  kind: 'image',
  mime_type: 'image/png',
  checksum_sha256: 'a'.repeat(64),
  size_bytes: 68,
  width: 1,
  height: 1,
  metadata: { purpose: 'reference' },
  retention: { policy: 'retained', expires_at: null, deletable: false },
  created_at: NOW.toISOString(),
};

function manifest(): RegistryModuleManifest {
  return {
    schemaVersion: 3,
    id: 'example.image-studio',
    version: '1.2.3',
    publisher: { id: 'example-publisher' },
    locales: ['zh-CN'],
    compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
    execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
    verification: { profile: 'sandboxed-web' },
    capabilities: [{ id: 'example.image-studio.generate', kind: 'ui' }],
    openopc: {
      sdkApiVersion: 'v1',
      services: { ai: { operations: ['image.generate'] } },
    },
  };
}

function capabilityClaims(): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '01000000-0000-4000-8000-000000000001',
    iat: '2026-08-08T07:59:00.000Z',
    exp: '2026-08-08T08:04:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'example.image-studio',
    moduleVersion: '1.2.3',
    consentId: CONSENT_ID,
    grantId: GRANT_ID,
    service: 'ai',
    operations: ['image.generate'],
  };
}

function authorization(): {
  grant: ModuleServiceCapabilityGrant;
  consent: ModuleServiceConsent;
  installation: ModuleServiceInstallationContext;
} {
  return {
    grant: {
      grantId: GRANT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      consentId: CONSENT_ID,
      service: 'ai',
      operations: ['image.generate'],
      tokenHash: `sha256:${'c'.repeat(64)}`,
      expiresAt: '2026-08-08T08:04:00.000Z',
      revokedAt: null,
      createdAt: '2026-08-08T07:59:00.000Z',
    },
    consent: {
      consentId: CONSENT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseId: RELEASE_ID,
      installRevision: 4,
      service: 'ai',
      operations: ['image.generate'],
      consentDigest: `sha256:${'d'.repeat(64)}`,
      acceptedBy: USER_ID,
      acceptedAt: '2026-08-08T07:00:00.000Z',
      revokedBy: null,
      revokedAt: null,
    },
    installation: {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      installRevision: 4,
      releaseId: RELEASE_ID,
      moduleId: 'example.image-studio',
      moduleVersion: '1.2.3',
      installationStatus: 'active',
      releaseStatus: 'published',
      signatureAlgorithm: 'ed25519',
      signature: `base64url:${'e'.repeat(86)}`,
      signedAt: '2026-08-08T07:00:00.000Z',
      manifest: manifest(),
    },
  };
}

function fixture(
  input: {
    runtime?: ModuleImageDependencies['runtime'];
    backend?: ModuleImageBackend | null;
    authorization?: ReturnType<typeof authorization> | null;
  } = {},
) {
  const calls = {
    capability: 0,
    authorization: 0,
    backend: 0,
    operations: [] as string[],
  };
  const backend: ModuleImageBackend =
    input.backend ??
    ({
      async listModels(scope) {
        calls.backend += 1;
        expect(scope.actorUserId).toBe(USER_ID);
        return { data: [IMAGE_MODEL] };
      },
      async createEstimate(_scope, request) {
        expect(request).toEqual({ model: MODEL_ID, input: IMAGE_INPUT });
        return ESTIMATE;
      },
      async createJob(_scope, request) {
        expect(request.idempotency_key).toBe('module-image-idempotency-0001');
        return { job: JOB, created: true };
      },
      async getJob(_scope, jobId) {
        expect(jobId).toBe(JOB_ID);
        return JOB;
      },
      async listEvents(_scope, jobId, page) {
        expect({ jobId, page }).toEqual({ jobId: JOB_ID, page: { cursor: '1', limit: 25 } });
        return {
          items: [
            {
              event_id: EVENT_ID,
              job_id: JOB_ID,
              cursor: '2',
              type: 'progress',
              progress: 0.5,
              created_at: NOW.toISOString(),
            },
          ],
          next_cursor: null,
        };
      },
      async listJobOutputs(_scope, jobId, page) {
        expect({ jobId, page }).toEqual({
          jobId: JOB_ID,
          page: { cursor: null, limit: 100 },
        });
        return { items: [ASSET], next_cursor: null };
      },
      async cancelJob() {
        return { ...JOB, status: 'cancelled', cancellable: false };
      },
      async createAsset(_scope, request) {
        expect(request.filename).toBe('pixel.png');
        expect(request.mimeType).toBe('image/png');
        expect(request.metadata).toEqual({ purpose: 'reference' });
        return ASSET;
      },
      async listAssets(_scope, page) {
        expect(page.cursor).toBeNull();
        expect(page.limit).toBe(10);
        return { items: [ASSET], next_cursor: null };
      },
      async previewAsset() {
        return {
          asset_id: ASSET_ID,
          url: 'https://assets.example.test/preview.png?signature=redacted',
          expires_at: '2026-08-08T08:15:00.000Z',
        };
      },
      async thumbnailAsset(_scope, assetId, preset) {
        return {
          asset_id: assetId,
          preset,
          url: 'https://assets.example.test/thumbnail.webp?signature=redacted',
          mime_type: 'image/webp',
          width: 1,
          height: 1,
          size_bytes: 42,
          cache: { visibility: 'private', max_age_seconds: 900, immutable: true },
          expires_at: '2026-08-08T08:15:00.000Z',
        };
      },
      async downloadAsset() {
        return { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', filename: 'pixel.png' };
      },
    } satisfies ModuleImageBackend);
  const dependencies: ModuleImageDependencies = {
    runtime: input.runtime ?? COMPLETE_RUNTIME_TEST_PROFILE,
    backend: input.backend === null ? null : backend,
    now: () => NOW,
    async requireCapability(received, operation) {
      expect(received).toBe(AUTHORIZATION);
      expect(operation).toBe('image.generate');
      calls.capability += 1;
      calls.operations.push(operation);
      return capabilityClaims();
    },
    async loadAuthorization(grantId) {
      expect(grantId).toBe(GRANT_ID);
      calls.authorization += 1;
      return input.authorization === undefined ? authorization() : input.authorization;
    },
  };
  return { app: createModuleImageRoutes(dependencies), calls, dependencies };
}

describe('module image service facade', () => {
  test('fails closed before authorization when the release profile is incomplete', async () => {
    const { app, calls } = fixture({ runtime: RESTRICTED_RUNTIME_TEST_PROFILE });
    const response = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_UNAVAILABLE' });
    expect(calls.capability).toBe(0);
    expect(calls.authorization).toBe(0);
  });

  test('rejects a stale installation revision before invoking the Studio backend', async () => {
    const staleAuthorization = authorization();
    staleAuthorization.installation.installRevision += 1;
    const { app, calls } = fixture({ authorization: staleAuthorization });

    const response = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_CAPABILITY_REVOKED' });
    expect(calls).toMatchObject({ capability: 1, authorization: 1, backend: 0 });
  });

  test('mounts the image facade on the SDK path', async () => {
    const { dependencies } = fixture();
    const app = createModuleServicesApp(undefined, undefined, dependencies);
    const response = await app.request('/ai/images/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [IMAGE_MODEL] });
  });

  test('serves the module-used model, estimate, job, event, and asset paths', async () => {
    const { app, calls } = fixture();
    const headers = { authorization: AUTHORIZATION };

    const models = await app.request('/models', { headers });
    expect(models.status).toBe(200);
    expect(await models.json()).toEqual({ data: [IMAGE_MODEL] });

    const estimate = await app.request('/estimates', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL_ID, input: IMAGE_INPUT }),
    });
    expect(estimate.status).toBe(200);
    expect(await estimate.json()).toEqual(ESTIMATE);

    const job = await app.request('/jobs', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        'idempotency-key': 'module-image-idempotency-0001',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        input: IMAGE_INPUT,
        estimate_id: ESTIMATE_ID,
        estimate_token: ESTIMATE.estimate_token,
        idempotency_key: 'module-image-idempotency-0001',
      }),
    });
    expect(job.status).toBe(201);
    expect(await job.json()).toEqual(JOB);

    const read = await app.request(`/jobs/${JOB_ID}`, { headers });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(JOB);

    const events = await app.request(`/jobs/${JOB_ID}/events?cursor=1&limit=25`, { headers });
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject({
      items: [{ event_id: EVENT_ID, progress: 0.5 }],
      next_cursor: null,
    });

    const outputs = await app.request(`/jobs/${JOB_ID}/outputs?limit=100`, { headers });
    expect(outputs.status).toBe(200);
    expect(await outputs.json()).toEqual({ items: [ASSET], next_cursor: null });

    const cancelled = await app.request(`/jobs/${JOB_ID}/cancel`, {
      method: 'POST',
      headers,
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', cancellable: false });

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'pixel.png');
    form.set('filename', 'pixel.png');
    form.set('metadata', JSON.stringify({ purpose: 'reference' }));
    const createdAsset = await app.request('/assets', { method: 'POST', headers, body: form });
    expect(createdAsset.status).toBe(201);
    expect(await createdAsset.json()).toEqual(ASSET);

    const assets = await app.request('/assets?limit=10', { headers });
    expect(assets.status).toBe(200);
    expect(await assets.json()).toEqual({ items: [ASSET], next_cursor: null });

    const uploadedAssets = await app.request('/assets?source=uploaded&limit=10', { headers });
    expect(uploadedAssets.status).toBe(200);
    expect(await uploadedAssets.json()).toEqual({ items: [ASSET], next_cursor: null });

    const invalidAssetFilter = await app.request(
      `/assets?source=uploaded&source_job_id=${JOB_ID}`,
      { headers },
    );
    expect(invalidAssetFilter.status).toBe(400);
    expect(await invalidAssetFilter.json()).toEqual({ error: 'OPENOPC_IMAGE_VALIDATION_ERROR' });

    const preview = await app.request(`/assets/${ASSET_ID}/preview-url`, { headers });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ asset_id: ASSET_ID });

    const thumbnail = await app.request(`/assets/${ASSET_ID}/thumbnail-url?preset=small`, {
      headers,
    });
    expect(thumbnail.status).toBe(200);
    expect(await thumbnail.json()).toMatchObject({
      asset_id: ASSET_ID,
      preset: 'small',
      mime_type: 'image/webp',
      cache: { visibility: 'private', max_age_seconds: 900, immutable: true },
    });

    const download = await app.request(`/assets/${ASSET_ID}/download`, { headers });
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    expect(calls.capability).toBe(14);
    expect(calls.authorization).toBe(14);
    expect(calls.operations).toEqual(Array(14).fill('image.generate'));
  });

  test('returns stable errors for unavailable storage policy mutations', async () => {
    const { app } = fixture();
    const headers = { authorization: AUTHORIZATION, 'content-type': 'application/json' };

    const deletion = await app.request(`/assets/${ASSET_ID}/delete`, {
      method: 'POST',
      headers,
    });
    expect(deletion.status).toBe(501);
    expect(await deletion.json()).toEqual({ error: 'OPENOPC_IMAGE_INTERNAL_ERROR' });

    const retention = await app.request(`/assets/${ASSET_ID}/retention`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ policy: 'retained' }),
    });
    expect(retention.status).toBe(501);
    expect(await retention.json()).toEqual({ error: 'OPENOPC_IMAGE_INTERNAL_ERROR' });
  });
});
