import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { RegistryItem, RegistryModuleManifest } from '@kortix/registry';
import { HTTPException } from 'hono/http-exception';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import { ReleaseProfileUnavailableError } from '../release-profile/runtime';
import { RESTRICTED_RUNTIME_TEST_PROFILE } from '../release-profile/test-fixtures';
import { type DeveloperAppDependencies, createDeveloperApp } from './app';
import {
  DeveloperApplicationService,
  createMemoryDeveloperApplicationRepository,
} from './applications';
import {
  DeveloperModuleArtifactService,
  createMemoryDeveloperArtifactStore,
  createMemoryDeveloperModuleArtifactRepository,
  serializeDeveloperModuleArtifactPackage,
} from './artifacts';
import { DeveloperPublisherService, createMemoryDeveloperPublisherRepository } from './publishers';
import {
  DeveloperModuleReleaseService,
  createMemoryDeveloperModuleReleaseRepository,
} from './releases';
import {
  DeveloperModuleReviewService,
  createMemoryDeveloperModuleReviewRepository,
} from './reviews';
import {
  DeveloperModuleVerificationError,
  DeveloperModuleVerificationService,
  createMemoryDeveloperModuleVerificationRepository,
} from './verification';

const testPermissions = {
  async requirePermission() {
    return {} as never;
  },
};

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';

type ValidModuleItem = RegistryItem & {
  type: 'registry:module';
  module: RegistryModuleManifest & {
    permissions: NonNullable<RegistryModuleManifest['permissions']>;
  };
};

const validModuleItem = (): ValidModuleItem => ({
  name: 'recruiting-workbench',
  type: 'registry:module',
  module: {
    schemaVersion: 2,
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

function emptyVerificationService() {
  return new DeveloperModuleVerificationService({
    repository: createMemoryDeveloperModuleVerificationRepository(),
    currentPolicy: {
      policyDigest: `sha256:${'b'.repeat(64)}`,
      scannerSetDigest: `sha256:${'c'.repeat(64)}`,
      sandboxProfileDigest: `sha256:${'d'.repeat(64)}`,
    },
  });
}

function emptyPublisherService() {
  return new DeveloperPublisherService({
    repository: createMemoryDeveloperPublisherRepository(),
  });
}

function emptyApplicationService() {
  return new DeveloperApplicationService({
    repository: createMemoryDeveloperApplicationRepository(),
    currentPolicyVersions: { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' },
  });
}

const authenticatedApp = (
  input: {
    accountId?: string;
    artifactService?: DeveloperAppDependencies['artifactService'];
    releaseService?: DeveloperAppDependencies['releaseService'];
    authenticate?: DeveloperAppDependencies['authenticate'];
    reviewService?: DeveloperAppDependencies['reviewService'];
    verificationService?: DeveloperAppDependencies['verificationService'];
    publisherService?: DeveloperAppDependencies['publisherService'];
    resolvedSources?: Array<'body' | 'query'>;
    authorizeAccount?: DeveloperAppDependencies['authorizeAccount'];
    applicationService?: DeveloperAppDependencies['applicationService'];
  } = {},
) => {
  const artifacts = createMemoryDeveloperModuleArtifactRepository();
  const artifactService = new DeveloperModuleArtifactService({
    repository: artifacts,
    store: createMemoryDeveloperArtifactStore().store,
    codeModulesEnabled: true,
    trustInfrastructureReady: async () => true,
  });
  return createDeveloperApp({
    authenticate:
      input.authenticate ??
      (async (context, next) => {
        context.set('userId', USER_ID);
        context.set('userEmail', 'developer@example.com');
        await next();
      }),
    resolveAccountId: async (_context, source) => {
      input.resolvedSources?.push(source);
      return input.accountId ?? ACCOUNT_ID;
    },
    applicationService: input.applicationService ?? emptyApplicationService(),
    artifactService: input.artifactService ?? artifactService,
    releaseService:
      input.releaseService ??
      new DeveloperModuleReleaseService({
        runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
        repository: createMemoryDeveloperModuleReleaseRepository(),
        artifacts,
      }),
    reviewService:
      input.reviewService ??
      new DeveloperModuleReviewService({
    permissions: testPermissions,
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
    verificationService: input.verificationService ?? emptyVerificationService(),
    publisherService: input.publisherService ?? emptyPublisherService(),
    authorizeAccount: input.authorizeAccount ?? (async () => undefined),
  });
};

type DeveloperTestApp = ReturnType<typeof authenticatedApp>;

async function createArtifactRequest(
  app: DeveloperTestApp,
  item = validModuleItem(),
  accountId = ACCOUNT_ID,
) {
  return app.request('/modules/artifacts/declarative', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, item }),
  });
}

async function submitReleaseRequest(
  app: DeveloperTestApp,
  item = validModuleItem(),
  accountId = ACCOUNT_ID,
) {
  const artifactResponse = await createArtifactRequest(app, item, accountId);
  const artifact = (await artifactResponse.json()) as { artifact_id: string };
  return app.request('/modules/releases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, artifact_id: artifact.artifact_id }),
  });
}

async function seededReleaseFixture() {
  const artifacts = createMemoryDeveloperModuleArtifactRepository();
  const artifactService = new DeveloperModuleArtifactService({
    repository: artifacts,
    store: createMemoryDeveloperArtifactStore().store,
  });
  const artifact = await artifactService.createDeclarative({
    accountId: ACCOUNT_ID,
    actorUserId: USER_ID,
    item: validModuleItem(),
  });
  const releaseService = new DeveloperModuleReleaseService({
    runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
    repository: createMemoryDeveloperModuleReleaseRepository(),
    artifacts,
  });
  const seeded = await releaseService.submit({
    accountId: ACCOUNT_ID,
    actorUserId: USER_ID,
    artifactId: artifact.artifact_id,
  });
  return { artifacts, artifact, artifactService, releaseService, seeded };
}

describe('developer module validation API', () => {
  test('maps release service network-policy failures to the stable 400 response', async () => {
    const response = await authenticatedApp({
      releaseService: {
        async submit() {
          throw new DeveloperModuleVerificationError('DEVELOPER_VERIFICATION_RESULT_INVALID', 400);
        },
      } as never,
    }).request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: '40000000-0000-4000-a000-000000000004' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'DEVELOPER_VERIFICATION_RESULT_INVALID' });
  });

  test('maps release-profile service failures to the stable 503 response', async () => {
    const response = await authenticatedApp({
      artifactService: {
        async createDeclarative() {
          throw new ReleaseProfileUnavailableError('module.oci.execute');
        },
      } as never,
    }).request('/modules/artifacts/declarative', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.oci.execute',
    });
  });

  test('rejects unauthenticated validation requests', async () => {
    const artifacts = createMemoryDeveloperModuleArtifactRepository();
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      applicationService: emptyApplicationService(),
      artifactService: new DeveloperModuleArtifactService({
        repository: artifacts,
        store: createMemoryDeveloperArtifactStore().store,
      }),
      releaseService: new DeveloperModuleReleaseService({
        runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
        repository: createMemoryDeveloperModuleReleaseRepository(),
        artifacts,
      }),
      reviewService: new DeveloperModuleReviewService({
    permissions: testPermissions,
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
      verificationService: emptyVerificationService(),
      publisherService: emptyPublisherService(),
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
    const artifacts = createMemoryDeveloperModuleArtifactRepository();
    const app = createDeveloperApp({
      authenticate: async () => {
        throw new HTTPException(401, { message: 'Unauthorized' });
      },
      resolveAccountId: async () => ACCOUNT_ID,
      applicationService: emptyApplicationService(),
      artifactService: new DeveloperModuleArtifactService({
        repository: artifacts,
        store: createMemoryDeveloperArtifactStore().store,
      }),
      releaseService: new DeveloperModuleReleaseService({
        runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
        repository: createMemoryDeveloperModuleReleaseRepository(),
        artifacts,
      }),
      reviewService: new DeveloperModuleReviewService({
    permissions: testPermissions,
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
      verificationService: emptyVerificationService(),
      publisherService: emptyPublisherService(),
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
    const submitted = await submitReleaseRequest(app);
    const releaseId = ((await submitted.json()) as { release: { release_id: string } }).release
      .release_id;
    await app.request(`/modules/releases?account_id=${ACCOUNT_ID}`);
    await app.request(`/modules/releases/${releaseId}?account_id=${ACCOUNT_ID}`);

    expect(validation.status).toBe(200);
    expect(actions).toEqual([
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_READ,
      ACCOUNT_ACTIONS.ACCOUNT_READ,
    ]);
  });

  test('resolves the canonical account before authorization and mutation', async () => {
    const order: string[] = [];
    const artifacts = createMemoryDeveloperModuleArtifactRepository();
    const artifactService = new DeveloperModuleArtifactService({
      repository: artifacts,
      store: createMemoryDeveloperArtifactStore().store,
    });
    const artifact = await artifactService.createDeclarative({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const delegate = new DeveloperModuleReleaseService({
      runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
      repository: createMemoryDeveloperModuleReleaseRepository(),
      artifacts,
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
      applicationService: emptyApplicationService(),
      artifactService,
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
    permissions: testPermissions,
        repository: createMemoryDeveloperModuleReviewRepository(),
      }),
      verificationService: emptyVerificationService(),
      publisherService: emptyPublisherService(),
    });

    const response = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: artifact.artifact_id }),
    });
    expect(response.status).toBe(201);
    expect(order).toEqual(['resolve', 'authorize', 'submit']);
  });

  test('requires account write permission for submissions and review requests', async () => {
    const { artifact, artifactService, releaseService, seeded } = await seededReleaseFixture();
    const reviewService = new DeveloperModuleReviewService({
    permissions: testPermissions,
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({
      artifactService,
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
      body: JSON.stringify({ artifact_id: artifact.artifact_id }),
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
    const { artifactService, releaseService, seeded } = await seededReleaseFixture();
    const reviewService = new DeveloperModuleReviewService({
    permissions: testPermissions,
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({ artifactService, releaseService, reviewService });

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
    const { artifactService, releaseService, seeded } = await seededReleaseFixture();
    const reviewService = new DeveloperModuleReviewService({
    permissions: testPermissions,
      repository: createMemoryDeveloperModuleReviewRepository({ releases: [seeded.release] }),
    });
    const app = authenticatedApp({ artifactService, releaseService, reviewService });
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
    const other = authenticatedApp({
      accountId: OTHER_ACCOUNT_ID,
      artifactService,
      releaseService,
      reviewService,
    });
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

    const submitted = await submitReleaseRequest(app);
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
    expect(resolvedSources).toEqual(['body', 'body', 'query', 'query']);
  });

  test('returns safe errors for invalid submissions without credential echo', async () => {
    const app = authenticatedApp();
    const item = validModuleItem();
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];

    const response = await app.request('/modules/artifacts/declarative', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ item }),
    });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain('DEVELOPER_ARTIFACT_INVALID');
    expect(body).not.toContain('sk-live-super-secret');
  });

  test('returns 404 instead of exposing another account artifact or release', async () => {
    const { artifact, artifactService, releaseService } = await seededReleaseFixture();
    const ownerApp = authenticatedApp({ accountId: ACCOUNT_ID, artifactService, releaseService });
    const otherApp = authenticatedApp({
      accountId: OTHER_ACCOUNT_ID,
      artifactService,
      releaseService,
    });
    const submitted = await ownerApp.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_id: artifact.artifact_id }),
    });
    const body = (await submitted.json()) as { release: { release_id: string } };

    const artifactResponse = await otherApp.request(
      `/modules/artifacts/${artifact.artifact_id}?account_id=${OTHER_ACCOUNT_ID}`,
    );
    const releaseResponse = await otherApp.request(`/modules/releases/${body.release.release_id}`);

    expect(artifactResponse.status).toBe(404);
    expect(await artifactResponse.json()).toEqual({ error: 'DEVELOPER_ARTIFACT_NOT_FOUND' });
    expect(releaseResponse.status).toBe(404);
    expect(await releaseResponse.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
  });
});

describe('developer module artifact API', () => {
  test('creates a declarative artifact and rejects legacy raw-item release submission', async () => {
    const app = authenticatedApp();
    const artifact = await app.request('/modules/artifacts/declarative', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });
    const rawRelease = await app.request('/modules/releases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, item: validModuleItem() }),
    });

    expect(artifact.status).toBe(201);
    expect(await artifact.json()).toEqual(
      expect.objectContaining({
        artifact_id: expect.any(String),
        artifact_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      }),
    );
    expect(rawRelease.status).toBe(503);
    expect(await rawRelease.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'artifact.remote-url',
    });
  });

  test('rejects legacy, remote, and OCI release payloads before developer HTTP side effects', async () => {
    const calls = {
      authenticate: 0,
      authorizeAccount: 0,
      artifactService: 0,
      releaseService: 0,
    };
    const resolvedSources: Array<'body' | 'query'> = [];
    const app = authenticatedApp({
      authenticate: async () => {
        calls.authenticate += 1;
      },
      resolvedSources,
      authorizeAccount: async () => {
        calls.authorizeAccount += 1;
      },
      artifactService: {
        async createDeclarative() {
          calls.artifactService += 1;
          throw new Error('artifact service must not run');
        },
      } as never,
      releaseService: {
        async submit() {
          calls.releaseService += 1;
          throw new Error('release service must not run');
        },
      } as never,
    });
    const ociItem = validModuleItem();
    (ociItem as unknown as { runtime: { kind: string } }).runtime = { kind: 'oci-image' };
    const requests = [
      { body: { account_id: ACCOUNT_ID, item: validModuleItem() }, capability: 'artifact.remote-url' },
      {
        body: { account_id: ACCOUNT_ID, artifact_url: 'https://untrusted.example/module.tgz' },
        capability: 'artifact.remote-url',
      },
      { body: { account_id: ACCOUNT_ID, item: ociItem }, capability: 'module.oci.execute' },
    ] as const;

    for (const { body, capability } of requests) {
      const response = await app.request('/modules/releases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
        capability,
      });
      expect(calls).toEqual({
        authenticate: 0,
        authorizeAccount: 0,
        artifactService: 0,
        releaseService: 0,
      });
      expect(resolvedSources).toEqual([]);
    }
  });

  test('creates, finalizes, reads, and cancels uploads with idempotent HTTP status and IAM', async () => {
    const artifacts = createMemoryDeveloperModuleArtifactRepository();
    const memoryStore = createMemoryDeveloperArtifactStore();
    const artifactService = new DeveloperModuleArtifactService({
      repository: artifacts,
      store: memoryStore.store,
      codeModulesEnabled: true,
      trustInfrastructureReady: async () => true,
    });
    const actions: string[] = [];
    const app = authenticatedApp({
      artifactService,
      releaseService: new DeveloperModuleReleaseService({
        runtime: RESTRICTED_RUNTIME_TEST_PROFILE,
        repository: createMemoryDeveloperModuleReleaseRepository(),
        artifacts,
      }),
      authorizeAccount: async (_context, accountId, action) => {
        expect(accountId).toBe(ACCOUNT_ID);
        actions.push(action);
      },
    });
    const bytes = serializeDeveloperModuleArtifactPackage({ item: validModuleItem() });
    const expectedDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const createUpload = () =>
      app.request('/modules/artifact-uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          account_id: ACCOUNT_ID,
          publisher_id: 'acme',
          expected_size: bytes.byteLength,
          expected_digest: expectedDigest,
        }),
      });

    const uploadResponse = await createUpload();
    const upload = (await uploadResponse.json()) as {
      upload_id: string;
      upload_url: string;
      headers: Record<string, string>;
    };
    await memoryStore.upload(upload.upload_url, bytes, upload.headers);
    const finalizePath = `/modules/artifact-uploads/${upload.upload_id}/finalize`;
    const first = await app.request(finalizePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });
    const artifact = (await first.json()) as { artifact_id: string };
    const second = await app.request(finalizePath, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });
    const fetched = await app.request(
      `/modules/artifacts/${artifact.artifact_id}?account_id=${ACCOUNT_ID}`,
    );

    const cancelledUploadResponse = await createUpload();
    const cancelledUpload = (await cancelledUploadResponse.json()) as { upload_id: string };
    const cancelled = await app.request(
      `/modules/artifact-uploads/${cancelledUpload.upload_id}?account_id=${ACCOUNT_ID}`,
      { method: 'DELETE' },
    );

    expect(uploadResponse.status).toBe(201);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(
      expect.objectContaining({ artifact_id: artifact.artifact_id }),
    );
    expect(fetched.status).toBe(200);
    expect(cancelledUploadResponse.status).toBe(201);
    expect(cancelled.status).toBe(204);
    expect(actions).toEqual([
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_READ,
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
      ACCOUNT_ACTIONS.ACCOUNT_WRITE,
    ]);
  });

  test('reads and retries verification through the publisher account boundary', async () => {
    const repository = createMemoryDeveloperModuleVerificationRepository({
      releases: [
        {
          releaseId: '30000000-0000-4000-a000-000000000003',
          accountId: ACCOUNT_ID,
          artifactId: '40000000-0000-4000-a000-000000000004',
          artifactDigest: `sha256:${'a'.repeat(64)}`,
          mediaType: 'application/vnd.openopc.developer-module.v2+json',
          sizeBytes: 256,
          sourceProvenance: null,
          createdAt: '2026-07-25T00:00:00.000Z',
        },
      ],
    });
    const policy = {
      policyDigest: `sha256:${'b'.repeat(64)}` as const,
      scannerSetDigest: `sha256:${'c'.repeat(64)}` as const,
      sandboxProfileDigest: `sha256:${'d'.repeat(64)}` as const,
    };
    await repository.enqueue({
      releaseId: '30000000-0000-4000-a000-000000000003',
      accountId: ACCOUNT_ID,
      artifactId: '40000000-0000-4000-a000-000000000004',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      ...policy,
    });
    const verificationService = new DeveloperModuleVerificationService({
      repository,
      currentPolicy: policy,
    });
    const actions: string[] = [];
    const app = authenticatedApp({
      verificationService,
      authorizeAccount: async (_context, _accountId, action) => {
        actions.push(action);
      },
    });
    const path = '/modules/releases/30000000-0000-4000-a000-000000000003';

    const trust = await app.request(`${path}/trust?account_id=${ACCOUNT_ID}`);
    await repository.cancel({
      releaseId: '30000000-0000-4000-a000-000000000003',
      accountId: ACCOUNT_ID,
      reason: 'cancelled for route test',
    });
    const retry = await app.request(`${path}/verification-retries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID }),
    });
    const otherAccount = authenticatedApp({
      accountId: OTHER_ACCOUNT_ID,
      verificationService,
    });
    const hidden = await otherAccount.request(`${path}/trust?account_id=${OTHER_ACCOUNT_ID}`);
    const hiddenRetry = await otherAccount.request(`${path}/verification-retries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: OTHER_ACCOUNT_ID }),
    });

    expect(trust.status).toBe(200);
    expect(await trust.json()).toEqual(
      expect.objectContaining({
        release_id: '30000000-0000-4000-a000-000000000003',
        attempts: [expect.objectContaining({ state: 'queued', attempt: 1 })],
      }),
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(expect.objectContaining({ state: 'queued', attempt: 2 }));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
    expect(hiddenRetry.status).toBe(404);
    expect(await hiddenRetry.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
    expect(actions).toEqual([ACCOUNT_ACTIONS.ACCOUNT_READ, ACCOUNT_ACTIONS.ACCOUNT_WRITE]);
  });
});

describe('developer Publisher API', () => {
  test('accepts invitations, creates and lists a Publisher, and revision-fences roles', async () => {
    const organizationId = '30000000-0000-4000-a000-000000000003';
    const targetUserId = '20000000-0000-4000-a000-000000000004';
    const repository = createMemoryDeveloperPublisherRepository({
      organizations: [
        {
          organization_id: organizationId,
          account_id: ACCOUNT_ID,
          name: 'Acme Studio',
          verification_state: 'verified',
          verification_metadata: {},
          verification_revision: 1,
          verification_changed_by: targetUserId,
          verification_changed_at: '2026-07-26T00:00:00.000Z',
          created_by: USER_ID,
          created_at: '2026-07-26T00:00:00.000Z',
          updated_at: '2026-07-26T00:00:00.000Z',
        },
      ],
      applicationStates: [{ accountId: ACCOUNT_ID, organizationId, state: 'approved' }],
    });
    const publisherService = new DeveloperPublisherService({
      repository,
      now: () => new Date('2026-07-26T01:00:00.000Z'),
      createToken: () => 'public-route-invitation-token',
    });
    const invited = await publisherService.invite({
      actor: {
        accountId: ACCOUNT_ID,
        userId: targetUserId,
        email: 'admin@example.com',
        platformAdmin: true,
      },
      accountId: ACCOUNT_ID,
      organizationId,
      organizationName: 'Acme Studio',
      email: 'developer@example.com',
    });
    const app = authenticatedApp({ publisherService });

    const accepted = await app.request('/invitations/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: ACCOUNT_ID, token: invited.token }),
    });
    const created = await app.request('/publishers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        organization_id: organizationId,
        slug: 'Acme-Labs',
        display_name: 'Acme Labs',
      }),
    });
    const role = await app.request(`/publishers/acme-labs/members/${targetUserId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        role: 'release_manager',
        expected_revision: null,
      }),
    });
    const access = await app.request(`/access?account_id=${ACCOUNT_ID}`);
    const listed = await app.request(`/publishers?account_id=${ACCOUNT_ID}`);

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual(expect.objectContaining({ state: 'accepted' }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      publisher: expect.objectContaining({ publisher_id: 'acme-labs' }),
      organization: expect.objectContaining({ organization_id: organizationId }),
      member: expect.objectContaining({ user_id: USER_ID, role: 'owner' }),
    });
    expect(role.status).toBe(201);
    expect(await role.json()).toEqual(
      expect.objectContaining({ user_id: targetUserId, role: 'release_manager', revision: 0 }),
    );
    expect(access.status).toBe(200);
    expect(await access.json()).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        publishers: [
          expect.objectContaining({
            publisher: expect.objectContaining({ publisher_id: 'acme-labs' }),
            membership: expect.objectContaining({ role: 'owner' }),
          }),
        ],
      }),
    );
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      publishers: [expect.objectContaining({ publisher_id: 'acme-labs' })],
    });
  });
});
