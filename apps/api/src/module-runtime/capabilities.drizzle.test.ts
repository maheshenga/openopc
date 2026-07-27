import { describe, expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import type { CapabilityTokenClaimsV1 } from '@openopc/module-runtime-contracts';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createDrizzleModuleCapabilityConsumer } from '../../../module-egress-proxy/src/capabilities.drizzle';
import { createDrizzleModuleCapabilityPersistence } from './capabilities.drizzle';
import type { ModuleExecutionRepository } from './executions';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const EXECUTION_ID = '80000000-0000-4000-a000-000000000001';
const LEASE_ID = '90000000-0000-4000-a000-000000000001';
const RUNNER_ID = '70000000-0000-4000-a000-000000000001';
const GRANT_ID = 'a1000000-0000-4000-8000-000000000001';
const OBSERVED_AT = '2099-07-27T08:00:01.000Z';

function claims(): CapabilityTokenClaimsV1 {
  return {
    capabilityVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:capability/egress',
    sub: EXECUTION_ID,
    jti: 'a0000000-0000-4000-8000-000000000001',
    iat: '2099-07-27T08:00:00.000Z',
    exp: '2099-07-27T08:00:20.000Z',
    grantId: GRANT_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    releaseDigest: `sha256:${'a'.repeat(64)}`,
    actor: { type: 'runner', id: RUNNER_ID },
    action: 'http.request',
    runtimeKind: 'wasi-component',
    lease: {
      id: LEASE_ID,
      generation: 3,
      deadline: '2099-07-27T08:00:30.000Z',
    },
    killSwitchGeneration: 4,
    cnf: { certificateSha256: 'b'.repeat(64) },
    ceilings: {
      maxCalls: 1,
      maxRequestBytes: 16,
      maxResponseBytes: 32,
      cpuMillis: 2_000,
      wallTimeMs: 5_000,
      costMicro: 50_000,
    },
    egress: { origins: ['https://api.example.com'], methods: ['POST'] },
  };
}

function databaseFixture(executeResults: unknown[][]) {
  const results = [...executeResults];
  const operations: Array<'execute' | 'insert'> = [];
  const statements: unknown[] = [];
  const insertedValues: unknown[] = [];
  const transaction = {
    async execute(statement: unknown) {
      operations.push('execute');
      statements.push(statement);
      return results.shift() ?? [];
    },
    insert() {
      operations.push('insert');
      return {
        async values(value: unknown) {
          insertedValues.push(value);
        },
      };
    },
  };
  const database = {
    async transaction(run: (tx: typeof transaction) => Promise<unknown>) {
      return run(transaction);
    },
  } as unknown as Database;
  return { database, operations, statements, insertedValues };
}

function render(statement: unknown) {
  return new PgDialect().sqlToQuery(statement as never);
}

describe('drizzle module capability consumer', () => {
  test('locks execution, lease, then grant before atomically recording one bounded use', async () => {
    const fixture = databaseFixture([
      [{ executionId: EXECUTION_ID }],
      [{ leaseId: LEASE_ID }],
      [{ grantId: GRANT_ID }],
      [{ useCount: 0 }],
    ]);
    const consumer = createDrizzleModuleCapabilityConsumer(fixture.database);

    await expect(
      consumer.consume({
        tokenHash: `sha256:${'c'.repeat(64)}`,
        claims: claims(),
        observedAt: OBSERVED_AT,
      }),
    ).resolves.toBe(true);

    expect(fixture.operations).toEqual(['execute', 'execute', 'execute', 'execute', 'insert']);
    const executionLock = render(fixture.statements[0]);
    const leaseLock = render(fixture.statements[1]);
    const grantLock = render(fixture.statements[2]);
    expect(executionLock.sql).toContain('FROM kortix.module_executions AS execution');
    expect(executionLock.sql).toContain('FOR UPDATE');
    expect(executionLock.sql).toContain('kill_switch_generation');
    expect(leaseLock.sql).toContain('FROM kortix.module_execution_leases AS lease_row');
    expect(leaseLock.sql).toContain('FOR UPDATE');
    expect(grantLock.sql).toContain('FROM kortix.module_capability_grants AS grant_row');
    expect(grantLock.sql).toContain('FOR UPDATE');
    expect(fixture.insertedValues).toEqual([
      {
        grantId: GRANT_ID,
        executionId: EXECUTION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  test('stores a signed grant through the fenced execution repository', async () => {
    const commands: unknown[] = [];
    const repository = {
      async storeCapabilityGrants(command: unknown) {
        commands.push(structuredClone(command));
        return [
          {
            grantId: GRANT_ID,
            executionId: EXECUTION_ID,
            accountId: ACCOUNT_ID,
            projectId: PROJECT_ID,
            leaseId: LEASE_ID,
            audience: 'egress' as const,
            tokenHash: `sha256:${'c'.repeat(64)}` as const,
            expiresAt: '2099-07-27T08:00:20.000Z',
            revokedAt: null,
            createdAt: OBSERVED_AT,
          },
        ];
      },
    } as Pick<ModuleExecutionRepository, 'storeCapabilityGrants'>;
    const persistence = createDrizzleModuleCapabilityPersistence({} as Database, repository);

    await expect(
      persistence.store({
        grantId: GRANT_ID,
        executionId: EXECUTION_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        leaseId: LEASE_ID,
        runnerId: RUNNER_ID,
        leaseGeneration: 3,
        audience: 'egress',
        tokenHash: `sha256:${'c'.repeat(64)}`,
        expiresAt: '2099-07-27T08:00:20.000Z',
      }),
    ).resolves.toMatchObject({ grantId: GRANT_ID });
    expect(commands).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
        leaseId: LEASE_ID,
        runnerId: RUNNER_ID,
        generation: 3,
        grants: [
          {
            grantId: GRANT_ID,
            audience: 'egress',
            tokenHash: `sha256:${'c'.repeat(64)}`,
            expiresAt: '2099-07-27T08:00:20.000Z',
          },
        ],
      },
    ]);
  });

  test('rejects replay after the signed call ceiling without recording another use', async () => {
    const fixture = databaseFixture([
      [{ executionId: EXECUTION_ID }],
      [{ leaseId: LEASE_ID }],
      [{ grantId: GRANT_ID }],
      [{ useCount: 1 }],
    ]);
    const consumer = createDrizzleModuleCapabilityConsumer(fixture.database);

    await expect(
      consumer.consume({
        tokenHash: `sha256:${'c'.repeat(64)}`,
        claims: claims(),
        observedAt: OBSERVED_AT,
      }),
    ).resolves.toBe(false);
    expect(fixture.operations).toEqual(['execute', 'execute', 'execute', 'execute']);
    expect(fixture.insertedValues).toEqual([]);
  });

  test('revokes grants only through tenant-qualified execution coordinates', async () => {
    const statements: unknown[] = [];
    const database = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [{ grantId: GRANT_ID }, { grantId: 'a2000000-0000-4000-8000-000000000002' }];
      },
    } as unknown as Database;
    const repository = {
      async storeCapabilityGrants() {
        return [];
      },
    } as Pick<ModuleExecutionRepository, 'storeCapabilityGrants'>;
    const persistence = createDrizzleModuleCapabilityPersistence(database, repository);

    await expect(
      persistence.revokeByExecution({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
        revokedAt: OBSERVED_AT,
      }),
    ).resolves.toBe(2);
    const statement = render(statements[0]);
    expect(statement.sql).toContain('grant_row.account_id');
    expect(statement.sql).toContain('grant_row.project_id');
    expect(statement.sql).toContain('grant_row.execution_id');
    expect(statement.sql).toContain('grant_row.revoked_at IS NULL');
    expect(statement.params).toEqual(
      expect.arrayContaining([ACCOUNT_ID, PROJECT_ID, EXECUTION_ID, OBSERVED_AT]),
    );
  });
});
