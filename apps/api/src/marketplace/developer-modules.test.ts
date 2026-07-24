import { describe, expect, test } from 'bun:test';

import type { DeveloperModuleRelease } from '../developer/releases';
import { createDeveloperModuleMarketplaceAdapter } from './developer-modules';

const release = (input: Partial<DeveloperModuleRelease> = {}): DeveloperModuleRelease => ({
  release_id: '40000000-0000-4000-a000-000000000004',
  account_id: '20000000-0000-4000-a000-000000000002',
  item_name: 'recruiting-workbench',
  publisher_id: 'acme',
  module_id: 'acme.recruiting',
  module_version: '1.0.0',
  manifest: {
    schemaVersion: 1,
    id: 'acme.recruiting',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry',
    locales: ['en', 'zh-CN'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'declarative' },
    capabilities: [{ id: 'acme.recruiting.score', kind: 'task', inputSchema: { type: 'object' } }],
    permissions: {
      secrets: ['RECRUITING_MODEL_API_KEY'],
      network: ['https://api.example.com'],
      connectors: ['crm'],
    },
  },
  manifest_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  review_requirements: ['manifest_review'],
  status: 'published',
  review_revision: 4,
  signature_algorithm: 'ed25519',
  signature_key_id: 'platform-2026',
  signature: `base64url:${'a'.repeat(86)}` as `base64url:${string}`,
  signature_payload_digest:
    'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  signed_at: '2026-07-24T00:00:00.000Z',
  published_at: '2026-07-24T00:00:00.000Z',
  revoked_at: null,
  created_by: '30000000-0000-4000-a000-000000000003',
  created_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
  ...input,
});

describe('developer module marketplace adapter', () => {
  test('exposes only published signed declarative releases as marketplace items', async () => {
    const published = release();
    const adapter = createDeveloperModuleMarketplaceAdapter({
      listPublished: async () => ({
        releases: [
          published,
          release({ release_id: '40000000-0000-4000-a000-000000000005', status: 'revoked' }),
          release({
            release_id: '40000000-0000-4000-a000-000000000006',
            status: 'published',
            signature: null,
          }),
          release({
            release_id: '40000000-0000-4000-a000-000000000007',
            status: 'published',
            manifest: {
              ...published.manifest,
              execution: { mode: 'server-adapter', entry: 'adapter' },
            },
          }),
        ],
        total: 4,
      }),
      getPublished: async () => published,
    });

    const page = await adapter.list({ limit: 20, offset: 0 });

    expect(page.total).toBe(1);
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'openopc-module:40000000-0000-4000-a000-000000000004',
        registry: 'openopc-modules',
        type: 'registry:module',
        title: 'recruiting-workbench',
        marketplaceId: 'openopc-modules',
        fileCount: 0,
        capabilities: {
          secrets: ['RECRUITING_MODEL_API_KEY'],
          connectors: ['crm'],
          tools: [],
          network: ['https://api.example.com'],
        },
      }),
    ]);
  });

  test('supports deterministic search and exposes public release metadata without files', async () => {
    const first = release();
    const second = release({
      release_id: '40000000-0000-4000-a000-000000000005',
      item_name: 'hr-onboarding',
      module_id: 'acme.onboarding',
      module_version: '2.0.0',
      manifest: {
        ...first.manifest,
        id: 'acme.onboarding',
        version: '2.0.0',
        capabilities: [],
      },
    });
    const adapter = createDeveloperModuleMarketplaceAdapter({
      listPublished: async () => ({ releases: [second, first], total: 2 }),
      getPublished: async ({ releaseId }) => (releaseId === second.release_id ? second : first),
    });

    const page = await adapter.list({ query: 'onboarding', limit: 20, offset: 0 });
    expect(page.items.map((item) => item.id)).toEqual([
      'openopc-module:40000000-0000-4000-a000-000000000005',
    ]);

    const detail = await adapter.get('openopc-module:40000000-0000-4000-a000-000000000004');
    expect(detail).toEqual(
      expect.objectContaining({
        id: 'openopc-module:40000000-0000-4000-a000-000000000004',
        files: [],
        release_id: first.release_id,
        module_version: '1.0.0',
        publisher_id: 'acme',
        permissions: expect.objectContaining({
          secrets: ['RECRUITING_MODEL_API_KEY'],
          connectors: ['crm'],
        }),
        signature: expect.objectContaining({ algorithm: 'ed25519', key_id: 'platform-2026' }),
      }),
    );
    expect(
      await adapter.getFile('openopc-module:40000000-0000-4000-a000-000000000004', 'README.md'),
    ).toBeNull();
  });

  test('is empty when developer distribution is disabled', async () => {
    const adapter = createDeveloperModuleMarketplaceAdapter(null);
    expect(await adapter.list({ limit: 20, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(await adapter.get('openopc-module:40000000-0000-4000-a000-000000000004')).toBeNull();
  });
});
