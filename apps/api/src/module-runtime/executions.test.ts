import { expect, test } from 'bun:test';

import {
  type ModuleExecution,
  type ModuleExecutionBinding,
  type ModuleExecutionLease,
  ModuleExecutionService,
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
  expect(await repository.findDispatchable(execution.executionId)).toBeNull();
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
  const repository = createMemoryModuleExecutionRepository({
    now: () => new Date(NOW),
    createId: () => '10000000-0000-4000-8000-000000000099',
  });
  const service = new ModuleExecutionService({
    repository,
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
  };

  const first = await service.create(command);
  const replay = await service.create(command);

  expect(first.executionId).toBe(replay.executionId);
  expect(first.state).toBe('awaiting_confirmation');
  expect(first.releaseId).toBe(binding.releaseId);
  expect(first.runtimeKind).toBe(binding.runtimeKind);
  expect(first.runtimeProfile).toBe(binding.runtimeProfile);
});

test('confirm rejects a permission change after execution creation', async () => {
  const original = executionBinding();
  let current = original;
  const repository = createMemoryModuleExecutionRepository({ now: () => new Date(NOW) });
  const service = new ModuleExecutionService({
    repository,
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
  expect(await repository.findDispatchable(execution.executionId)).toBeNull();
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
  const repository = createMemoryModuleExecutionRepository({ now: () => new Date(NOW) });
  const service = new ModuleExecutionService({
    repository,
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
