import { expect, test } from 'bun:test';

import { createMemoryExecutionInputStore } from './execution-inputs';
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
const INPUT_DIGEST =
  'sha256:e844558922d2b0432d7ccf86f3f56b1afadfbaa9a0add07371f46f1a868821ef' as const;

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
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
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

type WasiModuleExecutionBinding = ModuleExecutionBinding & {
  runtimeArtifactDigest: NonNullable<ModuleExecutionBinding['runtimeArtifactDigest']>;
  runtimeArtifactBytes: number;
};

function wasiBinding(execution: ModuleExecution): WasiModuleExecutionBinding {
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
    runtimeDescriptorDigest:
      'sha256:42aa9d47b5b374e80fa2077d76a9488331dd93478fa808a30f3b28c9f3d54aa7',
    runtimeDescriptor: {
      descriptorVersion: 1,
      runtime: {
        kind: 'wasi-component',
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
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    runtimeArtifactBytes: 4096,
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
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

function executionInputStore(execution?: ModuleExecution) {
  return createMemoryExecutionInputStore({
    inputs: execution
      ? [
          {
            executionId: execution.executionId,
            accountId: execution.accountId,
            projectId: execution.projectId,
            payload: new TextEncoder().encode('{"prompt":"claim"}'),
            digest: INPUT_DIGEST,
            createdAt: execution.createdAt,
          },
        ]
      : [],
  });
}

test('Runner cannot claim an unsupported profile', async () => {
  const execution = dispatchableExecution();
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
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
            profileName: 'openopc-oci-v1',
            runtimeKind: 'oci-image',
          },
        ],
        updatedAt: NOW,
      },
    ],
  });
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    executionInputStore: executionInputStore(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => wasiBinding(execution) },
    now: () => new Date(NOW),
  });

  await expect(
    protocol.claimNext(identity, {}),
  ).rejects.toMatchObject({ code: 'RUNNER_PROFILE_UNAVAILABLE' });
  expect(
    (await executionRepository.get(execution.accountId, execution.projectId, execution.executionId))
      ?.state,
  ).toBe('dispatchable');
});

test('claim binds immutable execution state and every capability token into the signed envelope', async () => {
  const execution = dispatchableExecution();
  execution.deadlineAt = '2026-07-27 09:00:00+00';
  const binding = wasiBinding(execution);
  execution.workEnvelopeDigest = await computeModuleExecutionBindingDigest(
    binding,
    execution.deadlineAt,
    INPUT_DIGEST,
  );
  const executionRepository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
  });
  const claimNext = executionRepository.claimNext.bind(executionRepository);
  executionRepository.claimNext = async (command) => {
    const claim = await claimNext(command);
    if (claim) claim.lease.deadlineAt = '2026-07-27 08:00:30+00';
    return claim;
  };
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
        profiles: [{ profileName: binding.runtimeProfile, runtimeKind: binding.runtimeKind }],
        updatedAt: NOW,
      },
    ],
  });
  let signedTraceparent: string | undefined;
  let signedEnvelopeValue: unknown;
  const protocol = new ModuleRunnerProtocol({
    executionRepository,
    executionInputStore: executionInputStore(execution),
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
        signedEnvelopeValue = structuredClone(envelope);
        return 'e30.e30.e30';
      },
    },
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
  });

  const claim = await protocol.claimNext(identity, {});
  if (!claim) throw new Error('expected claim bundle');
  const envelope = signedEnvelopeValue as Record<string, any>;

  expect(claim.capabilityTokens).toEqual([
    {
      grantId: 'a0000000-0000-4000-8000-000000000001',
      audience: 'egress',
      token: 'runner-secret-capability-token',
    },
  ]);
  expect(claim.runtimeDescriptor).toEqual(binding.runtimeDescriptor);
  expect(claim.inputBase64).toBe('eyJwcm9tcHQiOiJjbGFpbSJ9');
  expect(claim.runtimeArtifact).toEqual({
    fetchPath: 'module-runtime/artifacts/fetch',
    digest: binding.runtimeArtifactDigest,
    bytes: binding.runtimeArtifactBytes,
  });
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
    runtimeDescriptorDigest:
      'sha256:42aa9d47b5b374e80fa2077d76a9488331dd93478fa808a30f3b28c9f3d54aa7',
    inputDigest: INPUT_DIGEST,
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    runtimeArtifactBytes: 4096,
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
    policyDigest: `sha256:${'4'.repeat(64)}`,
    killSwitchGeneration: 0,
    executionDeadline: '2026-07-27T09:00:00.000Z',
    bindingDigest: 'sha256:082e861f22906420472fdace2dd4a614c9a0593ad8eb7cb518194c21d7afcff4',
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
  const binding = wasiBinding(execution);
  execution.workEnvelopeDigest = await computeModuleExecutionBindingDigest(
    binding,
    execution.deadlineAt,
    INPUT_DIGEST,
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
        nodeIdentity: 'runner-wasi-1',
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
    executionInputStore: executionInputStore(execution),
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

  await expect(protocol.claimNext(identity, {})).rejects.toThrow('staging signer unavailable');
  expect(
    (await executionRepository.get(execution.accountId, execution.projectId, execution.executionId))
      ?.state,
  ).toBe('dispatchable');
});

test('claim-next abandons the lease when bundle inputs change during signing', async () => {
  for (const mutation of ['descriptor', 'input', 'artifact-digest', 'artifact-bytes'] as const) {
    const execution = dispatchableExecution();
    const binding = wasiBinding(execution);
    execution.workEnvelopeDigest = await computeModuleExecutionBindingDigest(
      binding,
      execution.deadlineAt,
      INPUT_DIGEST,
    );
    const executionRepository = createMemoryModuleExecutionRepository({
      executions: [execution],
      now: () => new Date(NOW),
    });
    const executionInput = {
      executionId: execution.executionId,
      accountId: execution.accountId,
      projectId: execution.projectId,
      payload: new TextEncoder().encode('{"prompt":"claim"}'),
      digest: INPUT_DIGEST,
      createdAt: execution.createdAt,
    };
    const protocol = new ModuleRunnerProtocol({
      executionRepository,
      executionInputStore: { get: async () => executionInput },
      runnerRepository: createMemoryModuleRunnerRepository({
        runners: [
          {
            runnerId: RUNNER_ID,
            accountId: ACCOUNT_ID,
            nodeIdentity: 'runner-wasi-1',
            status: 'active',
            softwareVersion: '1.0.0',
            attestationDigest: `sha256:${'6'.repeat(64)}`,
            certificateThumbprint: identity.certificateThumbprint,
            profiles: [{ profileName: binding.runtimeProfile, runtimeKind: binding.runtimeKind }],
            updatedAt: NOW,
          },
        ],
      }),
      bindingResolver: { resolveForClaim: async () => binding },
      capabilityIssuer: { issueForClaim: async () => [] },
      envelopeSigner: {
        sign: async (envelope) => {
          if (mutation === 'descriptor' && binding.runtimeDescriptor.runtime.kind === 'wasi-component') {
            binding.runtimeDescriptor.runtime.operation = 'substituted';
          } else if (mutation === 'input') {
            executionInput.payload = new TextEncoder().encode('{"prompt":"substituted"}');
          } else if (mutation === 'artifact-digest') {
            binding.runtimeArtifactDigest = `sha256:${'9'.repeat(64)}`;
          } else if (mutation === 'artifact-bytes') {
            binding.runtimeArtifactBytes = 4097;
          }
          return 'e30.e30.e30';
        },
      },
      now: () => new Date(NOW),
      createId: () => '80000000-0000-4000-8000-000000000001',
    });

    await expect(protocol.claimNext(identity, {})).rejects.toMatchObject({
      code: 'RUNNER_CAPABILITY_BINDING_INVALID',
    });
    expect(
      (
        await executionRepository.get(
          execution.accountId,
          execution.projectId,
          execution.executionId,
        )
      )?.state,
    ).toBe('dispatchable');
  }
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
  const heartbeatLease = executionRepository.heartbeatLease.bind(executionRepository);
  executionRepository.heartbeatLease = async (command) => {
    const heartbeat = await heartbeatLease(command);
    return {
      execution: { ...heartbeat.execution, deadlineAt: '2026-07-27 09:00:00+00' },
      lease: { ...heartbeat.lease, deadlineAt: '2026-07-27 08:00:30+00' },
    };
  };
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
    executionInputStore: executionInputStore(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => wasiBinding(execution) },
    now: () => new Date(NOW),
  });

  const heartbeat = await protocol.heartbeatLease(identity, {
    projectId: PROJECT_ID,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
  });

  expect(heartbeat.execution.state).toBe('running');
  expect(heartbeat.execution.deadlineAt).toBe('2026-07-27T09:00:00.000Z');
  expect(heartbeat.lease.deadlineAt).toBe('2026-07-27T08:00:30.000Z');
});

test('Runner registration derives the account from a signed registration token', async () => {
  const runnerRepository = createMemoryModuleRunnerRepository();
  const protocol = new ModuleRunnerProtocol({
    executionRepository: createMemoryModuleExecutionRepository(),
    executionInputStore: executionInputStore(),
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
    executionInputStore: executionInputStore(),
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
    executionInputStore: executionInputStore(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => wasiBinding(execution) },
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
    executionInputStore: executionInputStore(),
    runnerRepository,
    bindingResolver: { resolveForClaim: async () => wasiBinding(execution) },
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
