import { describe, expect, test } from 'bun:test';
import { createStudioSubmissionAuthorization } from './authorization';
import { createMemoryStudioWorkerRepository } from './memory-repository';

describe('Studio submission authorization', () => {
  test('revalidates active token, both Studio actions, and the Secret grant', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      actorType: 'agent',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
      agentName: 'image-agent',
      sessionId: 'session-image',
      credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
    });
    const actions: string[] = [];
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        status: 'active',
        revokedAt: null,
        expiresAt: null,
        projectId: job.projectId,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: job.sessionId,
        serviceAccountId: null,
        agentGrant: {
          agent: 'image-agent',
          kortixCli: ['project.studio.jobs.run', 'project.studio.providers.use'],
          connectors: [],
          env: ['image_provider'],
        },
      }),
      validateCredentialBinding: async () => true,
      authorizeProjectAction: async ({ action }) => {
        actions.push(action);
        return true;
      },
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(await authorization.revalidate(job)).toEqual({ authorized: true });
    expect(actions).toEqual(['project.studio.jobs.run', 'project.studio.providers.use']);
  });

  test('allows an account-wide human PAT whose project scope is null', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      actorType: 'user',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
    });
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        status: 'active',
        revokedAt: null,
        expiresAt: null,
        projectId: null,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: null,
        serviceAccountId: null,
        agentGrant: null,
      }),
      authorizeProjectAction: async () => true,
    });

    expect(await authorization.revalidate(job)).toEqual({ authorized: true });
  });

  test('rejects an Agent token whose persisted session no longer matches the job', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      actorType: 'agent',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
      agentName: 'image-agent',
      sessionId: 'session-a',
    });
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        status: 'active',
        revokedAt: null,
        expiresAt: null,
        projectId: job.projectId,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: 'session-b',
        serviceAccountId: null,
        agentGrant: {
          agent: 'image-agent',
          kortixCli: ['project.studio.jobs.run', 'project.studio.providers.use'],
          connectors: [],
          env: [],
        },
      }),
      authorizeProjectAction: async () => true,
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_TOKEN_SCOPE_REVOKED',
    });
  });

  test('denies an expired direct Service Account before IAM evaluation', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const serviceAccountId = '33333333-3333-4333-8333-333333333333';
    const job = repository.seedJob({
      actorType: 'system',
      actorUserId: serviceAccountId,
      actingTokenId: null,
    });
    let actionCalls = 0;
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => null,
      loadServiceAccount: async () => ({
        status: 'active',
        expiresAt: new Date('2026-07-15T09:59:59.000Z'),
        accountId: job.accountId,
        projectId: null,
        agentName: null,
      }),
      authorizeProjectAction: async () => {
        actionCalls += 1;
        return true;
      },
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_SERVICE_ACCOUNT_REVOKED',
    });
    expect(actionCalls).toBe(0);
  });

  test('rejects a malformed credential binding before IAM or provider access', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ credentialBinding: { identifier: 'MISSING_KIND' } });
    let actionCalls = 0;
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => null,
      authorizeProjectAction: async () => {
        actionCalls += 1;
        return true;
      },
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_PROVIDER_CONFIG_INVALID',
    });
    expect(actionCalls).toBe(0);
  });

  test('rejects an inactive or cross-tenant provider credential before IAM', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      credentialBinding: { kind: 'secret', identifier: 'IMAGE_PROVIDER' },
    });
    let actionCalls = 0;
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => null,
      validateCredentialBinding: async () => false,
      authorizeProjectAction: async () => {
        actionCalls += 1;
        return true;
      },
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_PROVIDER_CREDENTIAL_UNAVAILABLE',
    });
    expect(actionCalls).toBe(0);
  });

  test('invalidates cached IAM for both launcher and standing Service Account', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const standingServiceAccountId = '33333333-3333-4333-8333-333333333333';
    const job = repository.seedJob({
      actorType: 'agent',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
      agentName: 'image-agent',
      sessionId: 'session-image',
    });
    const invalidated: string[][] = [];
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        status: 'active',
        revokedAt: null,
        expiresAt: null,
        projectId: job.projectId,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: job.sessionId,
        serviceAccountId: standingServiceAccountId,
        agentGrant: {
          agent: 'image-agent',
          kortixCli: ['project.studio.jobs.run', 'project.studio.providers.use'],
          connectors: [],
          env: [],
        },
      }),
      loadServiceAccount: async () => ({
        status: 'active',
        expiresAt: null,
        accountId: job.accountId,
        projectId: job.projectId,
        agentName: 'image-agent',
      }),
      invalidateAuthorizationCache: async (principalIds) => {
        invalidated.push(principalIds);
      },
      authorizeProjectAction: async () => true,
    });

    expect(await authorization.revalidate(job)).toEqual({ authorized: true });
    expect(invalidated).toEqual([[job.actorUserId ?? '', standingServiceAccountId]]);
  });

  test.each([
    [
      'revoked token',
      { status: 'revoked', revokedAt: new Date(), expiresAt: null },
      'STUDIO_TOKEN_REVOKED',
    ],
    [
      'expired token',
      { status: 'active', revokedAt: null, expiresAt: new Date('2026-07-15T09:59:59.000Z') },
      'STUDIO_TOKEN_EXPIRED',
    ],
  ])('denies a %s before IAM evaluation', async (_label, lifecycle, code) => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ actingTokenId: '11111111-1111-4111-8111-111111111111' });
    let authorizationCalls = 0;
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        ...lifecycle,
        projectId: job.projectId,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: null,
        serviceAccountId: null,
        agentGrant: null,
      }),
      authorizeProjectAction: async () => {
        authorizationCalls += 1;
        return true;
      },
      now: () => new Date('2026-07-15T10:00:00.000Z'),
    });

    expect(await authorization.revalidate(job)).toMatchObject({ authorized: false, code });
    expect(authorizationCalls).toBe(0);
  });

  test('denies a missing Studio action or credential grant', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      actorType: 'agent',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
      credentialBinding: { kind: 'connector', slug: 'aliyun-media' },
      sessionId: 'session-image',
    });
    const token = {
      status: 'active',
      revokedAt: null,
      expiresAt: null,
      projectId: job.projectId,
      accountId: job.accountId,
      userId: job.actorUserId ?? '',
      sessionId: job.sessionId,
      serviceAccountId: null,
      agentGrant: {
        agent: 'image-agent',
        kortixCli: ['project.studio.jobs.run'],
        connectors: [],
        env: [] as string[],
      },
    };
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => token,
      validateCredentialBinding: async () => true,
      authorizeProjectAction: async () => true,
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_AGENT_GRANT_REVOKED',
    });
  });

  test('cancels a queued job when its provider configuration was disabled', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({ providerEnabled: false } as never);
    let actionCalls = 0;
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => null,
      authorizeProjectAction: async () => {
        actionCalls += 1;
        return true;
      },
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_PROVIDER_UNAVAILABLE',
    });
    expect(actionCalls).toBe(0);
  });

  test('fails closed when an Agent token loses or changes its Agent grant', async () => {
    const repository = createMemoryStudioWorkerRepository();
    const job = repository.seedJob({
      actorType: 'agent',
      actingTokenId: '11111111-1111-4111-8111-111111111111',
      agentName: 'image-agent',
      sessionId: 'session-image',
    });
    const authorization = createStudioSubmissionAuthorization({
      loadToken: async () => ({
        status: 'active',
        revokedAt: null,
        expiresAt: null,
        projectId: job.projectId,
        accountId: job.accountId,
        userId: job.actorUserId ?? '',
        sessionId: job.sessionId,
        serviceAccountId: null,
        agentGrant: null,
      }),
      authorizeProjectAction: async () => true,
    });

    expect(await authorization.revalidate(job)).toMatchObject({
      authorized: false,
      code: 'STUDIO_AGENT_GRANT_REVOKED',
    });
  });
});
