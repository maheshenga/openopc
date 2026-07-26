import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres, { type Sql } from 'postgres';

import { createPostgresVerificationClaims } from './postgres-claims';

const databaseUrl =
  process.env.MODULE_BETA_TEST_DATABASE_URL ?? process.env.DEVELOPER_TRUST_DATABASE_URL;
const integrationTest = databaseUrl ? test : test.skip;
const schema = `trust_claims_${process.pid}_${Date.now()}`;
let sql: Sql | undefined;
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

async function seedVerification(input: {
  accountId: string;
  artifactId: string;
  releaseId: string;
  runId: string;
  moduleId: string;
}) {
  if (!sql) throw new Error('integration database is unavailable');
  await sql.unsafe(
    `INSERT INTO "${schema}".developer_module_artifacts
      (artifact_id, account_id, artifact_digest, storage_key, size_bytes)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.artifactId, input.accountId, digest('a'), 'developer-modules/artifacts/content', 123],
  );
  await sql.unsafe(
    `INSERT INTO "${schema}".developer_module_releases
      (release_id, account_id, artifact_id, module_id, module_version, manifest)
     VALUES ($1, $2, $3, $4, '1.0.0', $5::jsonb)`,
    [
      input.releaseId,
      input.accountId,
      input.artifactId,
      input.moduleId,
      {
        execution: { mode: 'server-adapter' },
        verification: { profile: 'server-conformance' },
      },
    ],
  );
  await sql.unsafe(
    `INSERT INTO "${schema}".developer_module_verification_runs
      (run_id, release_id, artifact_id, account_id, policy_digest, scanner_set_digest,
       sandbox_profile_digest, attempt, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'queued')`,
    [
      input.runId,
      input.releaseId,
      input.artifactId,
      input.accountId,
      digest('b'),
      digest('c'),
      digest('d'),
    ],
  );
}

function passedFinalization(
  claim: NonNullable<
    Awaited<ReturnType<ReturnType<typeof createPostgresVerificationClaims>['claim']>>
  >,
) {
  return {
    runId: claim.runId,
    workerId: 'worker-a',
    leaseToken: claim.leaseToken,
    leaseGeneration: claim.leaseGeneration,
    artifactDigest: claim.artifactDigest,
    policyDigest: claim.policyDigest,
    scannerSetDigest: claim.scannerSetDigest,
    state: 'passed' as const,
    terminalReason: 'verification completed',
    sbomDigest: digest('e'),
    sbomStorageKey: `developer-trust/evidence/accounts/${claim.accountId}/runs/${claim.runId}/sbom/sha256/${'e'.repeat(64)}.cdx.json`,
    sbomSizeBytes: 4_096,
    resourceSummary: { scanner_count: 5 },
    findings: [
      {
        fingerprint: digest('1'),
        scanner: 'license-policy' as const,
        ruleId: 'license-observed',
        severity: 'info' as const,
        path: null,
        location: null,
        summary: 'license evidence observed',
        disposition: 'observed' as const,
      },
    ],
    attestation: {
      attestationDigest: digest('f'),
      subjectArtifactDigest: claim.artifactDigest,
      predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policyDigest: claim.policyDigest,
      result: 'passed' as const,
      sbomDigest: digest('e'),
      dsseEnvelope: {
        payloadType: 'application/vnd.in-toto+json' as const,
        payload: 'e30=',
        signatures: [{ keyid: 'worker', sig: 'c2ln' }],
      },
      issuer: 'openopc-developer-trust-worker',
    },
  };
}

beforeAll(async () => {
  if (!databaseUrl) return;
  sql = postgres(databaseUrl, { max: 2, prepare: false });
  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`
    CREATE TABLE "${schema}".developer_module_artifacts (
      artifact_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      artifact_digest varchar(71) NOT NULL,
      storage_key text NOT NULL,
      size_bytes bigint NOT NULL
    );
    CREATE TABLE "${schema}".developer_module_releases (
      release_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      artifact_id uuid NOT NULL,
      module_id varchar(128) NOT NULL,
      module_version varchar(128) NOT NULL,
      manifest jsonb NOT NULL,
      runtime_descriptor_path varchar(512),
      runtime_kind varchar(32),
      sbom_digest varchar(71),
      trust_attestation_digest varchar(71),
      verification_policy_digest varchar(71)
    );
    CREATE TABLE "${schema}".developer_module_verification_runs (
      run_id uuid PRIMARY KEY,
      release_id uuid NOT NULL,
      artifact_id uuid NOT NULL,
      account_id uuid NOT NULL,
      policy_digest varchar(71) NOT NULL,
      scanner_set_digest varchar(71) NOT NULL,
      sandbox_profile_digest varchar(71) NOT NULL,
      attempt integer NOT NULL,
      state text NOT NULL,
      lease_owner varchar(128),
      lease_token_hash varchar(71),
      lease_expires_at timestamptz,
      heartbeat_at timestamptz,
      terminal_reason varchar(256),
      sbom_digest varchar(71),
      sbom_storage_key text,
      sbom_size_bytes bigint,
      attestation_digest varchar(71),
      resource_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
      started_at timestamptz,
      finished_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE "${schema}".developer_module_verification_findings (
      finding_id uuid PRIMARY KEY,
      run_id uuid NOT NULL,
      account_id uuid NOT NULL,
      fingerprint varchar(71) NOT NULL,
      scanner varchar(128) NOT NULL,
      rule_id varchar(256) NOT NULL,
      severity text NOT NULL,
      path text,
      location jsonb,
      summary text NOT NULL,
      disposition text NOT NULL
    );
    CREATE TABLE "${schema}".developer_module_trust_attestations (
      attestation_id uuid PRIMARY KEY,
      run_id uuid NOT NULL,
      account_id uuid NOT NULL,
      attestation_digest varchar(71) NOT NULL,
      subject_artifact_digest varchar(71) NOT NULL,
      predicate_type varchar(256) NOT NULL,
      policy_digest varchar(71) NOT NULL,
      result text NOT NULL,
      sbom_digest varchar(71) NOT NULL,
      dsse_envelope jsonb NOT NULL,
      issuer varchar(256) NOT NULL
    )
  `);
});

afterAll(async () => {
  if (!sql || !databaseUrl) return;
  await sql.end({ timeout: 1 });
  const cleanup = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
  try {
    await cleanup.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await cleanup.end({ timeout: 1 });
  }
});

describe('PostgreSQL verification claims', () => {
  integrationTest('reclaim generation fences a stale worker', async () => {
    if (!sql) throw new Error('integration database is unavailable');
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_artifacts
        (artifact_id, account_id, artifact_digest, storage_key, size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        '40000000-0000-4000-a000-000000000004',
        '10000000-0000-4000-a000-000000000001',
        digest('a'),
        'developer-modules/artifacts/private/content',
        123,
      ],
    );
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_releases
        (release_id, account_id, artifact_id, module_id, module_version, manifest)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        '30000000-0000-4000-a000-000000000003',
        '10000000-0000-4000-a000-000000000001',
        '40000000-0000-4000-a000-000000000004',
        'acme.clean',
        '1.0.0',
        {
          execution: { mode: 'server-adapter' },
          verification: { profile: 'server-conformance' },
        },
      ],
    );
    await sql.unsafe(
      `INSERT INTO "${schema}".developer_module_verification_runs
        (run_id, release_id, artifact_id, account_id, policy_digest, scanner_set_digest,
         sandbox_profile_digest, attempt, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'queued')`,
      [
        '50000000-0000-4000-a000-000000000005',
        '30000000-0000-4000-a000-000000000003',
        '40000000-0000-4000-a000-000000000004',
        '10000000-0000-4000-a000-000000000001',
        digest('b'),
        digest('c'),
        digest('d'),
      ],
    );
    const claims = createPostgresVerificationClaims({ sql, schema });

    const first = await claims.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(first).not.toBeNull();
    if (!first) throw new Error('expected initial verification claim');
    await sql.unsafe(
      `UPDATE "${schema}".developer_module_verification_runs
       SET lease_expires_at = now() - interval '1 second'
       WHERE run_id = $1`,
      ['50000000-0000-4000-a000-000000000005'],
    );
    const second = await claims.claim({ workerId: 'worker-b', leaseMs: 30_000 });

    expect(second?.leaseGeneration).toBe((first?.leaseGeneration ?? 0) + 1);
    let staleHeartbeat: unknown;
    try {
      await claims.heartbeat({
        runId: first.runId,
        workerId: 'worker-a',
        leaseToken: first.leaseToken,
        leaseGeneration: first.leaseGeneration,
        leaseMs: 30_000,
      });
    } catch (error) {
      staleHeartbeat = error;
    }
    expect(staleHeartbeat).toMatchObject({ code: 'STALE_VERIFICATION_LEASE' });
  });

  integrationTest('atomically finalizes a passed run and binds its release evidence', async () => {
    if (!sql) throw new Error('integration database is unavailable');
    const identity = {
      accountId: '10000000-0000-4000-a000-000000000006',
      artifactId: '40000000-0000-4000-a000-000000000006',
      releaseId: '30000000-0000-4000-a000-000000000006',
      runId: '50000000-0000-4000-a000-000000000006',
      moduleId: 'acme.passed',
    };
    await seedVerification(identity);
    const claims = createPostgresVerificationClaims({ sql, schema });
    const claim = await claims.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(claim?.runId).toBe(identity.runId);
    if (!claim) throw new Error('expected verification claim');

    await claims.finalize(passedFinalization(claim));

    const rows = await sql.unsafe<
      Array<{
        state: string;
        sbom_digest: string;
        sbom_storage_key: string;
        sbom_size_bytes: string;
        attestation_digest: string;
        release_sbom_digest: string;
        release_attestation_digest: string;
        release_policy_digest: string;
        finding_count: string;
        attestation_count: string;
      }>
    >(
      `SELECT run.state, run.sbom_digest, run.sbom_storage_key,
              run.sbom_size_bytes::text AS sbom_size_bytes, run.attestation_digest,
              release.sbom_digest AS release_sbom_digest,
              release.trust_attestation_digest AS release_attestation_digest,
              release.verification_policy_digest AS release_policy_digest,
              (SELECT count(*)::text FROM "${schema}".developer_module_verification_findings
                WHERE run_id = run.run_id) AS finding_count,
              (SELECT count(*)::text FROM "${schema}".developer_module_trust_attestations
                WHERE run_id = run.run_id) AS attestation_count
       FROM "${schema}".developer_module_verification_runs AS run
       JOIN "${schema}".developer_module_releases AS release
         ON release.release_id = run.release_id
       WHERE run.run_id = $1`,
      [identity.runId],
    );
    expect(rows[0]).toEqual({
      state: 'passed',
      sbom_digest: digest('e'),
      sbom_storage_key: passedFinalization(claim).sbomStorageKey,
      sbom_size_bytes: '4096',
      attestation_digest: digest('f'),
      release_sbom_digest: digest('e'),
      release_attestation_digest: digest('f'),
      release_policy_digest: digest('b'),
      finding_count: '1',
      attestation_count: '1',
    });
  });

  integrationTest(
    'a stale finalization leaves no terminal evidence or release binding',
    async () => {
      if (!sql) throw new Error('integration database is unavailable');
      const identity = {
        accountId: '10000000-0000-4000-a000-000000000007',
        artifactId: '40000000-0000-4000-a000-000000000007',
        releaseId: '30000000-0000-4000-a000-000000000007',
        runId: '50000000-0000-4000-a000-000000000007',
        moduleId: 'acme.stale',
      };
      await seedVerification(identity);
      const claims = createPostgresVerificationClaims({ sql, schema });
      const stale = await claims.claim({ workerId: 'worker-a', leaseMs: 30_000 });
      expect(stale?.runId).toBe(identity.runId);
      if (!stale) throw new Error('expected verification claim');
      await sql.unsafe(
        `UPDATE "${schema}".developer_module_verification_runs
       SET lease_expires_at = now() - interval '1 second' WHERE run_id = $1`,
        [identity.runId],
      );
      const current = await claims.claim({ workerId: 'worker-b', leaseMs: 30_000 });
      expect(current?.runId).toBe(identity.runId);

      let staleFinalization: unknown;
      try {
        await claims.finalize(passedFinalization(stale));
      } catch (error) {
        staleFinalization = error;
      }
      expect(staleFinalization).toMatchObject({ code: 'STALE_VERIFICATION_LEASE' });

      const result = await sql.unsafe<Array<{ snapshot: string }>>(
        `SELECT concat_ws('|', run.state, run.lease_owner,
          coalesce(run.sbom_digest, 'null'), coalesce(run.sbom_storage_key, 'null'),
          coalesce(run.sbom_size_bytes::text, 'null'),
          coalesce(release.sbom_digest, 'null'),
          coalesce(release.trust_attestation_digest, 'null'),
          coalesce(release.verification_policy_digest, 'null'),
          (SELECT count(*) FROM "${schema}".developer_module_verification_findings
            WHERE run_id = run.run_id),
          (SELECT count(*) FROM "${schema}".developer_module_trust_attestations
            WHERE run_id = run.run_id)) AS snapshot
       FROM "${schema}".developer_module_verification_runs AS run
       JOIN "${schema}".developer_module_releases AS release
         ON release.release_id = run.release_id
       WHERE run.run_id = $1`,
        [identity.runId],
      );
      expect(result[0]?.snapshot).toBe('running|worker-b|null|null|null|null|null|null|0|0');
    },
  );

  integrationTest('rejects a finalization that is not bound to the claimed policy', async () => {
    if (!sql) throw new Error('integration database is unavailable');
    const identity = {
      accountId: '10000000-0000-4000-a000-000000000008',
      artifactId: '40000000-0000-4000-a000-000000000008',
      releaseId: '30000000-0000-4000-a000-000000000008',
      runId: '50000000-0000-4000-a000-000000000008',
      moduleId: 'acme.policy-fence',
    };
    await seedVerification(identity);
    const claims = createPostgresVerificationClaims({ sql, schema });
    const claim = await claims.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(claim?.runId).toBe(identity.runId);
    if (!claim) throw new Error('expected verification claim');
    const mismatched = passedFinalization(claim);
    mismatched.policyDigest = digest('9');
    mismatched.attestation.policyDigest = digest('9');

    let rejected: unknown;
    try {
      await claims.finalize(mismatched);
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toMatchObject({ code: 'STALE_VERIFICATION_LEASE' });

    const rows = await sql.unsafe<Array<{ snapshot: string }>>(
      `SELECT concat_ws('|', run.state, coalesce(run.sbom_digest, 'null'),
          coalesce(release.verification_policy_digest, 'null'),
          (SELECT count(*) FROM "${schema}".developer_module_verification_findings
            WHERE run_id = run.run_id),
          (SELECT count(*) FROM "${schema}".developer_module_trust_attestations
            WHERE run_id = run.run_id)) AS snapshot
       FROM "${schema}".developer_module_verification_runs AS run
       JOIN "${schema}".developer_module_releases AS release
         ON release.release_id = run.release_id
       WHERE run.run_id = $1`,
      [identity.runId],
    );
    expect(rows[0]?.snapshot).toBe('running|null|null|0|0');
  });
});
