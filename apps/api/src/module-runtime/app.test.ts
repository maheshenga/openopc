import { expect, test } from 'bun:test';

import { type ModuleRuntimeAppDependencies, createModuleRuntimeApp } from './app';
import type { ModuleExecution } from './executions';
import { ModuleRunnerProtocolError } from './runner-protocol';

const RUNNER_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const EXECUTION_ID = '30000000-0000-4000-a000-000000000003';
const PROJECT_ID = '40000000-0000-4000-a000-000000000004';
const LEASE_ID = '50000000-0000-4000-a000-000000000005';
const INSTALLATION_ID = '60000000-0000-4000-a000-000000000006';
const USER_ID = '70000000-0000-4000-a000-000000000007';
const ARTIFACT_DIGEST =
  'sha256:cd5d4935a48c0672cb06407bb443bc0087aff947c6b864bac886982c73b3027f' as const;

function unexpected(): never {
  throw new Error('unexpected dependency call');
}

function createdExecution(): ModuleExecution {
  return {
    executionId: EXECUTION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseId: '80000000-0000-4000-a000-000000000008',
    consentRevisionId: '90000000-0000-4000-a000-000000000009',
    runtimeDescriptorId: 'a0000000-0000-4000-a000-00000000000a',
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
    state: 'dispatchable',
    idempotencyKey: 'execution-create-op-1',
    workEnvelopeDigest: `sha256:${'1'.repeat(64)}`,
    killSwitchGeneration: 0,
    deadlineAt: '2026-07-30T09:30:00.000Z',
    createdAt: '2026-07-28T01:00:00.000Z',
    updatedAt: '2026-07-28T01:00:00.000Z',
    terminalAt: null,
  };
}

function claimBundle() {
  return {
    signedEnvelope: 'e30.e30.e30',
    capabilityTokens: [],
    runtimeDescriptor: {
      descriptorVersion: 1 as const,
      runtime: {
        kind: 'wasi-component' as const,
        component: 'runtime/main.wasm',
        world: 'openopc:module/runtime',
        operation: 'run',
        imports: ['openopc:module/input', 'openopc:module/output'],
        limits: {
          cpuMillis: 10_000,
          fuel: 10_000_000,
          memoryMiB: 512,
          outputBytes: 1_048_576,
          pids: 16,
          wallTimeMs: 120_000,
        },
      },
    },
    inputBase64: 'eyJwcm9tcHQiOiJjbGFpbSJ9',
    runtimeArtifact: {
      fetchPath: 'module-runtime/artifacts/fetch' as const,
      digest: `sha256:${'8'.repeat(64)}` as const,
      bytes: 4096,
    },
  };
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
      claimNext: async () => unexpected(),
      heartbeatLease: async () => unexpected(),
      appendEvidence: async () => unexpected(),
      finalize: async () => unexpected(),
    },
    runtimeArtifactService: {
      openForLease: async () => unexpected(),
    },
    ...input,
  } as ModuleRuntimeAppDependencies;
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
    '/module-runtime/claims/next',
    '/module-runtime/artifacts/fetch',
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
  const body = JSON.stringify({ padding: 'x'.repeat(16 * 1024) });

  const response = await app.request('/module-runtime/claims/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '2' },
    body,
  });

  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
});

test('claim-next accepts only an empty object and removes caller-selected claims', async () => {
  let calls = 0;
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  });
  appDependencies.runnerProtocol.claimNext = async () => {
    calls += 1;
    return claimBundle();
  };
  const app = createModuleRuntimeApp(appDependencies);

  const unknownField = await app.request('/module-runtime/claims/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionId: EXECUTION_ID }),
  });
  const obsolete = await app.request('/module-runtime/claims', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ executionId: EXECUTION_ID }),
  });

  expect(unknownField.status).toBe(400);
  expect(await unknownField.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
  expect(obsolete.status).toBe(404);
  expect(calls).toBe(0);
});

test('claim-next returns an empty 204 or the strict execution bundle', async () => {
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  });
  appDependencies.runnerProtocol.claimNext = async () => null;
  const app = createModuleRuntimeApp(appDependencies);

  const empty = await app.request('/module-runtime/claims/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(empty.status).toBe(204);
  expect(await empty.text()).toBe('');

  const bundle = claimBundle();
  appDependencies.runnerProtocol.claimNext = async () => bundle;
  const claimed = await app.request('/module-runtime/claims/next', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(claimed.status).toBe(200);
  expect(await claimed.json()).toEqual(bundle);
});

test('claim-next preserves claimability and infrastructure error statuses', async () => {
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  });
  const app = createModuleRuntimeApp(appDependencies);

  for (const [code, status] of [
    ['RUNNER_PROFILE_UNAVAILABLE', 409],
    ['RUNNER_CLAIM_UNAVAILABLE', 503],
  ] as const) {
    appDependencies.runnerProtocol.claimNext = async () => {
      throw new ModuleRunnerProtocolError(code, status);
    };
    const response = await app.request('/module-runtime/claims/next', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  }
});

test('artifact fetch rejects ranges, unknown fields, and alternate artifact selectors', async () => {
  let calls = 0;
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  }) as ModuleRuntimeAppDependencies & {
    runtimeArtifactService: { openForLease(input: unknown): Promise<unknown> };
  };
  appDependencies.runtimeArtifactService.openForLease = async () => {
    calls += 1;
    return unexpected();
  };
  const app = createModuleRuntimeApp(appDependencies);
  const coordinates = {
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    generation: 3,
  };

  const attempts: Array<{
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [
    {
      headers: { 'content-type': 'application/json', range: 'bytes=0-3' },
      body: coordinates,
    },
    {
      headers: { 'content-type': 'application/json', range: '' },
      body: coordinates,
    },
    {
      headers: { 'content-type': 'application/json' },
      body: { ...coordinates, storageKey: 'module-runtime/artifacts/private.wasm' },
    },
    {
      headers: { 'content-type': 'application/json' },
      body: { ...coordinates, runtimeArtifactId: '60000000-0000-4000-a000-000000000006' },
    },
    {
      headers: { 'content-type': 'application/json' },
      body: { ...coordinates, path: 'runtime/main.wasm' },
    },
  ];

  for (const attempt of attempts) {
    const response = await app.request('/module-runtime/artifacts/fetch', {
      method: 'POST',
      headers: attempt.headers,
      body: JSON.stringify(attempt.body),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'RUNNER_EXECUTION_UNAVAILABLE' });
  }
  expect(calls).toBe(0);
});

test('artifact fetch forwards lease coordinates and streams only trusted metadata', async () => {
  let received: unknown;
  const artifactBytes = new Uint8Array([0, 97, 115, 109]);
  const appDependencies = dependencies({
    authenticateRunner: async () => ({
      runnerId: RUNNER_ID,
      accountId: ACCOUNT_ID,
      certificateThumbprint: 'a'.repeat(64),
    }),
    registrationIdentity: async () => ({ certificateThumbprint: 'a'.repeat(64) }),
  }) as ModuleRuntimeAppDependencies & {
    runtimeArtifactService: { openForLease(input: unknown): Promise<unknown> };
  };
  appDependencies.runtimeArtifactService.openForLease = async (input) => {
    received = input;
    return {
      digest: ARTIFACT_DIGEST,
      bytes: artifactBytes.byteLength,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(artifactBytes);
          controller.close();
        },
      }),
    };
  };
  const app = createModuleRuntimeApp(appDependencies);

  const response = await app.request('/module-runtime/artifacts/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      executionId: EXECUTION_ID,
      leaseId: LEASE_ID,
      generation: 3,
    }),
  });

  expect(received).toEqual({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    generation: 3,
    runnerId: RUNNER_ID,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/wasm');
  expect(response.headers.get('content-length')).toBe('4');
  expect(response.headers.get('x-openopc-artifact-sha256')).toBe(ARTIFACT_DIGEST);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('x-openopc-storage-key')).toBeNull();
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(artifactBytes);
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

test('forwards the exact project execution input without exposing it in the response', async () => {
  const appDependencies = dependencies({
    authenticateRunner: async () => unexpected(),
    registrationIdentity: async () => unexpected(),
  });
  appDependencies.loadProjectForUser = async () => ({
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
    userId: USER_ID,
  });
  let received: unknown;
  appDependencies.executionService.create = async (command) => {
    received = command;
    return createdExecution();
  };
  const app = createModuleRuntimeApp(appDependencies);
  const input = { prompt: 'bounded user value', count: 2 };

  const response = await app.request(`/projects/${PROJECT_ID}/module-executions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Idempotency-Key': 'execution-create-op-1',
    },
    body: JSON.stringify({
      installation_id: INSTALLATION_ID,
      deadline_at: '2026-07-30T09:30:00.000Z',
      input,
    }),
  });

  expect(response.status).toBe(201);
  expect(received).toEqual({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    actorUserId: USER_ID,
    idempotencyKey: 'execution-create-op-1',
    deadlineAt: '2026-07-30T09:30:00.000Z',
    input,
  });
  expect(await response.json()).not.toHaveProperty('input');
});

test('rejects missing, unknown, and alternate execution input transports', async () => {
  const appDependencies = dependencies({
    authenticateRunner: async () => unexpected(),
    registrationIdentity: async () => unexpected(),
  });
  let createCalls = 0;
  appDependencies.executionService.create = async () => {
    createCalls += 1;
    return createdExecution();
  };
  const app = createModuleRuntimeApp(appDependencies);
  const base = {
    installation_id: INSTALLATION_ID,
    deadline_at: '2026-07-30T09:30:00.000Z',
  };

  for (const body of [
    base,
    { ...base, input: { prompt: 'value' }, unexpected: true },
    { ...base, input_base64: 'e30' },
    { ...base, capability_tokens: [] },
    { ...base, storage_key: 'private/object/key' },
    { ...base, signed_url: 'https://storage.invalid/private' },
  ]) {
    const response = await app.request(`/projects/${PROJECT_ID}/module-executions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'execution-create-op-1',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'MODULE_EXECUTION_INPUT_INVALID' });
  }
  expect(createCalls).toBe(0);
});
