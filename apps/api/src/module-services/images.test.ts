import { describe, expect, test } from 'bun:test';
import {
  OpenOpcImageAssetListSchema,
  type ModuleServiceCapabilityClaimsV1,
  type StudioJob,
} from '@kortix/api-contract';
import { canonicalStudioRequestHash } from '@kortix/studio-runtime';

import { DEVELOPER_RUNTIME_TEST_PROFILE } from '../release-profile/test-fixtures';
import { createMemoryStudioRepository } from '../studio/repositories/memory';
import type { StudioCreateJobInput } from '../studio/types';
import { createModuleImageRoutes, type ModuleImageDependencies } from './images';
import { ModuleServiceCapabilityError } from './capability-grants';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const CONSENT_ID = '50000000-0000-4000-a000-000000000001';
const ACTOR_USER_ID = '60000000-0000-4000-a000-000000000001';
const OTHER_ACTOR_USER_ID = '60000000-0000-4000-a000-000000000002';
const GRANT_ID = '70000000-0000-4000-8000-000000000001';
const PROVIDER_CONFIG_ID = '80000000-0000-4000-8000-000000000001';
const JOB_ID = 'a0000000-0000-4000-8000-000000000001';
const AUTHORIZATION = 'Bearer v4.public.module-capability';

function claims(): ModuleServiceCapabilityClaimsV1 {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '90000000-0000-4000-8000-000000000001',
    iat: '2026-08-01T00:00:00.000Z',
    exp: '2026-08-01T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 4,
    releaseId: RELEASE_ID,
    moduleId: 'openopc.image-studio',
    moduleVersion: '0.1.0',
    consentId: CONSENT_ID,
    grantId: GRANT_ID,
    actorUserId: ACTOR_USER_ID,
    service: 'ai',
    operations: [
      'images.models.read',
      'images.estimates.create',
      'images.jobs.create',
      'images.jobs.read',
      'images.jobs.cancel',
      'images.assets.create',
      'images.assets.read',
      'images.assets.download',
    ],
  };
}

function fixture(runtime = DEVELOPER_RUNTIME_TEST_PROFILE) {
  const calls: string[] = [];
  const dependencies = {
    runtime,
    repository: {} as ModuleImageDependencies['repository'],
    storageService: { isReady: async () => true } as unknown as ModuleImageDependencies['storageService'],
    estimateSigningSecret: 'image-test-secret',
    capabilityRegistry: {
      async discover() {
        return {
          executionTargets: [
            {
              capability_id: 'studio.image.generate',
              provider_config_id: PROVIDER_CONFIG_ID,
              model: 'vendor/private-model-v3',
            },
          ],
        };
      },
    },
    async requireCapability(
      authorization: string | undefined,
      operation: Parameters<ModuleImageDependencies['requireCapability']>[1],
    ) {
      expect(authorization).toBe(AUTHORIZATION);
      calls.push(operation);
      return claims();
    },
  } satisfies ModuleImageDependencies;
  return { app: createModuleImageRoutes(dependencies), calls, dependencies };
}

describe('module image service facade', () => {
  test('returns an opaque OpenOPC model identifier without provider fields', async () => {
    const { app, calls } = fixture();
    const response = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: Array<{
        id: string;
        object: string;
        owned_by: string;
        name: string;
        capabilities: { reference_images: boolean; max_reference_images: number; supports_negative_prompt: boolean; supports_seed: boolean };
      }>;
    };
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0]).toMatchObject({
      object: 'image_model',
      owned_by: 'openopc',
      name: 'OpenOPC Image 1',
    });
    expect(payload.data[0]?.id).toMatch(/^img1\/[A-Za-z0-9._:-]+$/);
    expect(payload.data[0]?.id).not.toContain(PROVIDER_CONFIG_ID);
    expect(payload.data[0]?.id).not.toContain('private-model');
    expect(payload.data[0]?.capabilities).toMatchObject({
      reference_images: false,
      max_reference_images: 0,
      supports_negative_prompt: false,
      supports_seed: false,
    });
    expect(calls).toEqual(['images.models.read']);
  });

  test('fails closed when the release profile has no module AI gateway capability', async () => {
    const { app, calls } = fixture({
      ...DEVELOPER_RUNTIME_TEST_PROFILE,
      allows: () => false,
    });
    const response = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.ai.gateway',
    });
    expect(calls).toEqual([]);
  });

  test('maps a denied capability to the stable module error', async () => {
    const { dependencies } = fixture();
    const denied = createModuleImageRoutes({
      ...dependencies,
      requireCapability: async () => {
        throw new ModuleServiceCapabilityError('MODULE_SERVICE_OPERATION_DENIED', 403);
      },
    });
    const response = await denied.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'MODULE_SERVICE_OPERATION_DENIED' });
  });

  test('binds opaque image model identifiers to the installation, release, and actor', async () => {
    const { app: catalogApp, dependencies } = fixture();
    const catalogResponse = await catalogApp.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });
    const model = ((await catalogResponse.json()) as { data: Array<{ id: string }> }).data[0]?.id;
    if (!model) throw new Error('Expected the fixture to expose an image model.');

    const otherActorApp = createModuleImageRoutes({
      ...dependencies,
      requireCapability: async () => ({ ...claims(), actorUserId: OTHER_ACTOR_USER_ID }),
    });
    const response = await otherActorApp.request('/estimates', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        input: {
          prompt: 'A private project image',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'MODULE_IMAGE_INVALID' });
  });

  test('does not reuse a module capability grant as a Studio account token', async () => {
    const repository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'fake',
          display_name: 'Fake image provider',
          base_url: null,
          region: null,
          credential_binding: { kind: 'none' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    let createInput: StudioCreateJobInput | undefined;
    const createJob = repository.createJob.bind(repository);
    repository.createJob = async (input, ...rest) => {
      createInput = input;
      return createJob(input, ...rest);
    };
    const { dependencies } = fixture();
    const app = createModuleImageRoutes({
      ...dependencies,
      repository,
      capabilityRegistry: {
        async discover() {
          return {
            executionTargets: [
              {
                capability_id: 'studio.image.generate',
                provider_config_id: PROVIDER_CONFIG_ID,
                model: 'fake/image-v1',
              },
            ],
          };
        },
      },
    });
    const imageInput = {
      prompt: 'A quiet editorial still life',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    };

    const catalogResponse = await app.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });
    const model = ((await catalogResponse.json()) as { data: Array<{ id: string }> }).data[0]?.id;
    if (!model) throw new Error('Expected the fixture to expose an image model.');

    const estimateResponse = await app.request('/estimates', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: imageInput }),
    });
    expect(estimateResponse.status).toBe(200);
    const estimate = (await estimateResponse.json()) as {
      estimate_id: string;
      estimate_token: string;
      max_approved_credits: number;
    };

    const response = await app.request('/jobs', {
      method: 'POST',
      headers: {
        authorization: AUTHORIZATION,
        'content-type': 'application/json',
        'idempotency-key': 'image-token-binding-key-0001',
      },
      body: JSON.stringify({
        model,
        input: imageInput,
        estimate: {
          estimate_id: estimate.estimate_id,
          estimate_token: estimate.estimate_token,
          max_approved_credits: estimate.max_approved_credits,
        },
      }),
    });

    expect(response.status).toBe(201);
    expect(createInput).toMatchObject({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      actor_type: 'user',
      acting_token_id: null,
    });
    expect(createInput?.acting_token_id).not.toBe(GRANT_ID);
  });

  test('normalizes PostgreSQL timestamps before returning public image assets', async () => {
    const { dependencies } = fixture();
    const app = createModuleImageRoutes({
      ...dependencies,
      repository: {
        ...dependencies.repository,
        listAssets: async () => ({
          items: [
            {
              asset_id: 'b0000000-0000-4000-8000-000000000001',
              account_id: ACCOUNT_ID,
              project_id: PROJECT_ID,
              source_job_id: null,
              kind: 'image',
              mime_type: 'image/png',
              bucket: 'local-image-assets',
              object_key: 'project/asset.png',
              checksum_sha256: 'a'.repeat(64),
              size_bytes: 68,
              width: 1,
              height: 1,
              metadata: {},
              created_at: '2026-08-06 15:15:33.000286+00',
            },
          ],
          next_cursor: null,
        }),
      },
    });

    const response = await app.request('/assets/list', {
      method: 'POST',
      headers: { authorization: AUTHORIZATION, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(OpenOpcImageAssetListSchema.safeParse(payload).success).toBeTrue();
    expect(payload).toMatchObject({
      items: [{ created_at: '2026-08-06T15:15:33.000Z' }],
      next_cursor: null,
    });
  });

  test('replays an existing image job without requiring a still-valid estimate', async () => {
    const { app: catalogApp, dependencies } = fixture();
    const catalogResponse = await catalogApp.request('/models', {
      headers: { authorization: AUTHORIZATION },
    });
    const model = ((await catalogResponse.json()) as { data: Array<{ id: string }> }).data[0]?.id;
    if (!model) throw new Error('Expected the fixture to expose an image model.');

    const imageInput = {
      prompt: 'A quiet editorial still life',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    };
    const requestHash = canonicalStudioRequestHash({
      capability: 'image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      model: 'vendor/private-model-v3',
      input: { capability: 'image.generate', image: imageInput },
    });
    const replay: StudioJob = {
      job_id: JOB_ID,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_user_id: ACTOR_USER_ID,
      actor_type: 'user',
      capability: 'image.generate',
      provider_config_id: PROVIDER_CONFIG_ID,
      provider: 'private-provider',
      model: 'vendor/private-model-v3',
      input: { capability: 'image.generate', image: imageInput },
      status: 'succeeded',
      idempotency_key: 'image-replay-key-0001',
      request_hash: requestHash,
      attempt_count: 1,
      reserved_credits: 1,
      actual_credits: 1,
      error_code: null,
      error_message: null,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:01:00.000Z',
      started_at: '2026-08-01T00:00:01.000Z',
      completed_at: '2026-08-01T00:01:00.000Z',
    };
    const app = createModuleImageRoutes({
      ...dependencies,
      repository: {
        ...dependencies.repository,
        findJobByIdempotency: async () => replay,
      },
    });
    const response = await app.request('/jobs', {
      method: 'POST',
      headers: {
        authorization: AUTHORIZATION,
        'content-type': 'application/json',
        'idempotency-key': replay.idempotency_key,
      },
      body: JSON.stringify({
        model,
        input: imageInput,
        estimate: {
          estimate_id: 'b0000000-0000-4000-8000-000000000001',
          estimate_token: 'expired-estimate-token',
          max_approved_credits: 1,
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      created: false,
      job: { job_id: JOB_ID, status: 'succeeded', actual_credits: 1 },
    });
  });
});
