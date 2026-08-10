import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import type { DeveloperModuleRelease } from '../developer/releases';

let authCalls = 0;

interface TestAuthContext {
  set(name: 'user', value: { id: string; email: string }): void;
}

mock.module('../middleware/auth', () => ({
  supabaseAuth: async (c: TestAuthContext, next: () => Promise<void>) => {
    authCalls += 1;
    c.set('user', {
      id: '00000000-0000-4000-a000-000000000001',
      email: 'marketplace-http@example.test',
    });
    await next();
  },
}));

mock.module('../marketplace/sources-store', () => ({
  listSources: async () => [],
  addSource: async () => ({
    id: 'source-test',
    address: 'example/test',
    addedAt: '2026-07-24T00:00:00.000Z',
  }),
  removeSource: async () => true,
}));

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

describe('marketplace HTTP contract', () => {
  beforeAll(async () => {
    process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
    process.env.INTERNAL_KORTIX_ENV = 'dev';
    process.env.RECALL_BASE_URL = 'http://127.0.0.1:54322';
    process.env.FRONTEND_URL = 'http://127.0.0.1:3000';
    process.env.ALLOWED_SANDBOX_PROVIDERS = '';
    process.env.KORTIX_DEFAULT_MARKETPLACES = '';
    process.env.KORTIX_MARKETPLACE_REGISTRIES = '';
    const { registerDeveloperModuleMarketplaceSource } = await import('../marketplace/developer-modules');
    const releaseId = '40000000-0000-4000-a000-000000000004';
    const moduleRelease: DeveloperModuleRelease = {
      release_id: releaseId,
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
        locales: ['en'],
        compatibility: { platform: '^1.0.0' },
        execution: { mode: 'declarative' },
        capabilities: [{ id: 'acme.recruiting.score', kind: 'task' }],
        permissions: { connectors: ['crm'] },
      },
      manifest_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      artifact_id: '50000000-0000-4000-a000-000000000005',
      artifact_digest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
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
      signature_payload_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      signed_at: '2026-07-24T00:00:00.000Z',
      published_at: '2026-07-24T00:00:00.000Z',
      revoked_at: null,
      created_by: '30000000-0000-4000-a000-000000000003',
      created_at: '2026-07-24T00:00:00.000Z',
      updated_at: '2026-07-24T00:00:00.000Z',
    };
    registerDeveloperModuleMarketplaceSource({
      listPublished: async () => ({ releases: [moduleRelease], total: 1 }),
      getPublished: async () => moduleRelease,
    });
    const { marketplaceApp } = await import('../marketplace');
    const app = new Hono();
    app.route('/v1/marketplace', marketplaceApp);
    server = Bun.serve({ port: 0, fetch: app.fetch });
    baseUrl = `http://${server.hostname}:${server.port}/v1`;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test('GET /marketplace/items surfaces the starter project + its skills; managed kortix-* skills stay internal', async () => {
    const res = await fetch(`${baseUrl}/marketplace/items?source=kortix`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; name: string; type: string; managedBy?: string; partOfProject?: { id: string; title: string } }> };

    // Kortix-managed system skills (kortix-computer/executor/memory/slack/system/
    // marketplace/meet/onboarding) are server-injected platform floor now — they
    // never show up as browse-and-install cards.
    expect(body.items.some((item) => item.managedBy === 'kortix')).toBe(false);
    for (const name of ['kortix-computer', 'kortix-executor', 'kortix-memory', 'kortix-slack', 'kortix-system']) {
      expect(body.items.find((item) => item.name === name)).toBeUndefined();
    }

    // Browse leads with the "OpenOPC Starter" project AND lists the individual
    // kortix-starter skills (agent-browser, pdf, …) as their own top-level
    // tiles again — each one carries a `partOfProject` badge back to the project.
    expect(body.items.find((item) => item.id === 'kortix-projects:starter')).toBeTruthy();
    const agentBrowser = body.items.find((item) => item.name === 'agent-browser');
    expect(agentBrowser).toBeTruthy();
    expect(agentBrowser?.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'OpenOPC Starter' });
    expect(body.items.find((item) => item.name === 'pdf')).toBeTruthy();
    expect(body.items.find((item) => item.name === 'pty')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'web_search')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'kortix')).toBeUndefined();
    expect(body.items.find((item) => item.name === 'memory-reflector')).toBeUndefined();
  });

  test('GET /marketplace/items is public read-only', async () => {
    authCalls = 0;
    const res = await fetch(`${baseUrl}/marketplace/items?query=agent-browser&source=kortix`);
    expect(res.status).toBe(200);
    const body = await res.json() as { items: Array<{ id: string; name: string; type: string }> };
    expect(body.items).toContainEqual(
      expect.objectContaining({ id: 'kortix-starter:agent-browser', type: 'registry:skill' }),
    );
    expect(authCalls).toBe(0);
  });

  test('GET /marketplace/sources still requires auth middleware', async () => {
    authCalls = 0;
    const res = await fetch(`${baseUrl}/marketplace/sources`);
    // The test auth middleware accepts when it runs; this pins that source
    // management still passes through auth instead of staying public.
    expect(res.status).not.toBe(404);
    expect(authCalls).toBeGreaterThan(0);
  });

  test('GET /marketplace/items/:id exposes the starter project detail and its skills; managed system skills stay unreachable', async () => {
    const detail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-projects:starter')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(detail.status).toBe(200);
    const body = await detail.json() as {
      name: string;
      type: string;
      dependencyItems: Array<{ name: string; type: string }>;
      files: Array<{ target: string; type: string }>;
      readme: string | null;
    };

    expect(body.name).toBe('starter');
    expect(body.type).toBe('registry:project');
    // The "what's inside" list resolves the kortix-starter skills, typed.
    expect(body.dependencyItems.some((d) => d.name === 'pdf')).toBe(true);

    // A starter skill is also reachable as its own browse-and-install card, at
    // its own id, badged back to the project it also ships inside of.
    const skillDetail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-starter:agent-browser')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(skillDetail.status).toBe(200);
    const skillBody = await skillDetail.json() as {
      name: string;
      type: string;
      partOfProject?: { id: string; title: string };
    };
    expect(skillBody.name).toBe('agent-browser');
    expect(skillBody.type).toBe('registry:skill');
    expect(skillBody.partOfProject).toEqual({ id: 'kortix-projects:starter', title: 'OpenOPC Starter' });

    // Kortix-managed system skills are server-injected platform truth — never a
    // browse-and-detail card, even by a hand-built id.
    const managed = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent('kortix-starter:kortix-system')}`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(managed.status).toBe(404);
  });

  test('GET /marketplace/items honors a limit of 120 (below the 200 clamp ceiling)', async () => {
    const res = await fetch(`${baseUrl}/marketplace/items?source=kortix&limit=120&offset=0`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; total: number };
    // Fewer kortix items exist than 120, so this pins that the full available
    // set came back — i.e. the request wasn't clamped down below its total.
    expect(body.items.length).toBe(body.total);
    expect(body.items.length).toBeGreaterThan(0);
  });

  test('GET /marketplace/items exposes published declarative modules and keeps file preview closed', async () => {
    const list = await fetch(`${baseUrl}/marketplace/items?source=openopc-modules`, {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(list.status).toBe(200);
    const body = await list.json() as { items: Array<{ id: string; type: string; fileCount: number }> };
    expect(body.items).toEqual([
      expect.objectContaining({
        id: 'openopc-module:40000000-0000-4000-a000-000000000004',
        type: 'registry:module',
        fileCount: 0,
      }),
    ]);

    const detail = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent(body.items[0].id)}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json() as {
      release_id: string;
      files: unknown[];
      permissions: { connectors: string[] };
      signature: { key_id: string };
    };
    expect(detailBody.release_id).toBe('40000000-0000-4000-a000-000000000004');
    expect(detailBody.files).toEqual([]);
    expect(detailBody.permissions.connectors).toEqual(['crm']);
    expect(detailBody.signature.key_id).toBe('platform-2026');

    const file = await fetch(`${baseUrl}/marketplace/items/${encodeURIComponent(body.items[0].id)}/file?path=README.md`);
    expect(file.status).toBe(404);
  });
});
