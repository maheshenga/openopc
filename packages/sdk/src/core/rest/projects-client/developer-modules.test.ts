import { beforeEach, expect, mock, test } from 'bun:test';

import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import {
  type DeveloperModuleRelease,
  acceptDeveloperInvitation,
  cancelDeveloperModuleArtifactUpload,
  createDeclarativeDeveloperModuleArtifact,
  createDeveloperModuleArtifactUpload,
  createDeveloperPublisher,
  finalizeDeveloperModuleArtifactUpload,
  getDeveloperAccess,
  getDeveloperModuleArtifact,
  getDeveloperModuleRelease,
  getDeveloperModuleReviewHistory,
  getDeveloperModuleTrust,
  listDeveloperModuleReleases,
  listDeveloperPublishers,
  requestDeveloperModuleReview,
  retryDeveloperModuleVerification,
  submitDeveloperModuleRelease,
  updateDeveloperPublisherMember,
  validateDeveloperModule,
} from './developer-modules';

let calls: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify({ valid: true, issues: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

test('validateDeveloperModule posts one registry item to the Developer Center API', async () => {
  const item = {
    name: 'recruiting-workbench',
    type: 'registry:module',
    module: { schemaVersion: 1, id: 'acme.recruiting' },
  };

  await expect(validateDeveloperModule(item)).resolves.toEqual({ valid: true, issues: [] });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toEqual({
    url: 'http://test.local/developer/modules/validate',
    method: 'POST',
    body: item,
  });
});

test('createKortix exposes developer module validation', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  await expect(
    kortix.developer.modules.validate({ name: 'example', type: 'registry:module' }),
  ).resolves.toEqual({ valid: true, issues: [] });
});

test('developer Publisher SDK maps access, invitation, creation, list, and role updates', async () => {
  await getDeveloperAccess({ accountId: 'acc-1' });
  await acceptDeveloperInvitation('one-time-token', { accountId: 'acc-1' });
  await createDeveloperPublisher({
    accountId: 'acc-1',
    organizationId: 'org-1',
    slug: 'acme',
    displayName: 'Acme',
  });
  await listDeveloperPublishers({ accountId: 'acc-1' });
  await updateDeveloperPublisherMember('publisher/with slash', 'user with slash', {
    accountId: 'acc-1',
    role: 'release_manager',
    expectedRevision: 2,
  });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/access?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/invitations/accept',
      method: 'POST',
      body: { account_id: 'acc-1', token: 'one-time-token' },
    },
    {
      url: 'http://test.local/developer/publishers',
      method: 'POST',
      body: {
        account_id: 'acc-1',
        organization_id: 'org-1',
        slug: 'acme',
        display_name: 'Acme',
      },
    },
    {
      url: 'http://test.local/developer/publishers?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/publishers/publisher%2Fwith%20slash/members/user%20with%20slash',
      method: 'PUT',
      body: { account_id: 'acc-1', role: 'release_manager', expected_revision: 2 },
    },
  ]);
});

test('createKortix exposes the developer Publisher facade', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  await kortix.developer.getAccess({ accountId: 'acc-1' });
  await kortix.developer.acceptInvitation('one-time-token', { accountId: 'acc-1' });
  await kortix.developer.publishers.create({
    organizationId: 'org-1',
    slug: 'acme',
    displayName: 'Acme',
  });
  await kortix.developer.publishers.list();
  await kortix.developer.publishers.updateMember('acme', 'user-1', {
    role: 'developer',
    expectedRevision: null,
  });

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/developer/access?account_id=acc-1',
    'http://test.local/developer/invitations/accept',
    'http://test.local/developer/publishers',
    'http://test.local/developer/publishers',
    'http://test.local/developer/publishers/acme/members/user-1',
  ]);
});

test('developer module release SDK submits only an artifact id, then sends scoped list and get requests', async () => {
  await submitDeveloperModuleRelease({ artifactId: 'artifact-1', accountId: 'acc-1' });
  await listDeveloperModuleReleases({ accountId: 'acc-1', limit: 20 });
  await getDeveloperModuleRelease('release-1', { accountId: 'acc-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/modules/releases',
      method: 'POST',
      body: { account_id: 'acc-1', artifact_id: 'artifact-1' },
    },
    {
      url: 'http://test.local/developer/modules/releases?account_id=acc-1&limit=20',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/modules/releases/release-1?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
  ]);
});

test('developer module artifact SDK covers declarative and package upload lifecycles', async () => {
  const item = { name: 'example', type: 'registry:module' };
  const digest = `sha256:${'a'.repeat(64)}` as const;

  await createDeclarativeDeveloperModuleArtifact(item, { accountId: 'acc-1' });
  await createDeveloperModuleArtifactUpload({
    accountId: 'acc-1',
    publisherId: 'acme',
    expectedSize: 42,
    expectedDigest: digest,
  });
  await finalizeDeveloperModuleArtifactUpload('upload/1', { accountId: 'acc-1' });
  await cancelDeveloperModuleArtifactUpload('upload/1', { accountId: 'acc-1' });
  await getDeveloperModuleArtifact('artifact/1', { accountId: 'acc-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/modules/artifacts/declarative',
      method: 'POST',
      body: { account_id: 'acc-1', item },
    },
    {
      url: 'http://test.local/developer/modules/artifact-uploads',
      method: 'POST',
      body: {
        account_id: 'acc-1',
        publisher_id: 'acme',
        expected_size: 42,
        expected_digest: digest,
      },
    },
    {
      url: 'http://test.local/developer/modules/artifact-uploads/upload%2F1/finalize',
      method: 'POST',
      body: { account_id: 'acc-1' },
    },
    {
      url: 'http://test.local/developer/modules/artifact-uploads/upload%2F1?account_id=acc-1',
      method: 'DELETE',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/modules/artifacts/artifact%2F1?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
  ]);
});

test('developer module trust SDK reads safe evidence and retries through account scope', async () => {
  await getDeveloperModuleTrust('release/1', { accountId: 'acc-1' });
  await retryDeveloperModuleVerification('release/1', { accountId: 'acc-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/modules/releases/release%2F1/trust?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
    {
      url: 'http://test.local/developer/modules/releases/release%2F1/verification-retries',
      method: 'POST',
      body: { account_id: 'acc-1' },
    },
  ]);
});

test('developer module release transport preserves public signature metadata', async () => {
  const release: DeveloperModuleRelease = {
    release_id: 'release-1',
    account_id: 'account-1',
    item_name: 'example',
    publisher_id: 'publisher-1',
    module_id: 'example.module',
    module_version: '1.0.0',
    manifest: { compatibility: { platform: '^1.0.0' } },
    manifest_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    artifact_id: 'artifact-1',
    artifact_digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sbom_digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    trust_attestation_digest:
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    verification_policy_digest:
      'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    review_requirements: ['manifest_review'],
    status: 'published',
    review_revision: 4,
    signature_algorithm: 'ed25519',
    signature_key_id: 'openopc-2026',
    signature: 'base64url:public-signature',
    signature_payload_digest:
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    signed_at: '2026-07-24T12:00:00.000Z',
    published_at: '2026-07-24T12:01:00.000Z',
    revoked_at: null,
    created_by: 'user-1',
    created_at: '2026-07-24T11:00:00.000Z',
    updated_at: '2026-07-24T12:01:00.000Z',
  };
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(release), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;

  await expect(getDeveloperModuleRelease('release-1')).resolves.toEqual(release);
  expect(release).not.toHaveProperty('private_key');
});

test('createKortix exposes the developer module release facade', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  await kortix.developer.modules.artifacts.createDeclarative(
    { name: 'example', type: 'registry:module' },
    { accountId: 'acc-1' },
  );
  await kortix.developer.modules.releases.submit({ artifactId: 'artifact-1', accountId: 'acc-1' });
  await kortix.developer.modules.releases.list({ accountId: 'acc-1', limit: 10 });
  await kortix.developer.modules.releases.get('release-1', { accountId: 'acc-1' });
  await kortix.developer.modules.releases.trust('release-1', { accountId: 'acc-1' });
  await kortix.developer.modules.releases.retryVerification('release-1', {
    accountId: 'acc-1',
  });

  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/developer/modules/artifacts/declarative',
    'http://test.local/developer/modules/releases',
    'http://test.local/developer/modules/releases?account_id=acc-1&limit=10',
    'http://test.local/developer/modules/releases/release-1?account_id=acc-1',
    'http://test.local/developer/modules/releases/release-1/trust?account_id=acc-1',
    'http://test.local/developer/modules/releases/release-1/verification-retries',
  ]);
});

test('developer module review SDK sends encoded account-scoped request and history calls', async () => {
  await requestDeveloperModuleReview('release/with slash', {
    accountId: 'acc-1',
    expectedStatus: 'validated',
    expectedRevision: 0,
    reason: 'Ready for review',
  });
  await getDeveloperModuleReviewHistory('release/with slash', { accountId: 'acc-1' });

  expect(calls).toEqual([
    {
      url: 'http://test.local/developer/modules/releases/release%2Fwith%20slash/review-requests',
      method: 'POST',
      body: {
        account_id: 'acc-1',
        expected_status: 'validated',
        expected_revision: 0,
        reason: 'Ready for review',
      },
    },
    {
      url: 'http://test.local/developer/modules/releases/release%2Fwith%20slash/review-history?account_id=acc-1',
      method: 'GET',
      body: undefined,
    },
  ]);
});

test('createKortix exposes requestReview and reviewHistory without removing release methods', async () => {
  const kortix = createKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });

  await kortix.developer.modules.releases.requestReview('release-1', {
    expectedStatus: 'changes_requested',
    expectedRevision: 2,
    reason: 'Addressed the requested changes.',
  });
  await kortix.developer.modules.releases.reviewHistory('release-1', { accountId: 'acc-1' });

  expect(typeof kortix.developer.modules.releases.submit).toBe('function');
  expect(typeof kortix.developer.modules.releases.list).toBe('function');
  expect(typeof kortix.developer.modules.releases.get).toBe('function');
  expect(calls.map((call) => call.url)).toEqual([
    'http://test.local/developer/modules/releases/release-1/review-requests',
    'http://test.local/developer/modules/releases/release-1/review-history?account_id=acc-1',
  ]);
});
