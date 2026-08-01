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
    schemaVersion: 2,
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
  manifest_digest: `sha256:${'a'.repeat(64)}`,
  artifact_id: '50000000-0000-4000-a000-000000000005',
  artifact_digest: `sha256:${'c'.repeat(64)}`,
  sbom_digest: null,
  trust_attestation_digest: null,
  verification_policy_digest: null,
  runtime_descriptor_digest: null,
  runtime_descriptor_path: null,
  runtime_kind: null,
  review_requirements: ['manifest_review'],
  status: 'published',
  review_revision: 4,
  signature_algorithm: 'ed25519',
  signature_key_id: 'platform-2026',
  signature: `base64url:${'a'.repeat(86)}` as `base64url:${string}`,
  signature_payload_digest: `sha256:${'b'.repeat(64)}`,
  signed_at: '2026-07-24T00:00:00.000Z',
  published_at: '2026-07-24T00:00:00.000Z',
  revoked_at: null,
  created_by: '30000000-0000-4000-a000-000000000003',
  created_at: '2026-07-24T00:00:00.000Z',
  updated_at: '2026-07-24T00:00:00.000Z',
  ...input,
});

describe('developer module marketplace adapter', () => {
  test('exposes only published signed eligible releases as marketplace items', async () => {
    const published = release();
    const adapter = createDeveloperModuleMarketplaceAdapter({
      listPublished: async () => ({
        releases: [
          published,
          release({ release_id: 'review-pending', status: 'review_pending' }),
          release({ release_id: 'revoked', status: 'revoked' }),
          release({ release_id: 'unsigned', signature: null }),
          release({
            release_id: 'unsupported',
            manifest: { ...published.manifest, execution: { mode: 'agent', entry: 'agent' } },
          }),
        ],
        total: 5,
      }),
      getPublished: async () => published,
    });
    const page = await adapter.list({ limit: 20, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]).toEqual(
      expect.objectContaining({
        id: 'openopc-module:40000000-0000-4000-a000-000000000004',
        registry: 'openopc-modules',
        type: 'registry:module',
        title: 'recruiting-workbench',
        marketplaceId: 'openopc-modules',
        fileCount: 0,
        categories: ['industry'],
        capabilities: {
          secrets: ['RECRUITING_MODEL_API_KEY'],
          connectors: ['crm'],
          tools: [],
          network: ['https://api.example.com'],
        },
        manifest: published.manifest,
      }),
    );
  });

  test('projects v3 catalog labels and keeps executable artifacts private', async () => {
    const v3 = release({
      release_id: 'v3',
      module_id: 'acme.forecast',
      manifest: {
        schemaVersion: 3,
        id: 'acme.forecast',
        version: '1.0.0',
        publisher: { id: 'acme', displayName: 'Acme' },
        locales: ['en'],
        compatibility: { platform: '^1.0.0' },
        execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
        verification: { profile: 'sandboxed-web' },
        openopc: { sdkApiVersion: 'v1', catalog: { labels: ['h5', 'weather'] } },
      },
    });
    const adapter = createDeveloperModuleMarketplaceAdapter({
      listPublished: async () => ({ releases: [v3], total: 1 }),
      getPublished: async () => v3,
    });
    const page = await adapter.list({ query: 'weather', limit: 20, offset: 0 });
    expect(page.items).toEqual([
      expect.objectContaining({ release_id: 'v3', categories: ['h5', 'weather'] }),
    ]);
    const firstItem = page.items[0];
    expect(firstItem).toBeDefined();
    await expect(adapter.getFile(firstItem?.id ?? '', 'dist/index.html')).resolves.toBeNull();
  });

  test('supports deterministic search and exposes public release metadata without files', async () => {
    const first = release();
    const second = release({
      release_id: '40000000-0000-4000-a000-000000000005',
      item_name: 'hr-onboarding',
      module_id: 'acme.onboarding',
      module_version: '2.0.0',
      manifest: { ...first.manifest, id: 'acme.onboarding', version: '2.0.0', capabilities: [] },
    });
    const adapter = createDeveloperModuleMarketplaceAdapter({
      listPublished: async () => ({ releases: [second, first], total: 2 }),
      getPublished: async ({ releaseId }) => (releaseId === second.release_id ? second : first),
    });
    expect(
      (await adapter.list({ query: 'onboarding', limit: 20, offset: 0 })).items.map(
        (item) => item.id,
      ),
    ).toEqual(['openopc-module:40000000-0000-4000-a000-000000000005']);
    const detail = await adapter.get('openopc-module:40000000-0000-4000-a000-000000000004');
    expect(detail).toEqual(
      expect.objectContaining({
        files: [],
        release_id: first.release_id,
        permissions: expect.objectContaining({ secrets: ['RECRUITING_MODEL_API_KEY'] }),
      }),
    );
  });

  test('is empty when developer distribution is disabled', async () => {
    const adapter = createDeveloperModuleMarketplaceAdapter(null);
    expect(await adapter.list({ limit: 20, offset: 0 })).toEqual({ items: [], total: 0 });
    expect(await adapter.get('openopc-module:40000000-0000-4000-a000-000000000004')).toBeNull();
  });
});
