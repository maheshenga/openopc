import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Database } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { FinalizeVerificationInput } from './verification';
import { createDrizzleDeveloperModuleVerificationRepository } from './verification.drizzle';

const RUN_ID = '50000000-0000-4000-a000-000000000005';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const ARTIFACT_ID = '40000000-0000-4000-a000-000000000004';
const LEASE_TOKEN = 'A'.repeat(43);
const LEASE_TOKEN_HASH = `sha256:${createHash('sha256').update(LEASE_TOKEN).digest('hex')}`;

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    releaseId: RELEASE_ID,
    accountId: ACCOUNT_ID,
    artifactId: ARTIFACT_ID,
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    scannerSetDigest: `sha256:${'c'.repeat(64)}`,
    sandboxProfileDigest: `sha256:${'d'.repeat(64)}`,
    attempt: 1,
    state: 'running',
    leaseOwner: 'worker-a',
    leaseTokenHash: LEASE_TOKEN_HASH,
    leaseExpiresAt: '2026-07-25T01:01:00.000Z',
    heartbeatAt: '2026-07-25T01:00:00.000Z',
    terminalReason: null,
    sbomDigest: null,
    attestationDigest: null,
    startedAt: '2026-07-25T01:00:00.000Z',
    finishedAt: null,
    createdAt: '2026-07-25T01:00:00.000Z',
    updatedAt: '2026-07-25T01:00:00.000Z',
    ...overrides,
  };
}

function finalization(): FinalizeVerificationInput {
  return {
    runId: RUN_ID,
    workerId: 'worker-a',
    leaseToken: LEASE_TOKEN,
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    policyDigest: `sha256:${'b'.repeat(64)}`,
    scannerSetDigest: `sha256:${'c'.repeat(64)}`,
    result: 'passed',
    terminalReason: 'verification completed',
    sbomDigest: `sha256:${'e'.repeat(64)}`,
    resourceSummary: { cpu_ms: 100 },
    findings: [],
    attestation: {
      attestationDigest: `sha256:${'f'.repeat(64)}`,
      subjectArtifactDigest: `sha256:${'a'.repeat(64)}`,
      predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policyDigest: `sha256:${'b'.repeat(64)}`,
      result: 'passed',
      sbomDigest: `sha256:${'e'.repeat(64)}`,
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: 'redacted' },
      issuer: 'openopc-developer-trust-worker',
    },
  };
}

function render(statement: unknown) {
  return new PgDialect().sqlToQuery(statement as never);
}

describe('developer module verification Drizzle repository', () => {
  test('claims with SKIP LOCKED and persists only the lease token hash', async () => {
    const statements: unknown[] = [];
    const transaction = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [
          {
            runId: RUN_ID,
            releaseId: RELEASE_ID,
            accountId: ACCOUNT_ID,
            artifactId: ARTIFACT_ID,
            artifactDigest: `sha256:${'a'.repeat(64)}`,
            policyDigest: `sha256:${'b'.repeat(64)}`,
            scannerSetDigest: `sha256:${'c'.repeat(64)}`,
            attempt: 1,
            leaseExpiresAt: '2026-07-25T01:00:30.000Z',
          },
        ];
      },
    };
    const database = {
      async transaction(run: (tx: typeof transaction) => Promise<unknown>) {
        return run(transaction);
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database, {
      now: () => new Date('2026-07-25T01:00:00.000Z'),
      createLeaseToken: () => 'A'.repeat(43),
    });

    const claim = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    const query = render(statements[0]);
    expect(query.sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.sql).toContain('lease_token_hash');
    expect(query.params).toContain(
      `sha256:${createHash('sha256').update('A'.repeat(43)).digest('hex')}`,
    );
    expect(query.params).not.toContain('A'.repeat(43));
    expect(claim).toMatchObject({ runId: RUN_ID, leaseToken: 'A'.repeat(43) });
  });

  test('keeps publisher trust reads account-qualified', async () => {
    const statements: unknown[] = [];
    const database = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [];
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database);

    await expect(repository.getPublisherView(ACCOUNT_ID, RELEASE_ID)).resolves.toBeNull();
    const query = render(statements[0]);
    expect(query.params).toEqual(expect.arrayContaining([ACCOUNT_ID, RELEASE_ID]));
    expect(query.sql).not.toMatch(/storage_key|lease_token_hash|dsse_envelope/i);
  });

  test('finalizes attestation, release binding, and capability revocation in one transaction', async () => {
    const statements: unknown[] = [];
    let transactionCalls = 0;
    let call = 0;
    const transaction = {
      async execute(statement: unknown) {
        statements.push(statement);
        call += 1;
        if (call === 1) return [runRow()];
        if (call === 3) {
          return [
            runRow({
              state: 'passed',
              leaseOwner: null,
              leaseExpiresAt: null,
              terminalReason: 'verification completed',
              sbomDigest: `sha256:${'e'.repeat(64)}`,
              attestationDigest: `sha256:${'f'.repeat(64)}`,
              finishedAt: '2026-07-25T01:00:00.000Z',
            }),
          ];
        }
        if (call === 4) return [{ release_id: RELEASE_ID }];
        return [];
      },
    };
    const database = {
      async transaction(run: (tx: typeof transaction) => Promise<unknown>) {
        transactionCalls += 1;
        return run(transaction);
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database, {
      now: () => new Date('2026-07-25T01:00:00.000Z'),
    });

    await expect(repository.finalize(finalization())).resolves.toMatchObject({ state: 'passed' });
    const rendered = statements.map((statement) => render(statement).sql).join('\n');
    expect(transactionCalls).toBe(1);
    expect(rendered).toContain('INSERT INTO kortix.developer_module_trust_attestations');
    expect(rendered).toContain('UPDATE kortix.developer_module_verification_runs');
    expect(rendered).toContain('UPDATE kortix.developer_module_releases');
    expect(rendered).toContain('UPDATE kortix.developer_module_verification_capabilities');
  });

  test('rolls back passed finalization when the release trust binding loses a race', async () => {
    let call = 0;
    const transaction = {
      async execute() {
        call += 1;
        if (call === 1) return [runRow()];
        if (call === 3) {
          return [
            runRow({
              state: 'passed',
              leaseOwner: null,
              leaseExpiresAt: null,
              terminalReason: 'verification completed',
              sbomDigest: `sha256:${'e'.repeat(64)}`,
              attestationDigest: `sha256:${'f'.repeat(64)}`,
              finishedAt: '2026-07-25T01:00:00.000Z',
            }),
          ];
        }
        return [];
      },
    };
    const database = {
      async transaction(run: (tx: typeof transaction) => Promise<unknown>) {
        return run(transaction);
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database, {
      now: () => new Date('2026-07-25T01:00:00.000Z'),
    });

    await expect(repository.finalize(finalization())).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_CONFLICT',
      status: 409,
    });
  });

  test('heartbeats with a token hash and fails closed after the lease fence is lost', async () => {
    const statements: unknown[] = [];
    const database = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [];
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database, {
      now: () => new Date('2026-07-25T01:00:00.000Z'),
    });

    await expect(
      repository.heartbeat({
        runId: RUN_ID,
        workerId: 'worker-a',
        leaseToken: LEASE_TOKEN,
        leaseMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_LEASE_LOST' });
    const query = render(statements[0]);
    expect(query.params).toContain(LEASE_TOKEN_HASH);
    expect(query.params).not.toContain(LEASE_TOKEN);
  });

  test('retries terminal attempts and account-qualifies cancellation', async () => {
    const statements: unknown[] = [];
    const retriedRow = runRow({
      state: 'queued',
      attempt: 2,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    const cancelRow = runRow({
      state: 'cancelled',
      leaseOwner: null,
      leaseExpiresAt: null,
      terminalReason: 'cancelled by publisher',
      finishedAt: '2026-07-25T01:00:00.000Z',
    });
    const transaction = {
      async execute(statement: unknown) {
        statements.push(statement);
        return statements.length === 2 ? [cancelRow] : [];
      },
    };
    const database = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [retriedRow];
      },
      async transaction(run: (tx: typeof transaction) => Promise<unknown>) {
        return run(transaction);
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database, {
      now: () => new Date('2026-07-25T01:00:00.000Z'),
    });

    await expect(
      repository.retry({
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        policyDigest: `sha256:${'b'.repeat(64)}`,
        scannerSetDigest: `sha256:${'c'.repeat(64)}`,
        sandboxProfileDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).resolves.toMatchObject({ state: 'queued', attempt: 2 });
    await expect(
      repository.cancel({
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        reason: 'cancelled by publisher',
      }),
    ).resolves.toMatchObject({ state: 'cancelled' });

    const rendered = statements.map((statement) => render(statement));
    expect(rendered[0]?.sql).toContain(
      "latest.state IN ('passed', 'failed', 'inconclusive', 'cancelled')",
    );
    expect(rendered[0]?.sql).toContain("active.state IN ('queued', 'running')");
    expect(rendered[0]?.params).toContain(ACCOUNT_ID);
    expect(rendered[1]?.params).toEqual(expect.arrayContaining([RELEASE_ID, ACCOUNT_ID]));
  });

  test('hides release existence when a publisher retries across accounts', async () => {
    const statements: unknown[] = [];
    const database = {
      async execute(statement: unknown) {
        statements.push(statement);
        return [];
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database);

    await expect(
      repository.retry({
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        policyDigest: `sha256:${'b'.repeat(64)}`,
        scannerSetDigest: `sha256:${'c'.repeat(64)}`,
        sandboxProfileDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 });

    expect(statements).toHaveLength(2);
    const existenceQuery = render(statements[1]);
    expect(existenceQuery.params).toEqual(expect.arrayContaining([RELEASE_ID, ACCOUNT_ID]));
  });

  test('reports retry conflict when the account-scoped release exists', async () => {
    let call = 0;
    const database = {
      async execute() {
        call += 1;
        return call === 2 ? [{ release_id: RELEASE_ID }] : [];
      },
    } as unknown as Database;
    const repository = createDrizzleDeveloperModuleVerificationRepository(database);

    await expect(
      repository.retry({
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        policyDigest: `sha256:${'b'.repeat(64)}`,
        scannerSetDigest: `sha256:${'c'.repeat(64)}`,
        sandboxProfileDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED',
      status: 409,
    });
  });
});
