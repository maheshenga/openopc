import { describe, expect, test } from 'bun:test';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import type { DeveloperAppDependencies } from './app';
import { createDeveloperApp } from './app';
import {
  DeveloperApplicationService,
  createMemoryDeveloperApplicationRepository,
} from './applications';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const USER_ID = '20000000-0000-4000-a000-000000000001';
const POLICIES = { moduleRules: '2026-07-28', acceptableUse: '2026-07-28' } as const;

function harness() {
  const repository = createMemoryDeveloperApplicationRepository({
    members: [{ accountId: ACCOUNT_ID, userId: USER_ID }],
    createId: (() => {
      let id = 0;
      return () => `90000000-0000-4000-a000-${String(++id).padStart(12, '0')}`;
    })(),
  });
  const applicationService = new DeveloperApplicationService({
    repository,
    currentPolicyVersions: POLICIES,
    now: () => new Date('2026-07-28T08:00:00.000Z'),
  });
  const authorizations: string[] = [];
  const dependencies = {
    authenticate: async (context, next) => {
      context.set('userId', USER_ID);
      context.set('userEmail', 'developer@example.com');
      await next();
    },
    resolveAccountId: async () => ACCOUNT_ID,
    authorizeAccount: async (_context, accountId, action) => {
      expect(accountId).toBe(ACCOUNT_ID);
      authorizations.push(action);
    },
    applicationService,
    artifactService: {} as DeveloperAppDependencies['artifactService'],
    releaseService: {} as DeveloperAppDependencies['releaseService'],
    reviewService: {} as DeveloperAppDependencies['reviewService'],
    verificationService: {} as DeveloperAppDependencies['verificationService'],
    publisherService: {} as DeveloperAppDependencies['publisherService'],
  } satisfies DeveloperAppDependencies;
  const app = createDeveloperApp(dependencies);
  return { app, authorizations };
}

describe('developer application self-service routes', () => {
  test('refuses to mount without the developer application authority', () => {
    expect(() =>
      createDeveloperApp({
        authenticate: async () => undefined,
        resolveAccountId: async () => ACCOUNT_ID,
        authorizeAccount: async () => undefined,
        applicationService: undefined,
        artifactService: {},
        releaseService: {},
        reviewService: {},
        verificationService: {},
        publisherService: {},
      } as unknown as DeveloperAppDependencies),
    ).toThrow('DEVELOPER_APPLICATION_DEPENDENCY_UNAVAILABLE');
  });

  test('submits and reads the current account application through exact IAM actions', async () => {
    const { app, authorizations } = harness();
    const submitted = await app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account_id: ACCOUNT_ID,
        organization_name: 'Acme Studio',
        policy_versions: POLICIES,
      }),
    });
    const current = await app.request(`/applications/current?account_id=${ACCOUNT_ID}`);

    expect(submitted.status).toBe(201);
    expect(await submitted.json()).toEqual({
      application: expect.objectContaining({ state: 'submitted', revision: 0 }),
      created: true,
      current_policy_versions: POLICIES,
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      application: expect.objectContaining({ state: 'submitted', revision: 0 }),
      current_policy_versions: POLICIES,
    });
    expect(authorizations).toEqual([ACCOUNT_ACTIONS.ACCOUNT_WRITE, ACCOUNT_ACTIONS.ACCOUNT_READ]);
  });

  test('returns no current application without inventing authority and rejects unknown keys', async () => {
    const empty = harness();
    const current = await empty.app.request(`/applications/current?account_id=${ACCOUNT_ID}`);
    const malformed = await empty.app.request('/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_name: 'Acme Studio',
        policy_versions: POLICIES,
        grant_upload: true,
      }),
    });

    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      application: null,
      current_policy_versions: POLICIES,
    });
    expect(malformed.status).toBe(400);
  });
});
