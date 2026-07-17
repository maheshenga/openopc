import { describe, expect, test } from 'bun:test';
import { createStudioProviderRegistry } from './provider-registry';
import type { StudioWorkerJob, StudioWorkerProviderConfig } from './contracts';

const job = {
  jobId: 'job-a',
  accountId: 'account-a',
  projectId: 'project-a',
  actorUserId: 'user-a',
  actorType: 'user',
  actingTokenId: null,
  agentName: null,
  sessionId: null,
  capability: 'image.generate',
  providerConfigId: 'config-a',
  providerEnabled: true,
  provider: 'openai-compatible',
  model: 'image-model',
  input: {
    capability: 'image.generate',
    image: { prompt: 'test', reference_asset_ids: [], aspect_ratio: '1:1', quality: 'standard', output_count: 1 },
  },
  status: 'queued',
  attemptCount: 0,
  providerHandle: null,
  cancellationRequestedAt: null,
  reservedCredits: 1,
  actualCredits: null,
  errorCode: null,
  errorMessage: null,
  availableAt: new Date(),
  createdAt: new Date(),
  leaseOwner: 'worker-a',
  leaseExpiresAt: new Date(),
  credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
} satisfies StudioWorkerJob;

const config = {
  providerConfigId: 'config-a',
  accountId: 'account-a',
  projectId: 'project-a',
  provider: 'openai-compatible',
  enabled: true,
  baseUrl: 'https://images.example.test',
  region: null,
  definitionId: 'openai-compatible',
  credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
  capabilityMap: {
    definition_id: 'openai-compatible',
    capabilities: {
      'image.generate': {
        models: [{
          model: 'image-model',
          pricing_catalog_id: 'pricing-a',
          dialect_profile_id: 'openai-images-v1-generic',
          supports_reference_images: false,
          allowed_advanced_fields: [],
          size_map: { '1:1': '1024x1024', '4:3': '1024x768', '3:4': '768x1024', '16:9': '1536x864', '9:16': '864x1536' },
        }],
      },
    },
  },
  versionToken: 'version-a',
} satisfies StudioWorkerProviderConfig;

const referenceAssets = { resolve: async () => [] };
const credential = { source: 'secret' as const, value: 'secret-value', version_token: 'credential-v1' };

describe('StudioProviderRegistry', () => {
  test('requires kind none for the fake adapter', async () => {
    const registry = createStudioProviderRegistry({ fakeProviderEnabled: true, openAiCompatibleEnabled: false });

    await expect(registry.resolve({ job: { ...job, provider: 'fake' }, config: { ...config, provider: 'fake', definitionId: 'fake', credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' } }, credential, referenceAssets })).resolves.toBeNull();
  });

  test('rejects disabled, wrong, unsafe, missing, and mismatched OpenAI-compatible inputs', async () => {
    const registry = createStudioProviderRegistry({ fakeProviderEnabled: false, openAiCompatibleEnabled: true });
    await expect(registry.resolve({ job, config: { ...config, enabled: false }, credential, referenceAssets })).resolves.toBeNull();
    await expect(registry.resolve({ job, config: { ...config, provider: 'different' }, credential, referenceAssets })).resolves.toBeNull();
    await expect(registry.resolve({ job, config: { ...config, baseUrl: 'http://images.example.test' }, credential, referenceAssets })).resolves.toBeNull();
    await expect(registry.resolve({ job, config, credential: null, referenceAssets })).resolves.toBeNull();
    await expect(registry.resolve({ job: { ...job, model: 'not-configured' }, config, credential, referenceAssets })).resolves.toBeNull();
  });

  test('constructs a credential-scoped OpenAI-compatible adapter without exposing a credential getter', async () => {
    const registry = createStudioProviderRegistry({ fakeProviderEnabled: false, openAiCompatibleEnabled: true });
    const adapter = await registry.resolve({ job, config, credential, referenceAssets });

    expect(adapter).toMatchObject({ id: 'openai-compatible' });
    expect(Object.keys(adapter ?? {})).not.toContain('credential');
    expect(JSON.stringify(adapter)).not.toContain(credential.value);
  });
});
