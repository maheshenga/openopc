import { expect, test } from 'bun:test';

import {
  type ModuleExecution,
  type ModuleExecutionBinding,
  computeModuleExecutionBindingDigest,
  createMemoryModuleExecutionRepository,
} from './executions';
import {
  type ModuleRunnerIdentity,
  ModuleRunnerProtocol,
  createMemoryModuleRunnerRepository,
  hashCapabilityToken,
} from './runner-protocol';

const NOW = '2026-07-27T08:00:00.000Z';
const RUNNER_ID = '90000000-0000-4000-8000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-8000-000000000001';
const PROJECT_ID = '30000000-0000-4000-8000-000000000001';

const identity: ModuleRunnerIdentity = {
  runnerId: RUNNER_ID,
  accountId: ACCOUNT_ID,
  certificateThumbprint: 'a'.repeat(64),
};

function dispatchableExecution(): ModuleExecution {
  return {
    executionId: '10000000-0000-4000-8000-000000000001',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: '40000000-0000-4000-8000-000000000001',
    releaseId: '50000000-0000-4000-8000-000000000001',
    consentRevisionId: '60000000-0000-4000-8000-000000000001',
    runtimeDescriptorId: '70000000-0000-4000-8000-000000000001',
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    state: 'dispatchable',
    idempotencyKey: 'execution-op-1',
    workEnvelopeDigest: `sha256:${'1'.repeat(64)}`,
    killSwitchGeneration: 0,
    deadlineAt: '2026-07-27T09:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
  };
}

function ociBinding(execution: ModuleExecution): ModuleExecutionBinding {
  return {
    accountId: execution.accountId,
    projectId: execution.projectId,
    installationId: execution.installationId,
    installRevision: 1,
    releaseId: execution.releaseId,
    releaseDigest: `sha256:${'2'.repeat(64)}`,
    consentRevisionId: execution.consentRevisionId,
    permissionDigest: `sha256:${'3'.repeat(64)}`,
    policyDigest: `sha256:${'4'.repeat(64)}`,
    runtimeDescriptorId: execution.runtimeDescriptorId,
    runtimeDescriptorDigest: `sha256:${'5'.repeat(64)}`,
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    killSwitchGeneration: execution.killSwitchGeneration,
    resourceCeilings: {
      cpuMillis: 10_000,
      memoryMiB: 512,
      wallTimeMs: 120_000,
      costMicro: 0,
    },
    confirmationRequired: false,
  };
}

test('Runner cannot claim an unsupported profile', async () => {
  const execution = dispatchableExecution();
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-wasi-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [
          {
            profileName: 'openopc-wasi-v1',
            runtimeKind: 'wasi-component',
          },
        ],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => ociBinding(execution) },
    now: () => new Date(NOW),
  });

  await expect(
    protocol.claim(identity, { executionId: execution.executionId }),
  ).rejects.toMatchObject({ code: 'RUNNER_PROFILE_UNAVAILABLE' });
  expect(await executionRepository.findDispatchable(execution.executionId)).not.toBeNull();
});

test('claim binds immutable execution state and every capability token into the signed envelope', async () => {
  const execution = dispatchableExecution();
  const binding = ociBinding(execution);
  execution.workEnvelopeDigest = await computeModuleExecutionBindingDigest(
    binding,
    execution.deadlineAt,
  );
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-oci-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [{ profileName: binding.runtimeProfile, runtimeKind: binding.runtimeKind }],
        updatedAt: NOW,
      },
    ],
  });
  let signedTraceparent: string | undefined;
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => binding },
    capabilityIssuer: {
      issueForClaim: async () => [
        {
          grantId: 'a0000000-0000-4000-8000-000000000001',
          audience: 'egress',
          token: 'runner-secret-capability-token',
          expiresAt: '2026-07-27T08:00:30.000Z',
        },
      ],
    },
    envelopeSigner: {
      sign: async (envelope, metadata) => {
        signedTraceparent = metadata.traceparent;
        return JSON.stringify(envelope);
      },
    },
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
  });

  const claim = await protocol.claim(identity, { executionId: execution.executionId });
  const envelope = JSON.parse(claim.signedEnvelope);

  expect(claim.capabilityTokens).toEqual([
    {
      grantId: 'a0000000-0000-4000-8000-000000000001',
      audience: 'egress',
      token: 'runner-secret-capability-token',
    },
  ]);
  expect(envelope).toEqual({
    envelopeVersion: 1,
    executionId: '10000000-0000-4000-8000-000000000001',
    accountId: '20000000-0000-4000-8000-000000000001',
    projectId: '30000000-0000-4000-8000-000000000001',
    installationId: '40000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-op-1',
    installRevision: 1,
    releaseId: '50000000-0000-4000-8000-000000000001',
    releaseDigest: `sha256:${'2'.repeat(64)}`,
    consentRevisionId: '60000000-0000-4000-8000-000000000001',
    permissionDigest: `sha256:${'3'.repeat(64)}`,
    runtimeDescriptorId: '70000000-0000-4000-8000-000000000001',
    runtimeDescriptorDigest: `sha256:${'5'.repeat(64)}`,
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    policyDigest: `sha256:${'4'.repeat(64)}`,
    killSwitchGeneration: 0,
    executionDeadline: '2026-07-27T09:00:00.000Z',
    bindingDigest: 'sha256:6f1da6296afd1a6ea52b67bd17625ead5dee47efd49299dabd6364456e37126a',
    resourceCeilings: {
      cpuMillis: 10_000,
      memoryMiB: 512,
      wallTimeMs: 120_000,
      costMicro: 0,
    },
    lease: {
      id: '80000000-0000-4000-8000-000000000001',
      generation: 1,
      deadline: '2026-07-27T08:00:30.000Z',
    },
    grants: [
      {
        id: 'a0000000-0000-4000-8000-000000000001',
        audience: 'openopc:capability/egress',
        tokenHash: 'sha256:7dbd11f524a0e4325ab3942b773ebbe52a0590dbd0bcfe1c343f7bc6c4f1039a',
      },
    ],
  });
  expect(envelope.grants).toEqual([
    {
      id: 'a0000000-0000-4000-8000-000000000001',
      audience: 'openopc:capability/egress',
      tokenHash: hashCapabilityToken('runner-secret-capability-token'),
    },
  ]);
  expect(envelope.lease).toEqual({
    id: '80000000-0000-4000-8000-000000000001',
    generation: 1,
    deadline: '2026-07-27T08:00:30.000Z',
  });
  expect(signedTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

test('claim releases its lease when envelope signing fails before delivery', async () => {
  const execution = dispatchableExecution();
  const binding = ociBinding(execution);
  execution.workEnvelopeDigest = await computeModuleExecutionBindingDigest(
    binding,
    execution.deadlineAt,
  );
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-oci-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [{ profileName: binding.runtimeProfile, runtimeKind: binding.runtimeKind }],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => binding },
    capabilityIssuer: { issueForClaim: async () => [] },
    envelopeSigner: {
      sign: async () => {
        throw new Error('staging signer unavailable');
      },
    },
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
  });

  await expect(protocol.claim(identity, { executionId: execution.executionId })).rejects.toThrow(
    'staging signer unavailable',
  );
  expect(await executionRepository.findDispatchable(execution.executionId)).not.toBeNull();
});

test('an authenticated Runner heartbeat advances a leased execution to running', async () => {
  const execution = { ...dispatchableExecution(), state: 'leased' as const };
  const lease = {
    leaseId: '80000000-0000-4000-8000-000000000001',
    executionId: execution.executionId,
    accountId: execution.accountId,
    projectId: execution.projectId,
    runnerId: RUNNER_ID,
    generation: 3,
    deadlineAt: '2026-07-27T08:00:30.000Z',
    claimedAt: NOW,
    releasedAt: null,
  };
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-oci-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [{ profileName: 'openopc-oci-v1', runtimeKind: 'oci-image' }],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => ociBinding(execution) },
    now: () => new Date(NOW),
  });

  const heartbeat = await protocol.heartbeatLease(identity, {
    projectId: PROJECT_ID,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
  });

  expect(heartbeat.execution.state).toBe('running');
  expect(heartbeat.lease.deadlineAt).toBe('2026-07-27T08:00:30.000Z');
});

test('Runner registration derives the account from a signed registration token', async () => {
  const runnerRepository = createMemoryModuleRunnerRepository();
  const protocol = new ModuleRunnerProtocol({
    executionRepository: createMemoryModuleExecutionRepository(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => null },
    registrationVerifier: {
      verify: async (input) =>
        input.registrationToken === 'signed-runner-registration' &&
        input.certificateThumbprint === 'b'.repeat(64)
          ? { accountId: ACCOUNT_ID }
          : null,
    },
    now: () => new Date(NOW),
    createId: () => RUNNER_ID,
  });

  const runner = await protocol.register(
    { certificateThumbprint: 'b'.repeat(64) },
    {
      registrationToken: 'signed-runner-registration',
      nodeIdentity: 'runner-new-1',
      softwareVersion: '1.0.0',
      attestationDigest: `sha256:${'9'.repeat(64)}`,
      profiles: [{ profileName: 'openopc-wasi-v1', runtimeKind: 'wasi-component' }],
    },
  );

  expect(runner).toMatchObject({
    runnerId: RUNNER_ID,
    accountId: ACCOUNT_ID,
    certificateThumbprint: 'b'.repeat(64),
    status: 'active',
  });
  expect(await runnerRepository.get(RUNNER_ID)).toEqual(runner);
});

test('Runner node heartbeat updates only mutable node health fields', async () => {
  const original = {
    runnerId: RUNNER_ID,
    accountId: ACCOUNT_ID,
    nodeIdentity: 'runner-oci-1',
    status: 'active' as const,
    softwareVersion: '1.0.0',
    attestationDigest: `sha256:${'6'.repeat(64)}` as const,
    certificateThumbprint: identity.certificateThumbprint,
    profiles: [{ profileName: 'openopc-oci-v1', runtimeKind: 'oci-image' as const }],
    updatedAt: '2026-07-27T07:59:00.000Z',
  };
  const runnerRepository = createMemoryModuleRunnerRepository({ runners: [original] });
  const protocol = new ModuleRunnerProtocol({
    executionRepository: createMemoryModuleExecutionRepository(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => null },
    now: () => new Date(NOW),
  });

  const updated = await protocol.heartbeatNode(identity, {
    softwareVersion: '1.0.1',
    attestationDigest: `sha256:${'a'.repeat(64)}`,
  });

  expect(updated).toEqual({
    ...original,
    softwareVersion: '1.0.1',
    attestationDigest: `sha256:${'a'.repeat(64)}`,
    updatedAt: NOW,
  });
});

test('Runner appends bounded progress evidence only through a live lease', async () => {
  const execution = { ...dispatchableExecution(), state: 'running' as const };
  const lease = {
    leaseId: '80000000-0000-4000-8000-000000000001',
    executionId: execution.executionId,
    accountId: execution.accountId,
    projectId: execution.projectId,
    runnerId: RUNNER_ID,
    generation: 2,
    deadlineAt: '2026-07-27T08:01:00.000Z',
    claimedAt: NOW,
    releasedAt: null,
  };
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-oci-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [{ profileName: 'openopc-oci-v1', runtimeKind: 'oci-image' }],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => ociBinding(execution) },
    now: () => new Date(NOW),
  });

  const event = await protocol.appendEvidence(identity, {
    projectId: PROJECT_ID,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    eventType: 'runner_progress',
    evidence: { progress: 0.5, phase: 'render' },
  });

  expect(event).toMatchObject({
    sequence: 1,
    eventType: 'runner_progress',
    payload: { progress: 0.5, phase: 'render' },
  });
});

test('Runner finalize derives tenant and runner coordinates from its authenticated identity', async () => {
  const execution = { ...dispatchableExecution(), state: 'running' as const };
  const lease = {
    leaseId: '80000000-0000-4000-8000-000000000001',
    executionId: execution.executionId,
    accountId: execution.accountId,
    projectId: execution.projectId,
    runnerId: RUNNER_ID,
    generation: 4,
    deadlineAt: '2026-07-27T08:01:00.000Z',
    claimedAt: NOW,
    releasedAt: null,
  };
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });
  const runnerRepository = createMemoryModuleRunnerRepository({
    runners: [
      {
        runnerId: RUNNER_ID,
        accountId: ACCOUNT_ID,
        nodeIdentity: 'runner-oci-1',
        status: 'active',
        softwareVersion: '1.0.0',
        attestationDigest: `sha256:${'6'.repeat(64)}`,
        certificateThumbprint: identity.certificateThumbprint,
        profiles: [{ profileName: 'openopc-oci-v1', runtimeKind: 'oci-image' }],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => ociBinding(execution) },
    now: () => new Date(NOW),
  });

  const finalized = await protocol.finalize(identity, {
    projectId: PROJECT_ID,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    outcome: 'unknown',
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    evidence: { provider_request_committed: true },
    usage: { paid_call: true, outcome: 'unknown' },
  });

  expect(finalized.execution.state).toBe('unknown');
  expect(finalized.evidence.runnerId).toBe(RUNNER_ID);
  expect(finalized.outbox.accountId).toBe(ACCOUNT_ID);
});
