import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDbFromClient } from '@kortix/db';
import postgres, { type Sql } from 'postgres';

import { createDeveloperArtifactRetentionDatabasePool } from './artifact-retention-bootstrap';
import { createDrizzleDeveloperArtifactRetentionRepository } from './artifacts.drizzle';

// Docker-proxied statements can stall for minutes on a saturated host; the
// generous per-test budget keeps slow environments from masquerading as bugs.
setDefaultTimeout(600_000);

const dockerEnvironment = { ...process.env };
delete dockerEnvironment.DOCKER_HOST;
const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  Bun.spawnSync(['docker', 'version'], {
    env: dockerEnvironment,
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;
const integrationTest = enabled ? test : test.skip;

const container = `kortix-artifact-retention-${crypto.randomUUID().slice(0, 8)}`;
const migrationPaths = [
  '20260724120000000_developer_module_releases.sql',
  '20260724150000000_developer_module_reviews.sql',
  '20260724180000000_developer_module_distribution.sql',
  '20260724210000000_project_module_installation_compatibility.sql',
  '20260725120000000_developer_module_trust.sql',
  '20260726100000000_developer_publishers.sql',
  '20260726120000000_developer_release_lifecycle.sql',
  '20260726130000000_developer_trust_evidence.sql',
  '20260726150000000_developer_artifact_retention.sql',
  '20260727120000000_developer_artifact_retention_role_membership.sql',
].map((name) => resolve(import.meta.dir, '../../../../packages/db/migrations', name));

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const CREATED_BY = '10000000-0000-4000-a000-000000000002';
const PUBLISHER_ID = 'retention-integration';
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let databaseUrl: string | null = null;
let workerDatabaseUrl: string | null = null;
let ungrantedWorkerDatabaseUrl: string | null = null;

function dockerPsql(statement: string): void {
  const result = Bun.spawnSync(
    ['docker', 'exec', '-i', container, 'psql', '-X', '-U', 'postgres', '-d', 'testdb', '-v', 'ON_ERROR_STOP=1'],
    {
      env: dockerEnvironment,
      stdin: Buffer.from(statement),
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`${result.stdout.toString()}${result.stderr.toString()}`);
  }
}

async function startPostgres(): Promise<void> {
  const started = Bun.spawnSync(
    [
      'docker', 'run', '--rm', '-d', '-p', '5432', '--name', container,
      '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ],
    { env: dockerEnvironment, stdout: 'pipe', stderr: 'pipe' },
  );
  if (started.exitCode !== 0) throw new Error(started.stderr.toString());

  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    const probe = Bun.spawnSync(
      ['docker', 'exec', container, 'psql', '-X', '-U', 'postgres', '-d', 'testdb', '-tAc', 'SELECT 1'],
      { env: dockerEnvironment, stdout: 'ignore', stderr: 'ignore' },
    );
    if (probe.exitCode === 0) {
      ready = true;
      break;
    }
    await Bun.sleep(250);
  }
  if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

  const portResult = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
    env: dockerEnvironment,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const port = /:(\d+)\s*$/m.exec(portResult.stdout.toString())?.[1];
  if (!port) throw new Error(`Could not resolve PostgreSQL port: ${portResult.stderr.toString()}`);

  dockerPsql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN;
    CREATE SCHEMA kortix;
    CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
    CREATE TABLE kortix.projects(
      project_id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
      UNIQUE (project_id, account_id)
    );
  `);
  // One psql invocation for the whole chain: docker exec round-trips dominate
  // the suite's wall clock on a loaded host.
  dockerPsql(migrationPaths.map((path) => readFileSync(path, 'utf8')).join('\n'));
  dockerPsql(`
    CREATE ROLE retention_app_login LOGIN PASSWORD 'retention-app-test';
    CREATE ROLE retention_ungranted_login LOGIN PASSWORD 'retention-no-grant';
    GRANT developer_artifact_retention_worker TO retention_app_login;
    BEGIN;
    INSERT INTO kortix.accounts(account_id) VALUES ('${ACCOUNT_ID}');
    INSERT INTO kortix.developer_organizations(
      organization_id, account_id, name, verification_state,
      verification_revision, verification_changed_by, verification_changed_at, created_by
    )
    VALUES ('20000000-0000-4000-a000-000000000001', '${ACCOUNT_ID}', 'Retention Integration',
            'verified', 1, '${CREATED_BY}', now(), '${CREATED_BY}');
    INSERT INTO kortix.developer_publishers(
      publisher_id, account_id, display_name, created_by, organization_id, slug
    )
    VALUES ('${PUBLISHER_ID}', '${ACCOUNT_ID}', 'Retention Integration', '${CREATED_BY}',
            '20000000-0000-4000-a000-000000000001', '${PUBLISHER_ID}');
    INSERT INTO kortix.developer_publisher_members(
      account_id, publisher_id, user_id, role, revision, created_by
    )
    VALUES ('${ACCOUNT_ID}', '${PUBLISHER_ID}', '${CREATED_BY}', 'owner', 0, '${CREATED_BY}');
    COMMIT;
  `);

  databaseUrl = `postgres://postgres:test@127.0.0.1:${port}/testdb`;
  workerDatabaseUrl = `postgres://retention_app_login:retention-app-test@127.0.0.1:${port}/testdb`;
  ungrantedWorkerDatabaseUrl = `postgres://retention_ungranted_login:retention-no-grant@127.0.0.1:${port}/testdb`;
}

// The Windows docker port proxy silently kills TCP connections that sit idle
// across slow neighboring tests; a wedged socket then blocks the driver in a
// read forever. Every test therefore opens fresh short-lived clients, and
// idle_timeout retires any socket before the proxy can strand it.
function openClient(options: { retireIdleSockets?: boolean } = {}): Sql {
  if (!databaseUrl) throw new Error('integration database is unavailable');
  return postgres(databaseUrl, {
    max: 1,
    prepare: false,
    // The role-pinned client must keep its socket: a retired-and-reopened
    // connection would silently drop SET ROLE and run as the login user.
    ...(options.retireIdleSockets === false ? {} : { idle_timeout: 10 }),
    connect_timeout: 60,
  });
}

async function withClients(
  run: (clients: { adminSql: Sql; workerSql: Sql }) => Promise<void>,
): Promise<void> {
  const adminSql = openClient();
  // A dedicated client pinned to the NOLOGIN worker role proves the migration
  // grants cover the entire retention repository.
  const workerSql = openClient({ retireIdleSockets: false });
  try {
    await workerSql.unsafe('SET ROLE developer_artifact_retention_worker');
    await run({ adminSql, workerSql });
  } finally {
    await workerSql.end({ timeout: 5 }).catch(() => undefined);
    await adminSql.end({ timeout: 5 }).catch(() => undefined);
  }
}

async function seedUpload(
  adminSql: Sql,
  input: {
    uploadId: string;
    state: 'created' | 'cancelled';
    storageKey: string;
  },
): Promise<void> {
  await adminSql.unsafe(
    `INSERT INTO kortix.developer_module_artifact_uploads
       (upload_id, account_id, publisher_id, state, expected_digest, expected_size,
        staging_storage_key, expires_at, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4::kortix.developer_artifact_upload_state, $5, 128, $6,
             now() - interval '1 hour', $7, now() - interval '2 hours', now() - interval '2 hours')`,
    [input.uploadId, ACCOUNT_ID, PUBLISHER_ID, input.state, `sha256:${'a'.repeat(64)}`, input.storageKey, CREATED_BY],
  );
}

// Leases far above any load-induced scheduling delay keep every fencing
// assertion deterministic on a busy CI host.
const LEASE_MS = 30 * 60_000;

async function drainQueue(
  repository: ReturnType<typeof createDrizzleDeveloperArtifactRetentionRepository>,
): Promise<void> {
  for (let i = 0; i < 32; i += 1) {
    const run = await repository.claimRun({ ownerId: 'queue-drain', leaseMs: LEASE_MS });
    if (!run) return;
    await repository.retryRun({
      runId: run.runId,
      ownerId: 'queue-drain',
      errorCode: 'RETENTION_REPOSITORY_FAILED',
      delayMs: 60_000,
      terminal: true,
    });
  }
  throw new Error('retention queue did not drain');
}

// Claim until the requested acceptance run surfaces, terminally releasing any
// stragglers earlier tests may have left claimable under heavy load.
async function claimRunFor(
  repository: ReturnType<typeof createDrizzleDeveloperArtifactRetentionRepository>,
  input: { acceptanceRunId: string; ownerId: string },
): Promise<NonNullable<Awaited<ReturnType<typeof repository.claimRun>>>> {
  for (let i = 0; i < 32; i += 1) {
    const run = await repository.claimRun({ ownerId: input.ownerId, leaseMs: LEASE_MS });
    if (!run) break;
    if (run.acceptanceRunId === input.acceptanceRunId) return run;
    await repository.retryRun({
      runId: run.runId,
      ownerId: input.ownerId,
      errorCode: 'RETENTION_REPOSITORY_FAILED',
      delayMs: 60_000,
      terminal: true,
    });
  }
  throw new Error(`expected a claimable retention run for ${input.acceptanceRunId}`);
}

beforeAll(async () => {
  if (!enabled) return;
  await startPostgres();
});

afterAll(async () => {
  if (enabled) {
    Bun.spawnSync(['docker', 'rm', '-f', container], {
      env: dockerEnvironment,
      stdout: 'ignore',
      stderr: 'ignore',
    });
  }
});

describe('developer artifact retention PostgreSQL repository', () => {
  integrationTest('normalizes real driver Date rows and enqueues idempotently', async () => {
    await withClients(async ({ adminSql }) => {
      const repository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(adminSql),
      );

      const first = await repository.enqueueRun({
        acceptanceRunId: 'module-beta:int-1',
        delayMs: 0,
      });
      expect(first.state).toBe('queued');
      expect(first.attempts).toBe(0);
      expect(first.availableAt).toMatch(ISO_UTC);
      expect(first.createdAt).toMatch(ISO_UTC);
      expect(first.updatedAt).toMatch(ISO_UTC);
      expect(first.finishedAt).toBeNull();

      const replay = await repository.enqueueRun({
        acceptanceRunId: 'module-beta:int-1',
        delayMs: 60_000,
      });
      expect(replay.runId).toBe(first.runId);
      expect(replay.availableAt).toBe(first.availableAt);

      const scheduled = await repository.enqueueRun({ acceptanceRunId: null, delayMs: 0 });
      const coalesced = await repository.enqueueRun({ acceptanceRunId: null, delayMs: 0 });
      expect(coalesced.runId).toBe(scheduled.runId);
    });
  });

  integrationTest('skips locked rows without blocking and claims each run exactly once', async () => {
    await withClients(async ({ adminSql, workerSql }) => {
      const repository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(adminSql),
      );
      const workerRepository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(workerSql),
      );
      await drainQueue(repository);
      const enqueued = [];
      for (const acceptanceRunId of ['module-beta:int-2a', 'module-beta:int-2b', 'module-beta:int-2c']) {
        enqueued.push(await repository.enqueueRun({ acceptanceRunId, delayMs: 0 }));
      }
      expect(new Set(enqueued.map((run) => run.runId)).size).toBe(3);

      // Hold a row lock on the first claimable run from one connection and
      // claim from another: FOR UPDATE SKIP LOCKED must neither block on the
      // locked row nor double-claim it, binding one of the other runs instead.
      let lockedRunId = '';
      const claimedUnderLock = await adminSql.begin(async (lockTx) => {
        const [head] = await lockTx.unsafe<Array<{ run_id: string }>>(
          `SELECT run_id FROM kortix.developer_artifact_retention_runs
           WHERE state = 'queued'
           ORDER BY created_at ASC, run_id ASC
           LIMIT 1
           FOR UPDATE`,
        );
        if (!head) throw new Error('expected a claimable retention run to lock');
        lockedRunId = head.run_id;
        return workerRepository.claimRun({
          ownerId: 'worker-a',
          leaseMs: LEASE_MS,
        });
      });
      if (!claimedUnderLock) throw new Error('expected a claim that skips the locked run');
      expect(claimedUnderLock.runId).not.toBe(lockedRunId);

      // With the lock released, the remaining runs claim exactly once each
      // with one atomic attempt and a database-computed lease window.
      const claimed = [claimedUnderLock];
      for (const ownerId of ['worker-b', 'worker-c']) {
        const run = await repository.claimRun({ ownerId, leaseMs: LEASE_MS });
        if (!run) throw new Error('expected a claimable retention run');
        claimed.push(run);
      }
      expect(new Set(claimed.map((run) => run.runId)).size).toBe(3);
      expect(claimed.map((run) => run.runId).sort()).toEqual(
        enqueued.map((run) => run.runId).sort(),
      );
      for (const run of claimed) {
        expect(run.attempts).toBe(1);
        expect(run.leaseExpiresAt).toMatch(ISO_UTC);
        expect(run.claimedAt).toMatch(ISO_UTC);
        expect(Date.parse(run.leaseExpiresAt) - Date.parse(run.claimedAt)).toBe(LEASE_MS);
      }
      await expect(
        repository.claimRun({ ownerId: 'worker-d', leaseMs: LEASE_MS }),
      ).resolves.toBeNull();

      // Release every claimed run terminally so later tests own the queue.
      for (const run of claimed) {
        await expect(
          repository.retryRun({
            runId: run.runId,
            ownerId: run.leaseOwner,
            errorCode: 'RETENTION_REPOSITORY_FAILED',
            delayMs: 60_000,
            terminal: true,
          }),
        ).resolves.toBe(true);
      }
    });
  });

  integrationTest('runs the full upload cleanup path under the NOLOGIN worker role', async () => {
    await withClients(async ({ adminSql, workerSql }) => {
      const repository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(workerSql),
      );
      const storageKey = `developer-modules/staging/${'b'.repeat(64)}/cleanup`;
      const uploadId = '80000000-0000-4000-a000-000000000101';
      await seedUpload(adminSql, { uploadId, state: 'created', storageKey });

      await repository.enqueueRun({ acceptanceRunId: 'module-beta:int-3', delayMs: 0 });
      const run = await claimRunFor(repository, {
        acceptanceRunId: 'module-beta:int-3',
        ownerId: 'worker-role',
      });

      const candidates = await repository.claimUploadCandidates({
        runId: run.runId,
        ownerId: 'worker-role',
        limit: 1,
      });
      expect(candidates).toEqual([
        {
          accountId: ACCOUNT_ID,
          uploadId,
          state: 'expired',
          storageKey,
          cleanupAttempts: 0,
        },
      ]);

      // Renewal moves the run lease and the claimed upload token together.
      const renewal = await repository.renewRunLease({
        runId: run.runId,
        ownerId: 'worker-role',
        leaseMs: LEASE_MS + 60_000,
      });
      expect(renewal.valid).toBe(true);
      expect(renewal.now).toMatch(ISO_UTC);
      const [aligned] = await adminSql.unsafe<
        Array<{ aligned: boolean }>
      >(
        `SELECT upload.cleanup_next_attempt_at = run.lease_expires_at AS aligned
         FROM kortix.developer_module_artifact_uploads upload,
              kortix.developer_artifact_retention_runs run
         WHERE upload.upload_id = $1 AND run.run_id = $2`,
        [uploadId, run.runId],
      );
      expect(aligned?.aligned).toBe(true);
      await expect(
        repository.renewRunLease({ runId: run.runId, ownerId: 'someone-else', leaseMs: 60_000 }),
      ).resolves.toMatchObject({ valid: false });

      await expect(
        repository.isStagingKeyReferenced({
          runId: run.runId,
          ownerId: 'worker-role',
          storageKey,
        }),
      ).resolves.toEqual({ leaseValid: true, referenced: true });
      await expect(
        repository.markUploadDeleted({
          runId: run.runId,
          ownerId: 'worker-role',
          accountId: ACCOUNT_ID,
          uploadId,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.isStagingKeyReferenced({
          runId: run.runId,
          ownerId: 'worker-role',
          storageKey,
        }),
      ).resolves.toEqual({ leaseValid: true, referenced: false });
      await expect(
        repository.completeRun({ runId: run.runId, ownerId: 'worker-role' }),
      ).resolves.toBe(true);

      const [state] = await adminSql.unsafe<
        Array<{ state: string; staging_deleted_at: unknown; cleanup_next_attempt_at: unknown }>
      >(
        `SELECT upload.state::text AS state, upload.staging_deleted_at, upload.cleanup_next_attempt_at
         FROM kortix.developer_module_artifact_uploads upload
         WHERE upload.upload_id = $1`,
        [uploadId],
      );
      expect(state?.state).toBe('expired');
      expect(state?.staging_deleted_at).not.toBeNull();
      expect(state?.cleanup_next_attempt_at).toBeNull();
    });
  });

  integrationTest('pins every connection to the worker role through startup parameters', async () => {
    const adminSql = openClient();
    if (!workerDatabaseUrl) throw new Error('integration worker database is unavailable');
    const workerSql = postgres(workerDatabaseUrl, {
      max: 1,
      prepare: false,
      connect_timeout: 60,
      connection: {
        role: 'developer_artifact_retention_worker',
        statement_timeout: 25_000,
      },
    });
    try {
      const [membership] = await adminSql<
        Array<{ migration_login_is_direct_member: boolean }>
      >`
        SELECT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members membership
          JOIN pg_catalog.pg_roles granted_role
            ON granted_role.oid = membership.roleid
          JOIN pg_catalog.pg_roles member_role
            ON member_role.oid = membership.member
          WHERE granted_role.rolname = 'developer_artifact_retention_worker'
            AND member_role.rolname = 'postgres'
        ) AS migration_login_is_direct_member
      `;
      expect(membership?.migration_login_is_direct_member).toBe(false);

      const [identity] = await workerSql<Array<{ current_user: string }>>`
        SELECT current_user::text AS current_user
      `;
      expect(identity?.current_user).toBe('developer_artifact_retention_worker');

      const repository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(workerSql),
      );
      const storageKey = `developer-modules/staging/${'d'.repeat(64)}/startup-role`;
      const uploadId = '80000000-0000-4000-a000-000000000103';
      await seedUpload(adminSql, { uploadId, state: 'created', storageKey });

      await repository.enqueueRun({ acceptanceRunId: 'module-beta:int-5', delayMs: 0 });
      const run = await claimRunFor(repository, {
        acceptanceRunId: 'module-beta:int-5',
        ownerId: 'startup-role-worker',
      });
      const candidates = await repository.claimUploadCandidates({
        runId: run.runId,
        ownerId: 'startup-role-worker',
        limit: 1,
      });
      expect(candidates.map((candidate) => candidate.uploadId)).toEqual([uploadId]);
      await expect(
        repository.markUploadDeleted({
          runId: run.runId,
          ownerId: 'startup-role-worker',
          accountId: ACCOUNT_ID,
          uploadId,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.completeRun({ runId: run.runId, ownerId: 'startup-role-worker' }),
      ).resolves.toBe(true);
      await expect(
        workerSql.unsafe('DELETE FROM kortix.developer_artifact_retention_runs'),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      await workerSql.end({ timeout: 5 }).catch(() => undefined);
      await adminSql.end({ timeout: 5 }).catch(() => undefined);
    }
  });

  integrationTest('diagnoses startup role membership missing for an ungranted login', async () => {
    if (!ungrantedWorkerDatabaseUrl) {
      throw new Error('integration ungranted worker database is unavailable');
    }
    const pool = createDeveloperArtifactRetentionDatabasePool({
      databaseUrl: ungrantedWorkerDatabaseUrl,
    });
    try {
      await expect(pool.assertReady()).rejects.toThrow(
        'GRANT developer_artifact_retention_worker TO retention_ungranted_login;',
      );
    } finally {
      await pool.close().catch(() => undefined);
    }
  });

  integrationTest('keeps retry attempts claim-only and enforces least-privilege denials', async () => {
    await withClients(async ({ adminSql, workerSql }) => {
      const repository = createDrizzleDeveloperArtifactRetentionRepository(
        createDbFromClient(workerSql),
      );
      const storageKey = `developer-modules/staging/${'c'.repeat(64)}/failure`;
      const uploadId = '80000000-0000-4000-a000-000000000102';
      await seedUpload(adminSql, { uploadId, state: 'cancelled', storageKey });

      await repository.enqueueRun({ acceptanceRunId: 'module-beta:int-4', delayMs: 0 });
      const run = await claimRunFor(repository, {
        acceptanceRunId: 'module-beta:int-4',
        ownerId: 'worker-role',
      });
      expect(run.attempts).toBe(1);

      const candidates = await repository.claimUploadCandidates({
        runId: run.runId,
        ownerId: 'worker-role',
        limit: 1,
      });
      expect(candidates.map((candidate) => candidate.uploadId)).toEqual([uploadId]);
      await expect(
        repository.recordUploadFailure({
          runId: run.runId,
          ownerId: 'worker-role',
          accountId: ACCOUNT_ID,
          uploadId,
          errorCode: 'RETENTION_OBJECT_STORE_FAILED',
          delayMs: 30_000,
        }),
      ).resolves.toBe(true);
      await expect(
        repository.retryRun({
          runId: run.runId,
          ownerId: 'worker-role',
          errorCode: 'RETENTION_OBJECT_STORE_FAILED',
          delayMs: 5_000,
          terminal: false,
        }),
      ).resolves.toBe(true);

      const [row] = await adminSql.unsafe<
        Array<{ state: string; attempts: number; cleanup_attempts: number; delay_ok: boolean }>
      >(
        `SELECT run.state::text AS state, run.attempts,
                upload.cleanup_attempts,
                run.available_at > now() AS delay_ok
         FROM kortix.developer_artifact_retention_runs run,
              kortix.developer_module_artifact_uploads upload
         WHERE run.run_id = $1 AND upload.upload_id = $2`,
        [run.runId, uploadId],
      );
      expect(row?.state).toBe('queued');
      // The claim consumed the only attempt; retryRun must not double count.
      expect(row?.attempts).toBe(1);
      expect(row?.cleanup_attempts).toBe(1);
      expect(row?.delay_ok).toBe(true);

      // The NOLOGIN role has no DELETE grant and no reach into artifact content.
      await expect(
        workerSql.unsafe('DELETE FROM kortix.developer_artifact_retention_runs'),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        workerSql.unsafe('SELECT 1 FROM kortix.developer_module_artifacts LIMIT 1'),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});
