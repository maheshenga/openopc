import { expect, test } from 'bun:test';
import { MODULE_EXECUTION_INPUT_MAX_BYTES, sha256Digest } from '@openopc/module-runtime-contracts';

import { createMemoryExecutionInputStore } from './execution-inputs';
import {
  type CreateModuleExecutionPersistenceInput,
  type ModuleExecution,
  type ModuleExecutionBinding,
  type ModuleExecutionLease,
  ModuleExecutionService,
  computeModuleExecutionBindingDigest,
  createMemoryModuleExecutionRepository,
} from './executions';

const NOW = '2026-07-27T08:00:00.000Z';

function leasedExecution(): ModuleExecution {
  return {
    executionId: '10000000-0000-4000-8000-000000000001',
    accountId: '20000000-0000-4000-8000-000000000001',
    projectId: '30000000-0000-4000-8000-000000000001',
    installationId: '40000000-0000-4000-8000-000000000001',
    releaseId: '50000000-0000-4000-8000-000000000001',
    consentRevisionId: '60000000-0000-4000-8000-000000000001',
    runtimeDescriptorId: '70000000-0000-4000-8000-000000000001',
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    state: 'leased',
    idempotencyKey: 'execution-op-1',
    workEnvelopeDigest: `sha256:${'1'.repeat(64)}`,
    killSwitchGeneration: 0,
    deadlineAt: '2026-07-27T09:00:00.000Z',
    createdAt: NOW,
    updatedAt: NOW,
    terminalAt: null,
  };
}

function liveLease(execution: ModuleExecution): ModuleExecutionLease {
  return {
    leaseId: '80000000-0000-4000-8000-000000000001',
    executionId: execution.executionId,
    accountId: execution.accountId,
    projectId: execution.projectId,
    runnerId: '90000000-0000-4000-8000-000000000001',
    generation: 1,
    deadlineAt: '2026-07-27T08:10:00.000Z',
    claimedAt: NOW,
    releasedAt: null,
  };
}

function executionBinding(): ModuleExecutionBinding {
  return {
    accountId: '20000000-0000-4000-8000-000000000001',
    projectId: '30000000-0000-4000-8000-000000000001',
    installationId: '40000000-0000-4000-8000-000000000001',
    installRevision: 3,
    releaseId: '50000000-0000-4000-8000-000000000001',
    releaseDigest: `sha256:${'4'.repeat(64)}`,
    consentRevisionId: '60000000-0000-4000-8000-000000000001',
    permissionDigest: `sha256:${'5'.repeat(64)}`,
    policyDigest: `sha256:${'6'.repeat(64)}`,
    runtimeDescriptorId: '70000000-0000-4000-8000-000000000001',
    runtimeDescriptorDigest: `sha256:${'7'.repeat(64)}`,
    runtimeDescriptor: {
      descriptorVersion: 1,
      runtime: {
        kind: 'oci-image',
        image: `sha256:${'8'.repeat(64)}`,
        command: [],
        args: [],
        profile: 'openopc-oci-v1',
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
    runtimeArtifactDigest: null,
    runtimeArtifactBytes: null,
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    killSwitchGeneration: 0,
    resourceCeilings: {
      cpuMillis: 10_000,
      memoryMiB: 512,
      wallTimeMs: 120_000,
      costMicro: 50_000,
    },
    confirmationRequired: true,
  };
}

test('binding digest includes canonical input and trusted runtime artifact metadata', async () => {
  const binding: ModuleExecutionBinding = {
    ...executionBinding(),
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    runtimeArtifactBytes: 4096,
  };
  const deadlineAt = '2026-07-27T09:00:00.000Z';
  const inputDigest = `sha256:${'9'.repeat(64)}` as const;
  const baseline = await computeModuleExecutionBindingDigest(binding, deadlineAt, inputDigest);

  expect(
    await computeModuleExecutionBindingDigest(
      binding,
      deadlineAt,
      `sha256:${'a'.repeat(64)}`,
    ),
  ).not.toBe(baseline);
  expect(
    await computeModuleExecutionBindingDigest(
      { ...binding, runtimeArtifactDigest: `sha256:${'b'.repeat(64)}` },
      deadlineAt,
      inputDigest,
    ),
  ).not.toBe(baseline);
  expect(
    await computeModuleExecutionBindingDigest(
      { ...binding, runtimeArtifactBytes: 4097 },
      deadlineAt,
      inputDigest,
    ),
  ).not.toBe(baseline);
});

test('binding digest canonicalizes equivalent execution deadline representations', async () => {
  const binding: ModuleExecutionBinding = {
    ...executionBinding(),
    runtimeArtifactDigest: `sha256:${'8'.repeat(64)}`,
    runtimeArtifactBytes: 4096,
  };
  const inputDigest = `sha256:${'9'.repeat(64)}` as const;
  const iso = await computeModuleExecutionBindingDigest(
    binding,
    '2026-07-27T09:00:00.000Z',
    inputDigest,
  );

  expect(
    await computeModuleExecutionBindingDigest(
      binding,
      '2026-07-27T17:00:00.000+08:00',
      inputDigest,
    ),
  ).toBe(iso);
  expect(
    await computeModuleExecutionBindingDigest(
      binding,
      '2026-07-27 09:00:00+00',
      inputDigest,
    ),
  ).toBe(iso);
});

test('claim-next selects the oldest compatible execution through the active Runner profile', async () => {
  const accountId = '20000000-0000-4000-8000-000000000001';
  const runnerId = '90000000-0000-4000-8000-000000000001';
  const base: ModuleExecution = {
    ...leasedExecution(),
    accountId,
    projectId: '30000000-0000-4000-8000-000000000001',
    state: 'dispatchable',
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    createdAt: '2026-07-27T07:59:00.000Z',
    updatedAt: '2026-07-27T07:59:00.000Z',
  };
  const selectedId = '10000000-0000-4000-8000-000000000001';
  const repository = createMemoryModuleExecutionRepository({
    executions: [
      { ...base, executionId: '00000000-0000-4000-8000-000000000001', accountId: 'other-account' },
      {
        ...base,
        executionId: '00000000-0000-4000-8000-000000000002',
        deadlineAt: '2026-07-27T07:59:59.000Z',
      },
      {
        ...base,
        executionId: '00000000-0000-4000-8000-000000000003',
        runtimeProfile: 'openopc-wasi-v2',
      },
      { ...base, executionId: '10000000-0000-4000-8000-000000000002' },
      { ...base, executionId: selectedId },
    ],
    runnerProfiles: [
      {
        runnerId,
        accountId,
        status: 'active',
        runtimeKind: 'wasi-component',
        profileName: 'openopc-wasi-v1',
      },
    ],
    now: () => new Date(NOW),
    createId: () => '80000000-0000-4000-8000-000000000001',
  });

  const claimed = await repository.claimNext({ accountId, runnerId });

  expect(claimed?.execution.executionId).toBe(selectedId);
  expect(claimed?.execution.state).toBe('leased');
  expect(claimed?.lease).toMatchObject({
    leaseId: '80000000-0000-4000-8000-000000000001',
    generation: 1,
    deadlineAt: '2026-07-27T08:00:30.000Z',
  });
  expect((await repository.listEvents(accountId, base.projectId, selectedId)).at(-1)).toMatchObject({
    eventType: 'execution_claimed',
  });
});

test('claim-next returns null for a non-active Runner or a Runner without a usable profile', async () => {
  const accountId = '20000000-0000-4000-8000-000000000001';
  const runnerId = '90000000-0000-4000-8000-000000000001';
  const execution: ModuleExecution = {
    ...leasedExecution(),
    accountId,
    state: 'dispatchable',
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
    deadlineAt: '2026-07-27T09:00:00.000Z',
  };

  for (const profile of [
    {
      runnerId,
      accountId,
      status: 'draining' as const,
      runtimeKind: 'wasi-component' as const,
      profileName: 'openopc-wasi-v1',
    },
    {
      runnerId,
      accountId,
      status: 'active' as const,
      runtimeKind: 'oci-image' as const,
      profileName: 'openopc-oci-v1',
    },
  ]) {
    const repository = createMemoryModuleExecutionRepository({
      executions: [execution],
      runnerProfiles: [profile],
      now: () => new Date(NOW),
    });

    await expect(repository.claimNext({ accountId, runnerId })).resolves.toBeNull();
  }
});

test('unknown paid outcome is terminal and never auto-retried', async () => {
  const execution = leasedExecution();
  const lease = liveLease(execution);
  const repository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });
  const service = new ModuleExecutionService({ repository });

  const result = await service.finalize({
    accountId: execution.accountId,
    projectId: execution.projectId,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    runnerId: lease.runnerId,
    outcome: 'unknown',
    evidenceDigest: `sha256:${'2'.repeat(64)}`,
    evidence: { provider_request_committed: true, provider_outcome_known: false },
    usage: { paid_call: true, outcome: 'unknown' },
  });

  expect(result.execution.state).toBe('unknown');
  expect(result.evidence.outcome).toBe('unknown');
  expect(result.outbox.payload).toEqual({ paid_call: true, outcome: 'unknown' });
  expect(
    await repository.get(execution.accountId, execution.projectId, execution.executionId),
  ).toMatchObject({ state: 'unknown' });
});

test('cancelling a leased execution fences a late Runner finalize', async () => {
  const execution = leasedExecution();
  const lease = liveLease(execution);
  const repository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });
  const service = new ModuleExecutionService({ repository });

  const cancelled = await service.cancel({
    accountId: execution.accountId,
    projectId: execution.projectId,
    executionId: execution.executionId,
  });

  expect(cancelled.state).toBe('cancelled');
  await expect(
    service.finalize({
      accountId: execution.accountId,
      projectId: execution.projectId,
      executionId: execution.executionId,
      leaseId: lease.leaseId,
      generation: lease.generation,
      runnerId: lease.runnerId,
      outcome: 'succeeded',
      evidenceDigest: `sha256:${'3'.repeat(64)}`,
      evidence: { completed: true },
      usage: { paid_call: false },
    }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_LEASE_STALE' });
});

test('create replays the same exact binding for an idempotency key', async () => {
  const binding = executionBinding();
  const executionInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({
    now: () => new Date(NOW),
    createId: () => '10000000-0000-4000-8000-000000000099',
    executionInputStore,
  });
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    bindingResolver: {
      resolve: async () => binding,
    },
  });
  const command = {
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-create-op-1',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    input: { a: 1 },
  };

  const first = await service.create(command);
  const replay = await service.create(command);

  expect(first.executionId).toBe(replay.executionId);
  expect(first.state).toBe('awaiting_confirmation');
  expect(first.releaseId).toBe(binding.releaseId);
  expect(first.runtimeKind).toBe(binding.runtimeKind);
  expect(first.runtimeProfile).toBe(binding.runtimeProfile);
});

test('create persists the exact canonical input bytes and digest', async () => {
  const binding = executionBinding();
  const executionInputStore = createMemoryExecutionInputStore();
  const backingRepository = createMemoryModuleExecutionRepository({ executionInputStore });
  let persisted: CreateModuleExecutionPersistenceInput | undefined;
  const repository = {
    ...backingRepository,
    async create(input: CreateModuleExecutionPersistenceInput) {
      persisted = input;
      return backingRepository.create(input);
    },
  };
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    createId: () => '10000000-0000-4000-8000-000000000098',
    bindingResolver: { resolve: async () => binding },
  });

  await service.create({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-canonical-input-1',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    input: { z: 1, a: ['x'] },
  });

  expect(new TextDecoder().decode(persisted?.input.payload)).toBe('{"a":["x"],"z":1}');
  expect(persisted?.input.digest).toBe(
    await sha256Digest(persisted?.input.payload ?? new Uint8Array()),
  );
  expect(persisted?.input.createdAt).toBe(persisted?.execution.createdAt);
});

test('create enforces the canonical input byte limit and rejects unsupported values', async () => {
  const binding = executionBinding();
  const executionInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({ executionInputStore });
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    bindingResolver: { resolve: async () => binding },
  });
  const command = {
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    deadlineAt: '2026-07-27T09:00:00.000Z',
  };

  const accepted = await service.create({
    ...command,
    idempotencyKey: 'execution-input-boundary-ok',
    input: 'x'.repeat(MODULE_EXECUTION_INPUT_MAX_BYTES - 2),
  });
  expect(
    (await executionInputStore.get(binding.accountId, binding.projectId, accepted.executionId))
      ?.payload.byteLength,
  ).toBe(MODULE_EXECUTION_INPUT_MAX_BYTES);

  await expect(
    service.create({
      ...command,
      idempotencyKey: 'execution-input-boundary-too-large',
      input: 'x'.repeat(MODULE_EXECUTION_INPUT_MAX_BYTES - 1),
    }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_INPUT_INVALID', status: 400 });
  await expect(
    service.create({
      ...command,
      idempotencyKey: 'execution-input-unsupported-value',
      input: BigInt(1),
    }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_INPUT_INVALID', status: 400 });
});

test('create rejects an idempotency replay with different canonical input', async () => {
  const binding = executionBinding();
  const executionInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({ executionInputStore });
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    bindingResolver: { resolve: async () => binding },
  });
  const command = {
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-input-idempotency',
    deadlineAt: '2026-07-27T09:00:00.000Z',
  };

  await service.create({ ...command, input: { prompt: 'first' } });
  await expect(
    service.create({ ...command, input: { prompt: 'different' } }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_STATE_CONFLICT', status: 409 });
});

test('confirm treats a missing immutable input as a stale binding', async () => {
  const binding = executionBinding();
  const persistedInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({
    executionInputStore: persistedInputStore,
  });
  const creator = new ModuleExecutionService({
    repository,
    executionInputStore: persistedInputStore,
    now: () => new Date(NOW),
    bindingResolver: { resolve: async () => binding },
  });
  const execution = await creator.create({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-confirm-missing-input',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    input: { prompt: 'persisted' },
  });
  const confirmer = new ModuleExecutionService({
    repository,
    executionInputStore: { get: async () => null },
    now: () => new Date(NOW),
    bindingResolver: { resolve: async () => binding },
  });

  await expect(
    confirmer.confirm({
      accountId: binding.accountId,
      projectId: binding.projectId,
      executionId: execution.executionId,
      actorUserId: 'a0000000-0000-4000-8000-000000000001',
    }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_BINDING_STALE', status: 409 });
});

test('confirm rejects a permission change after execution creation', async () => {
  const original = executionBinding();
  let current = original;
  const executionInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({
    now: () => new Date(NOW),
    executionInputStore,
  });
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    bindingResolver: {
      resolve: async () => current,
    },
  });
  const execution = await service.create({
    accountId: original.accountId,
    projectId: original.projectId,
    installationId: original.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-create-op-2',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    input: { prompt: 'confirm me' },
  });
  current = { ...original, permissionDigest: `sha256:${'8'.repeat(64)}` };

  await expect(
    service.confirm({
      accountId: original.accountId,
      projectId: original.projectId,
      executionId: execution.executionId,
      actorUserId: 'a0000000-0000-4000-8000-000000000001',
    }),
  ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_BINDING_STALE' });
  expect(
    (await repository.get(original.accountId, original.projectId, execution.executionId))?.state,
  ).toBe('awaiting_confirmation');
});

test('an expired dispatchable execution becomes terminal on read', async () => {
  const execution: ModuleExecution = {
    ...leasedExecution(),
    state: 'dispatchable',
    deadlineAt: '2026-07-27T07:59:59.000Z',
  };
  const repository = createMemoryModuleExecutionRepository({
    executions: [execution],
    now: () => new Date(NOW),
  });
  const service = new ModuleExecutionService({
    repository,
    now: () => new Date(NOW),
  });

  const current = await service.get({
    accountId: execution.accountId,
    projectId: execution.projectId,
    executionId: execution.executionId,
  });

  expect(current.state).toBe('failed');
  expect(current.terminalAt).toBe(NOW);
  expect(
    await repository.get(execution.accountId, execution.projectId, execution.executionId),
  ).toMatchObject({ state: 'failed' });
});

test('estimate returns the exact authorized release and bounded ceilings', async () => {
  const binding = executionBinding();
  const service = new ModuleExecutionService({
    repository: createMemoryModuleExecutionRepository(),
    bindingResolver: { resolve: async () => binding },
  });

  const estimate = await service.estimate({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
  });

  expect(estimate).toEqual({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    installRevision: binding.installRevision,
    releaseId: binding.releaseId,
    releaseDigest: binding.releaseDigest,
    runtimeKind: 'oci-image',
    runtimeProfile: 'openopc-oci-v1',
    resourceCeilings: binding.resourceCeilings,
    confirmationRequired: true,
  });
});

test('events expose an append-only state transition history', async () => {
  const binding = { ...executionBinding(), confirmationRequired: true };
  const executionInputStore = createMemoryExecutionInputStore();
  const repository = createMemoryModuleExecutionRepository({
    now: () => new Date(NOW),
    executionInputStore,
  });
  const service = new ModuleExecutionService({
    repository,
    executionInputStore,
    now: () => new Date(NOW),
    bindingResolver: { resolve: async () => binding },
  });
  const execution = await service.create({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
    idempotencyKey: 'execution-events-op-1',
    deadlineAt: '2026-07-27T09:00:00.000Z',
    input: { prompt: 'record events' },
  });
  await service.confirm({
    accountId: binding.accountId,
    projectId: binding.projectId,
    executionId: execution.executionId,
    actorUserId: 'a0000000-0000-4000-8000-000000000001',
  });
  await service.cancel({
    accountId: binding.accountId,
    projectId: binding.projectId,
    executionId: execution.executionId,
  });

  const events = await service.events({
    accountId: binding.accountId,
    projectId: binding.projectId,
    executionId: execution.executionId,
  });

  expect(events.map((event) => [event.sequence, event.eventType])).toEqual([
    [1, 'execution_created'],
    [2, 'execution_confirmed'],
    [3, 'execution_cancelled'],
  ]);
});

test('heartbeat lease deadline is capped at the execution deadline', async () => {
  const execution = {
    ...leasedExecution(),
    deadlineAt: '2026-07-27T08:00:20.000Z',
  };
  const lease = {
    ...liveLease(execution),
    deadlineAt: '2026-07-27T08:00:10.000Z',
  };
  const repository = createMemoryModuleExecutionRepository({
    executions: [execution],
    leases: [lease],
    now: () => new Date(NOW),
  });

  const result = await repository.heartbeatLease({
    accountId: execution.accountId,
    projectId: execution.projectId,
    executionId: execution.executionId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    runnerId: lease.runnerId,
  });

  expect(result.execution.state).toBe('running');
  expect(result.lease.deadlineAt).toBe(execution.deadlineAt);
});
