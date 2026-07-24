import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import { type DeveloperAppDependencies, createDeveloperApp } from './app';
import {
  DeveloperModuleReleaseService,
  createMemoryDeveloperModuleReleaseRepository,
} from './releases';
import {
  DeveloperModuleReviewService,
  createMemoryDeveloperModuleReviewRepository,
} from './reviews';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';

const validModuleItem = () => ({
  name: 'recruiting-workbench',
  type: 'registry:module',
  module: {
    schemaVersion: 1,
    id: 'acme.recruiting',
    version: '1.0.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry',
    locales: ['en', 'zh-CN'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'declarative', entry: undefined as string | undefined },
    capabilities: [{ id: 'acme.recruiting.score', kind: 'task' }],
    permissions: {
      secrets: ['RECRUITING_MODEL_API_KEY'],
      network: ['https://api.example.com'],
    },
  },
});

const authenticatedApp = (
  input: {
    accountId?: string;
    releaseService?: DeveloperAppDependencies['releaseService'];
    reviewService?: DeveloperAppDependencies['reviewService'];
    resolvedSources?: Array<'body' | 'query'>;
    authorizeAccount?: DeveloperAppDependencies['authorizeAccount'];
  } = {},
) =>
  createDeveloperApp({
    authenticate: async (context, next) => {
      context.set('userId', USER_ID);
      context.set('userEmail', 'developer@example.com');
      await next();
    },
    resolveAccountId: async (_context, source) => {
      input.resolvedSources?.push(source);
      return input.accountId ?? ACCOUNT_ID;
    },
    releaseService:
      input.releaseService ??
      new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
    reviewService:
      input.reviewService ??
      new DeveloperModuleReviewService({
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
    authorizeAccount: input.authorizeAccount ?? (async () => undefined),
  });

describe('developer module validation API', () => {
  test('rejects unauthenticated validation requests', async () => {
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      releaseService: new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
      reviewService: new DeveloperModuleReviewService({
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
      authorizeAccount: async () => undefined,
    });
    const response = await app.request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'example', type: 'registry:module' }),
    });

    expect(response.status).toBe(401);
  });

  test('accepts a valid developer module manifest', async () => {
    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validModuleItem()),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ valid: true, issues: [] });
  });

  test('returns bounded issues without echoing submitted credentials', async () => {
    const item = validModuleItem();
    item.module.version = 'latest';
    item.module.execution = {
      mode: 'server-adapter',
      entry: 'https://evil.example/adapter.js',
    };
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];
    item.module.permissions.network = ['https://user:pass@example.com'];

    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    });
    const body = (await response.json()) as {
      valid: boolean;
      issues: Array<{ severity: string; path: string; message: string }>;
    };
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
    expect(body.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'item.module.version',
        'item.module.execution.entry',
        'item.module.permissions.secrets[0]',
        'item.module.permissions.network[0]',
      ]),
    );
    expect(serialized).not.toContain('sk-live-super-secret');
    expect(serialized).not.toContain('user:pass');
  });

  test('rejects a non-object registry item body', async () => {
    const response = await authenticatedApp().request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    });

    expect(response.status).toBe(400);
  });

  test('requires authentication for every release endpoint', async () => {
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      releaseService: new DeveloperModuleReleaseService({
        repository: createMemoryDeveloperModuleReleaseRepository(),
      }),
      reviewService: new DeveloperModuleReviewService({
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
      authorizeAccount: async () => undefined,
    });

    const responses = await Promise.all([
      app.request('/modules/releases', { method: 'POST', body: '{}' }),
      app.request('/modules/releases'),
      app.request('/modules/releases/30000000-0000-4000-a000-000000000003'),
      app.request('/modules/releases/30000000-0000-4000-a000-000000000003/review-requests', {
        method: 'POST',
        body: '{}',
      }),
      app.request('/modules/releases/30000000-0000-4000-a000-000000000003/review-history'),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
  });

  test('does not mount platform-admin distribution actions on the developer app', async () => {
    const app = authenticatedApp();
    const releasePath = '/modules/releases/30000000-0000-4000-a000-000000000003';

    const responses = await Promise.all([
      app.request(`${releasePath}/sign`, { method: 'POST', body: '{}' }),
      app.request(`${releasePath}/publish`, { method: 'POST', body: '{}' }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });

  test('applies account write/read IAM after resolution while validation stays account independent', async () => {
    const actions: string[] = [];
    const app = authenticatedApp({
      authorizeAccount: async (_context, accountId, action) => {
        expect(accountId).toBe(ACCOUNT_ID);
        actions.push(action);
      },
    });

    const validation = await app.request('/modules/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validModuleItem()),
    });
    const submitted = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });
    const releaseId = ((await submitted.json()) as { release: { release_id: string } }).release
      .release_id;
    await app.request(`/modules/releases?account_id=${ACCOUNT_ID}`);
    await app.request(`/modules/releases/${releaseId}?account_id=${ACCOUNT_ID}`);

    expect(validation.status).toBe(200);
    expect(actions).toEqual([
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_READ,
      ACCOUNT_ACTIONS.ACCOUNT_READ,
    ]);
  });

  test('resolves the canonical account before authorization and mutation', async () => {
    const order: string[] = [];
    const delegate = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const app = createDeveloperApp({
      authenticate: async (context, next) => {
        context.set('userId', USER_ID);
        context.set('userEmail', 'developer@example.com');
        await next();
      },
      resolveAccountId: async () => {
        order.push('resolve');
        return ACCOUNT_ID;
      },
      authorizeAccount: async () => {
        order.push('authorize');
      },
      releaseService: {
        async submit(input) {
          order.push('submit');
          return delegate.submit(input);
        },
        async list() {
          return [];
        },
        async get() {
          throw new Error('unused');
        },
      },
      reviewService: new DeveloperModuleReviewService({
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
    });

    const response = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: validModuleItem() }),
    });
    expect(response.status).toBe(201);
    expect(order).toEqual(['resolve', 'authorize', 'submit']);
  });

  test('requires account write permission for submissions and review requests', async () => {
    const releaseService = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const seeded = await releaseService.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const reviewService = new DeveloperModuleReviewService({
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({
      releaseService,
      reviewService,
      authorizeAccount: async (_context, _accountId, action) => {
        if (action === ACCOUNT_ACTIONS.ACCOUNT_WRITE) {
          throw new HTTPException(403, { message: 'Forbidden' });
        }
      },
    });

    const submission = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: validModuleItem() }),
    });
    const review = await app.request(
      `/modules/releases/${seeded.release.release_id}/review-requests`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_status: 'validated', expected_revision: 0 }),
      },
    );

    expect(submission.status).toBe(403);
    expect(review.status).toBe(403);
    expect(
      (await reviewService.adminGet({ releaseId: seeded.release.release_id })).release,
    ).toEqual(expect.objectContaining({ status: 'validated', review_revision: 0 }));
  });

  test('requests review and returns account-scoped immutable history', async () => {
    const releaseService = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const seeded = await releaseService.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const reviewService = new DeveloperModuleReviewService({
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({ releaseService, reviewService });

    const requested = await app.request(
      `/modules/releases/${seeded.release.release_id}/review-requests`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          expected_status: 'validated',
          expected_revision: 0,
          reason: 'Ready for review',
        }),
      },
    );
    const history = await app.request(
      `/modules/releases/${seeded.release.release_id}/review-history?account_id=${ACCOUNT_ID}`,
    );

    expect(requested.status).toBe(201);
    expect(await requested.json()).toEqual({
      release: expect.objectContaining({ status: 'review_pending', review_revision: 1 }),
      event: expect.objectContaining({ action: 'submit', sequence: 1 }),
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toEqual({
      history: [expect.objectContaining({ action: 'submit', sequence: 1 })],
    });
  });

  test('rejects malformed, stale, and cross-account review requests with code-only errors', async () => {
    const releaseService = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const seeded = await releaseService.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const reviewService = new DeveloperModuleReviewService({
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({ releaseService, reviewService });
    const path = `/modules/releases/${seeded.release.release_id}/review-requests`;

    const malformed = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_status: 'validated', expected_revision: 0, extra: true }),
    });
    const stale = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_status: 'validated', expected_revision: 9 }),
    });
    const other = authenticatedApp({ accountId: OTHER_ACCOUNT_ID, releaseService, reviewService });
    const crossAccount = await other.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_status: 'validated', expected_revision: 0 }),
    });

    expect(malformed.status).toBe(400);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'DEVELOPER_REVIEW_CONFLICT' });
    expect(crossAccount.status).toBe(404);
    expect(await crossAccount.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
  });

  test('submits, lists and reads account-scoped validated releases', async () => {
    const resolvedSources: Array<'body' | 'query'> = [];
    const app = authenticatedApp({ resolvedSources });

    const submitted = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });
    const submission = (await submitted.json()) as {
      created: boolean;
      release: { release_id: string; status: string; account_id: string };
    };
    const listed = await app.request(`/modules/releases?account_id=${ACCOUNT_ID}&limit=20`);
    const fetched = await app.request(
      `/modules/releases/${submission.release.release_id}?account_id=${ACCOUNT_ID}`,
    );

    expect(submitted.status).toBe(201);
    expect(submission).toEqual(
      expect.objectContaining({
        created: true,
        release: expect.objectContaining({ status: 'validated', account_id: ACCOUNT_ID }),
      }),
    );
    expect(listed.status).toBe(200);
    expect((await listed.json()) as unknown).toEqual(
      expect.objectContaining({ releases: [expect.objectContaining({ account_id: ACCOUNT_ID })] }),
    );
    expect(fetched.status).toBe(200);
    expect(resolvedSources).toEqual(['body', 'query', 'query']);
  });

  test('returns safe errors for invalid submissions without credential echo', async () => {
    const app = authenticatedApp();
    const item = validModuleItem();
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];

    const response = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('DEVELOPER_MODULE_INVALID');
    expect(body).not.toContain('sk-live-super-secret');
  });

  test('returns 404 instead of exposing another account release', async () => {
    const releaseService = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const ownerApp = authenticatedApp({ accountId: ACCOUNT_ID, releaseService });
    const otherApp = authenticatedApp({ accountId: OTHER_ACCOUNT_ID, releaseService });
    const submitted = await ownerApp.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item: validModuleItem() }),
    });
    const body = (await submitted.json()) as { release: { release_id: string } };

    const response = await otherApp.request(`/modules/releases/${body.release.release_id}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
  });
});
