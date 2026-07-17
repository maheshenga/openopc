import { describe, expect, test } from 'bun:test';
import type { StudioProviderConfigWire } from '../studio/types';
import { createProjectCapabilityRegistry } from './capability-registry';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const PROVIDER_ID = '13000000-0000-4000-a000-000000000001';

const provider: StudioProviderConfigWire = {
  provider_config_id: PROVIDER_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  provider: 'fake',
  display_name: 'Fake images',
  base_url: null,
  region: null,
  credential_binding: { kind: 'none' },
  capabilities: ['image.generate'],
  enabled: true,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
};

function repository() {
  return {
    listProviders: async () => [provider],
    getProviderConfigRecord: async () => null,
  };
}

describe('project capability registry', () => {
  test('maps an executable Studio provider to a redaction-safe descriptor', async () => {
    const registry = createProjectCapabilityRegistry({
      repository: repository(),
      isStorageReady: async () => true,
    });

    const items = await registry.list(PROJECT_ID, { accountId: ACCOUNT_ID, userId: 'user-1' });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'studio.image.generate',
      version: '1.0.0',
      modality: 'image',
      operation: 'generate',
      execution: 'async',
      risk: 'write',
      provenance_required: true,
    });
    expect(JSON.stringify(items)).not.toContain('fake/image-v1');
  });

  test('fails closed when storage is unavailable or credentials are not usable', async () => {
    const unavailable = createProjectCapabilityRegistry({
      repository: repository(),
      isStorageReady: async () => false,
    });
    expect(await unavailable.list(PROJECT_ID, { accountId: ACCOUNT_ID, userId: 'user-1' })).toEqual(
      [],
    );

    const credentialProvider: StudioProviderConfigWire = {
      ...provider,
      provider: 'openai-compatible',
      credential_binding: { kind: 'connector', slug: 'images' } as const,
    };
    const credentialRegistry = createProjectCapabilityRegistry({
      repository: {
        listProviders: async () => [credentialProvider],
        getProviderConfigRecord: async () => ({
          ...credentialProvider,
          capability_map: {},
          version_token: 'v1',
        }),
      },
      isStorageReady: async () => true,
      credentialBindingExists: async () => false,
    });
    expect(
      await credentialRegistry.list(PROJECT_ID, { accountId: ACCOUNT_ID, userId: 'user-1' }),
    ).toEqual([]);
  });
});
