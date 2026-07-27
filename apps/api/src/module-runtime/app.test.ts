import { expect, test } from 'bun:test';

import { type ModuleRuntimeAppDependencies, createModuleRuntimeApp } from './app';
import { ModuleRunnerProtocolError } from './runner-protocol';

const RUNNER_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const EXECUTION_ID = '30000000-0000-4000-a000-000000000003';
const PROJECT_ID = '40000000-0000-4000-a000-000000000004';
const LEASE_ID = '50000000-0000-4000-a000-000000000005';

function unexpected(): never {
  throw new Error('unexpected dependency call');
}

function dependencies(input: {
  authenticateRunner: ModuleRuntimeAppDependencies['authenticateRunner'];
  registrationIdentity: ModuleRuntimeAppDependencies['registrationIdentity'];
}): ModuleRuntimeAppDependencies {
  return {
    authenticateUser: async (_context, next) => next(),
    loadProjectForUser: async () => null,
    assertProjectCapability: async () => undefined,
    executionService: {
      estimate: async () => unexpected(),
      create: async () => unexpected(),
      confirm: async () => unexpected(),
      cancel: async () => unexpected(),
      get: async () => unexpected(),
      events: async () => unexpected(),
    },
    runnerProtocol: {
      register: async () => unexpected(),
      heartbeatNode: async () => unexpected(),
      claim: async () => unexpected(),
      heartbeatLease: async () => unexpected(),
      appendEvidence: async () => unexpected(),
      finalize: async () => unexpected(),
    },
    ...input,
  };
}

test('authenticates every private Runner route before parsing JSON', async () => {
  const authenticationFailed = async (): Promise<never> => {
    throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
  };
  const app = createModuleRuntimeApp(
    dependencies({
      authenticateRunner: authenticationFailed,
      registrationIdentity: authenticationFailed,
    }),
  );

  for (const path of [
    '/module-runtime/runners/register',
    '/module-runtime/runners/heartbeat',
    '/module-runtime/claims',
    '/module-runtime/leases/heartbeat',
    '/module-runtime/evidence',
    '/module-runtime/finalize',
  ]) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'RUNNER_AUTHENTICATION_FAILED' });
  }
});

test('limits actual Runner request bytes when content-length is understated', async () => {
  const app = createModuleRuntimeApp(
    dependencies({
      authenticateRunner: async () => ({
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        certificateThumbprint: 'a'.repeat(64),
      }),
      registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
    }),
  );
  const body = JSON.stringify({ executionId: EXECUTION_ID, padding: 'x'.repeat(16 * 1024) });

  const response = await app.request('/module-runtime/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '2' },
    body,
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
});

test('forwards a lease heartbeat without a Runner-controlled deadline', async () => {
  const input = {
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    generation: 3,
  };
  let received: unknown;
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  });
  appDependencies.runnerProtocol.heartbeatLease = async (_identity, command) => {
    received = command;
    throw new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 409);
  };
  const app = createModuleRuntimeApp(appDependencies);

  const response = await app.request('/module-runtime/leases/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });

  expect(response.status).toBe(409);
  expect(received).toEqual(input);
});

test('rejects the obsolete Runner-controlled heartbeat deadline', async () => {
  let callCount = 0;
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  });
  appDependencies.runnerProtocol.heartbeatLease = async () => {
    callCount += 1;
    throw new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 409);
  };
  const app = createModuleRuntimeApp(appDependencies);

  const response = await app.request('/module-runtime/leases/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      leaseId: LEASE_ID,
      generation: 3,
      deadlineAt: '2026-07-27T09:00:00.000Z',
    }),
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
  expect(callCount).toBe(0);
});
