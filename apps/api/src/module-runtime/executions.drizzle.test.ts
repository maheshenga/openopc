import { describe, expect, test } from 'bun:test';
import {
  type Database,
  moduleExecutionEvents,
  moduleExecutionInputs,
  moduleExecutions,
} from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import type {
  CreateModuleExecutionPersistenceInput,
  StoreModuleCapabilityGrantsCommand,
} from './executions';
import {
  createDrizzleModuleExecutionBindingResolver,
  createDrizzleModuleExecutionInputStore,
  createDrizzleModuleExecutionRepository,
} from './executions.drizzle';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const EXECUTION_ID = '30000000-0000-4000-a000-000000000003';
const LEASE_ID = '40000000-0000-4000-a000-000000000004';
const RUNNER_ID = '50000000-0000-4000-a000-000000000005';
const GRANT_ID = '60000000-0000-4000-a000-000000000006';
const EXPIRES_AT = '2026-07-27T01:00:30.000Z';
const INSTALLATION_ID = '70000000-0000-4000-a000-000000000007';
const RELEASE_ID = '80000000-0000-4000-a000-000000000008';
const CONSENT_ID = '90000000-0000-4000-a000-000000000009';
const DESCRIPTOR_ID = 'a0000000-0000-4000-a000-00000000000a';
const RELEASE_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const PERMISSION_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const VERIFICATION_POLICY_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const DESCRIPTOR_DIGEST = `sha256:${'e'.repeat(64)}` as const;
const INPUT_DIGEST = `sha256:${'f'.repeat(64)}` as const;
const RUNTIME_ARTIFACT_DIGEST = `sha256:${'7'.repeat(64)}` as const;
const dispatchableExecutionRow = {
  executionId: EXECUTION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  installationId: INSTALLATION_ID,
  releaseId: RELEASE_ID,
  consentRevisionId: CONSENT_ID,
  runtimeDescriptorId: DESCRIPTOR_ID,
  runtimeKind: 'wasi-component' as const,
  runtimeProfile: 'openopc-wasi-v1',
  state: 'dispatchable' as const,
  idempotencyKey: 'idem-lock-order',
  workEnvelopeDigest: RELEASE_DIGEST,
  killSwitchGeneration: 0,
  deadlineAt: '2026-07-27T02:00:00.000Z',
  createdAt: '2026-07-27T01:00:00.000Z',
  updatedAt: '2026-07-27T01:00:01.000Z',
  terminalAt: null,
};

const executionInputRow = {
  executionId: EXECUTION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  inputPayload: new TextEncoder().encode('{"prompt":"bounded"}'),
  inputDigest: INPUT_DIGEST,
  createdAt: dispatchableExecutionRow.createdAt,
};

function createPersistenceInput(): CreateModuleExecutionPersistenceInput {
  return {
    execution: dispatchableExecutionRow,
    input: {
      executionId: EXECUTION_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      payload: executionInputRow.inputPayload,
      digest: INPUT_DIGEST,
      createdAt: dispatchableExecutionRow.createdAt,
    },
  };
}

function command(): StoreModuleCapabilityGrantsCommand {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    runnerId: RUNNER_ID,
    generation: 2,
    grants: [
      {
        grantId: GRANT_ID,
        audience: 'egress',
        tokenHash: `sha256:${'a'.repeat(64)}`,
        expiresAt: EXPIRES_AT,
      },
    ],
  };
}

function appendCommand() {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    executionId: EXECUTION_ID,
    leaseId: LEASE_ID,
    runnerId: RUNNER_ID,
    generation: 2,
    eventType: 'runner_progress',
    evidence: { completed: 1 },
  };
}

function databaseFixture(input: { executeResults: unknown[][]; updateResults?: unknown[][] }) {
  const executeResults = [...input.executeResults];
  const updateResults = [...(input.updateResults ?? [])];
  const operations: Array<'execute' | 'update' | 'insert'> = [];
  const statements: unknown[] = [];
  const insertedValues: unknown[] = [];
  let transactionCalls = 0;
  const grantRow = {
    grantId: GRANT_ID,
    executionId: EXECUTION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    leaseId: LEASE_ID,
    audience: 'egress' as const,
    tokenHash: `sha256:${'a'.repeat(64)}`,
    expiresAt: EXPIRES_AT,
    revokedAt: null,
    createdAt: '2026-07-27T01:00:00.000Z',
  };
  const eventRow = {
    eventId: 'a0000000-0000-4000-a000-00000000000b',
    executionId: EXECUTION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    sequence: 1,
    eventType: 'runner_progress',
    payload: { completed: 1 },
    createdAt: '2026-07-27T01:00:00.000Z',
  };
  const query = {
    async execute(statement: unknown) {
      operations.push('execute');
      statements.push(statement);
      return executeResults.shift() ?? [];
    },
    select() {
      let joined = false;
      const chain = {
        from: () => chain,
        innerJoin: () => {
          joined = true;
          return chain;
        },
        where: () => (joined ? chain : Promise.resolve([{ sequence: 0 }])),
        limit: async () => [],
      };
      return chain;
    },
    update(_table: unknown) {
      operations.push('update');
      const rows = updateResults.shift() ?? [];
      const promise = Promise.resolve(rows);
      const chain = Object.assign(promise, {
        set: (_value: unknown) => chain,
        where: () => chain,
        returning: async () => rows,
      });
      return chain;
    },
    insert(_table: unknown) {
      operations.push('insert');
      return {
        values(value: unknown) {
          insertedValues.push(value);
          const first = Array.isArray(value) ? value[0] : value;
          const isEvent = !!first && typeof first === 'object' && 'eventType' in first;
          return { returning: async () => (isEvent ? [eventRow] : [grantRow]) };
        },
      };
    },
  };
  const database = {
    ...query,
    async transaction(run: (tx: typeof query) => Promise<unknown>) {
      transactionCalls += 1;
      return run(query);
    },
  } as unknown as Database;
  return {
    database,
    operations,
    statements,
    insertedValues,
    transactionCalls: () => transactionCalls,
  };
}

function render(statement: unknown) {
  return new PgDialect().sqlToQuery(statement as never);
}

function bindingDatabaseFixture(input?: {
  artifact?: Record<string, unknown> | null;
  descriptor?: Record<string, unknown>;
}) {
  let selection = 0;
  const descriptor = input?.descriptor ?? {
    descriptorId: DESCRIPTOR_ID,
    descriptorDigest: DESCRIPTOR_DIGEST,
    descriptor: {
      descriptorVersion: 1,
      runtime: {
        kind: 'wasi-component',
        component: 'runtime/main.wasm',
        world: 'openopc:module/runtime',
        operation: 'run',
        imports: ['openopc:module/input', 'openopc:module/output'],
        limits: {
          cpuMillis: 30_000,
          fuel: 10_000_000,
          memoryMiB: 256,
          outputBytes: 1_048_576,
          pids: 16,
          wallTimeMs: 30_000,
        },
      },
    },
  };
  const artifact = Object.hasOwn(input ?? {}, 'artifact')
    ? input?.artifact
    : {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 4096,
        mediaType: 'application/wasm',
      };
  const resultSets = [
    [
      {
        installation: {
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          installRevision: 3,
        },
        release: {
          releaseId: RELEASE_ID,
          signaturePayloadDigest: RELEASE_DIGEST,
          verificationPolicyDigest: VERIFICATION_POLICY_DIGEST,
        },
        consent: {
          consentRevisionId: CONSENT_ID,
          permissionDigest: PERMISSION_DIGEST,
          resourceCpuMillisCeiling: 2_000,
          resourceMemoryMibCeiling: 512,
          resourceWallTimeMsCeiling: 60_000,
          costCeilingMicro: 0,
        },
        descriptor,
        artifact,
      },
    ],
    [],
  ];
  const database = {
    select() {
      selection += 1;
      const rows = resultSets.shift() ?? [];
      const query = {
        from: () => query,
        innerJoin: () => query,
        leftJoin: () => query,
        where: () => query,
        orderBy: () => (selection === 2 ? Promise.resolve(rows) : query),
        limit: async () => rows,
      };
      return query;
    },
  } as unknown as Database;
  return database;
}

function creationDatabaseFixture(input?: {
  conflict?: boolean;
  persistedInputDigest?: typeof INPUT_DIGEST | `sha256:${string}`;
}) {
  const insertedTables: unknown[] = [];
  const insertedValues: unknown[] = [];
  const selectedTables: unknown[] = [];
  let transactionCalls = 0;
  const eventRow = {
    eventId: 'b0000000-0000-4000-a000-00000000000b',
    executionId: EXECUTION_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    sequence: 1,
    eventType: 'execution_created',
    payload: { state: 'dispatchable' },
    createdAt: dispatchableExecutionRow.createdAt,
  };
  const query = {
    async execute() {
      return [{ executionId: EXECUTION_ID }];
    },
    select() {
      let table: unknown;
      const chain = {
        from(value: unknown) {
          table = value;
          selectedTables.push(value);
          return chain;
        },
        where() {
          return table === moduleExecutionEvents ? Promise.resolve([{ sequence: 0 }]) : chain;
        },
        limit: async () => {
          if (table === moduleExecutions) return [dispatchableExecutionRow];
          if (table === moduleExecutionInputs) {
            return [
              {
                ...executionInputRow,
                inputDigest: input?.persistedInputDigest ?? INPUT_DIGEST,
              },
            ];
          }
          return [];
        },
      };
      return chain;
    },
    insert(table: unknown) {
      insertedTables.push(table);
      return {
        values(value: unknown) {
          insertedValues.push(value);
          if (table === moduleExecutions) {
            return {
              onConflictDoNothing() {
                return {
                  returning: async () => (input?.conflict ? [] : [dispatchableExecutionRow]),
                };
              },
            };
          }
          if (table === moduleExecutionEvents) {
            return { returning: async () => [eventRow] };
          }
          return Promise.resolve([]);
        },
      };
    },
  };
  const database = {
    ...query,
    async transaction(run: (tx: typeof query) => Promise<unknown>) {
      transactionCalls += 1;
      return run(query);
    },
  } as unknown as Database;
  return {
    database,
    insertedTables,
    insertedValues,
    selectedTables,
    transactionCalls: () => transactionCalls,
  };
}

describe('module execution Drizzle repository', () => {
  test('creates execution input and event in one ordered transaction', async () => {
    const fixture = creationDatabaseFixture();
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.create(createPersistenceInput())).resolves.toMatchObject({
      executionId: EXECUTION_ID,
    });

    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.insertedTables).toHaveLength(3);
    expect(fixture.insertedTables[0]).toBe(moduleExecutions);
    expect(fixture.insertedTables[1]).toBe(moduleExecutionInputs);
    expect(fixture.insertedTables[2]).toBe(moduleExecutionEvents);
    expect(fixture.insertedValues[1]).toEqual({
      executionId: EXECUTION_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      inputPayload: executionInputRow.inputPayload,
      inputDigest: INPUT_DIGEST,
      createdAt: dispatchableExecutionRow.createdAt,
    });
  });

  test('idempotent create compares the persisted canonical input digest', async () => {
    const fixture = creationDatabaseFixture({
      conflict: true,
      persistedInputDigest: `sha256:${'0'.repeat(64)}`,
    });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.create(createPersistenceInput())).rejects.toMatchObject({
      code: 'MODULE_EXECUTION_STATE_CONFLICT',
      status: 409,
    });
    expect(fixture.selectedTables).toContain(moduleExecutions);
    expect(fixture.selectedTables).toContain(moduleExecutionInputs);
    expect(fixture.insertedTables).toEqual([moduleExecutions]);
  });

  test('loads immutable execution input by tenant coordinates', async () => {
    const fixture = creationDatabaseFixture({ conflict: true });
    const store = createDrizzleModuleExecutionInputStore(fixture.database);

    await expect(store.get(ACCOUNT_ID, PROJECT_ID, EXECUTION_ID)).resolves.toEqual({
      executionId: EXECUTION_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      payload: executionInputRow.inputPayload,
      digest: INPUT_DIGEST,
      createdAt: dispatchableExecutionRow.createdAt,
    });
    expect(fixture.selectedTables).toEqual([moduleExecutionInputs]);
  });

  test('binds the published verification policy separately from accepted permissions', async () => {
    const resolver = createDrizzleModuleExecutionBindingResolver(bindingDatabaseFixture());

    const binding = await resolver.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      actorUserId: 'b0000000-0000-4000-a000-00000000000b',
    });

    expect(binding).toMatchObject({
      releaseDigest: RELEASE_DIGEST,
      permissionDigest: PERMISSION_DIGEST,
      policyDigest: VERIFICATION_POLICY_DIGEST,
      runtimeDescriptorDigest: DESCRIPTOR_DIGEST,
      runtimeDescriptor: { descriptorVersion: 1, runtime: { kind: 'wasi-component' } },
      runtimeArtifactDigest: RUNTIME_ARTIFACT_DIGEST,
      runtimeArtifactBytes: 4096,
    });
  });

  test('fails closed when a WASI binding lacks exact trusted artifact metadata', async () => {
    for (const artifact of [
      null,
      {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: 'sha256:not-a-digest',
        artifactBytes: 4096,
        mediaType: 'application/wasm',
      },
      {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 0,
        mediaType: 'application/wasm',
      },
      {
        releaseId: 'b0000000-0000-4000-a000-00000000000b',
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 4096,
        mediaType: 'application/wasm',
      },
      {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 33_554_433,
        mediaType: 'application/wasm',
      },
      {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: DESCRIPTOR_ID,
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 4096,
        mediaType: 'application/octet-stream',
      },
      {
        releaseId: RELEASE_ID,
        runtimeDescriptorId: 'b0000000-0000-4000-a000-00000000000b',
        artifactDigest: RUNTIME_ARTIFACT_DIGEST,
        artifactBytes: 4096,
        mediaType: 'application/wasm',
      },
    ]) {
      await expect(
        createDrizzleModuleExecutionBindingResolver(bindingDatabaseFixture({ artifact })).resolve({
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
          installationId: INSTALLATION_ID,
          actorUserId: 'b0000000-0000-4000-a000-00000000000b',
        }),
      ).resolves.toBeNull();
    }
  });

  test('keeps OCI descriptors unavailable to the current Runner execution path', async () => {
    const descriptor = {
      descriptorId: DESCRIPTOR_ID,
      descriptorDigest: DESCRIPTOR_DIGEST,
      descriptor: {
        descriptorVersion: 1,
        runtime: {
          kind: 'oci-image',
          image: `sha256:${'8'.repeat(64)}`,
          command: ['adapter'],
          args: [],
          profile: 'server-adapter',
          limits: {
            cpuMillis: 30_000,
            fuel: 10_000_000,
            memoryMiB: 256,
            outputBytes: 1_048_576,
            pids: 16,
            wallTimeMs: 30_000,
          },
        },
      },
    };

    await expect(
      createDrizzleModuleExecutionBindingResolver(
        bindingDatabaseFixture({ descriptor, artifact: null }),
      ).resolve({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        actorUserId: 'b0000000-0000-4000-a000-00000000000b',
      }),
    ).resolves.toBeNull();
  });

  test('delegates claim-next selection atomically using only Runner tenant coordinates', async () => {
    const fixture = databaseFixture({ executeResults: [[]] });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.claimNext({ accountId: ACCOUNT_ID, runnerId: RUNNER_ID })).resolves.toBeNull();

    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.operations).toEqual(['execute']);
    expect(fixture.insertedValues).toEqual([]);
    const claim = render(fixture.statements[0]);
    expect(claim.sql).toContain('kortix.claim_next_module_execution');
    expect(claim.sql).not.toContain('kortix.claim_module_execution');
    expect(claim.params).toEqual([ACCOUNT_ID, RUNNER_ID]);
  });

  test('rejects capability grants after the lease fence is lost', async () => {
    const fixture = databaseFixture({ executeResults: [[]] });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.storeCapabilityGrants(command())).rejects.toMatchObject({
      code: 'MODULE_EXECUTION_LEASE_STALE',
      status: 409,
    });
    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.insertedValues).toEqual([]);
  });

  test('locks execution then lease before storing bounded grants', async () => {
    const fixture = databaseFixture({
      executeResults: [[{ executionId: EXECUTION_ID }], [{ leaseId: LEASE_ID }]],
    });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.storeCapabilityGrants(command())).resolves.toHaveLength(1);
    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.insertedValues).toHaveLength(1);
    expect(fixture.statements).toHaveLength(2);
    const executionLock = render(fixture.statements[0]);
    const leaseLock = render(fixture.statements[1]);
    expect(executionLock.sql).toContain('FROM kortix.module_executions AS execution');
    expect(executionLock.sql).toContain('FOR UPDATE');
    expect(executionLock.sql).not.toContain('module_execution_leases');
    expect(executionLock.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, EXECUTION_ID]),
    );
    expect(leaseLock.sql).toContain('FROM kortix.module_execution_leases AS lease_row');
    expect(leaseLock.sql).toContain('FOR UPDATE');
    expect(leaseLock.sql).not.toContain('JOIN kortix.module_executions');
    expect(leaseLock.params).toEqual(
      expect.arrayContaining([
        ACCOUNT_ID,
        PROJECT_ID,
        EXECUTION_ID,
        LEASE_ID,
        RUNNER_ID,
        2,
        EXPIRES_AT,
      ]),
    );
  });

  test('does not store grants when lease validation fails after execution lock', async () => {
    const fixture = databaseFixture({
      executeResults: [[{ executionId: EXECUTION_ID }], []],
    });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.storeCapabilityGrants(command())).rejects.toMatchObject({
      code: 'MODULE_EXECUTION_LEASE_STALE',
      status: 409,
    });
    expect(fixture.statements).toHaveLength(2);
    expect(fixture.insertedValues).toEqual([]);
  });

  test('locks execution before releasing a claim lease', async () => {
    const fixture = databaseFixture({
      executeResults: [[{ executionId: EXECUTION_ID }], [{ executionId: EXECUTION_ID }]],
      updateResults: [[{ leaseId: LEASE_ID }], [dispatchableExecutionRow], []],
    });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(
      repository.abandonClaim({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
        leaseId: LEASE_ID,
        runnerId: RUNNER_ID,
        generation: 2,
      }),
    ).resolves.toMatchObject({ state: 'dispatchable' });

    expect(fixture.operations[0]).toBe('execute');
    const lock = render(fixture.statements[0]);
    expect(lock.sql).toContain('FROM kortix.module_executions AS execution');
    expect(lock.sql).toContain("execution.state = 'leased'");
    expect(lock.sql).toContain('FOR UPDATE');
    expect(lock.sql).not.toContain('module_execution_leases');
  });

  test('locks only the execution while validating a live progress append', async () => {
    const fixture = databaseFixture({
      executeResults: [[{ leaseId: LEASE_ID, executionId: EXECUTION_ID }]],
    });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.appendEvidence(appendCommand())).resolves.toMatchObject({
      executionId: EXECUTION_ID,
      sequence: 1,
      eventType: 'runner_progress',
    });

    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.insertedValues).toHaveLength(1);
    const validation = render(fixture.statements[0]);
    expect(validation.sql).toContain('INNER JOIN kortix.module_execution_leases AS lease_row');
    expect(validation.sql).toContain('FOR UPDATE OF execution');
    expect(validation.sql).not.toContain('FOR UPDATE OF lease_row');
    expect(validation.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, EXECUTION_ID, LEASE_ID, RUNNER_ID, 2]),
    );
  });

  test('rejects a progress append without inserting after the live fence is lost', async () => {
    const fixture = databaseFixture({ executeResults: [[]] });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(repository.appendEvidence(appendCommand())).rejects.toMatchObject({
      code: 'MODULE_EXECUTION_LEASE_STALE',
      status: 409,
    });
    expect(fixture.transactionCalls()).toBe(1);
    expect(fixture.insertedValues).toEqual([]);
  });

  test('rejects oversized progress evidence before opening a transaction', async () => {
    const fixture = databaseFixture({ executeResults: [] });
    const repository = createDrizzleModuleExecutionRepository(fixture.database);

    await expect(
      repository.appendEvidence({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
        leaseId: LEASE_ID,
        runnerId: RUNNER_ID,
        generation: 2,
        eventType: 'runner_progress',
        evidence: { payload: 'x'.repeat(262_145) },
      }),
    ).rejects.toMatchObject({ code: 'MODULE_EXECUTION_LEASE_STALE', status: 409 });
    expect(fixture.transactionCalls()).toBe(0);
  });
});
