import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, createPrivateKey, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createModuleBetaAcceptanceHandler } from '../../../apps/module-beta-acceptance-controller/src/http';
import { validateEvidenceLedger } from '../../../scripts/release/module-beta-targets';
import { generateTrustFixtures } from './fixtures';
import {
  acceptanceRequestHeaders,
  assertAllowedPresignedUploadUrl,
  assertImmutableAttempt,
  assertOpaqueNotFoundResponses,
  assertPinnedControlIdentity,
  assertTrustStagingTargets,
  buildTrustRegistration,
  buildTrustServiceUrl,
  canonicalJson,
  dssePreAuthEncoding,
  loadTrustStagingConfig,
  readBoundedJsonResponse,
  signEvidenceDocument,
  updateTrustEvidenceLedger,
  validateEvidence,
  validateTerminalAttempt,
  verifyCleanupPreservesImmutableAttempts,
  verifyDsseEnvelope,
  verifyInspectorAttestation,
  verifySignedEvidenceDocument,
  verifyStoredEvidence,
  waitForImmutableTrustAttempt,
  waitForModuleBetaCleanup,
} from './run';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('a trust gate record cannot pass without real dependency identities', () => {
  expect(() =>
    validateEvidence({
      gate: 'G3',
      lane: 'integration',
      outcome: 'passed',
      dependencyIdentities: [],
    }),
  ).toThrow('EVIDENCE_DEPENDENCY_IDENTITY_REQUIRED');
});

test('acceptance controller responses cannot replace the configured control identity', () => {
  const pinned = `trust-acceptance-controller@1.0.0#sha256:${'c'.repeat(64)}`;
  expect(assertPinnedControlIdentity(pinned, pinned)).toBe(pinned);
  expect(() =>
    assertPinnedControlIdentity(
      `trust-acceptance-controller@1.0.1#sha256:${'d'.repeat(64)}`,
      pinned,
    ),
  ).toThrow('TRUST_CONTROL_IDENTITY_MISMATCH');
});

test('harness authentication carries the run binding required by the real controller', async () => {
  const acceptanceRunId = 'gha:12345:1';
  const controlToken = 'acceptance-control-token-for-staging';
  const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'c'.repeat(64)}`;
  const accountId = '10000000-0000-4000-a000-000000000001';
  const artifactId = '20000000-0000-4000-a000-000000000002';
  const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
  let registrations = 0;
  const handler = createModuleBetaAcceptanceHandler({
    enabled: true,
    token: controlToken,
    controllerIdentity,
    port: {
      async registerArtifact(input) {
        registrations += 1;
        return {
          schemaVersion: 1,
          acceptanceRunId: input.acceptanceRunId,
          scenario: input.scenario,
          registered: true,
          faultArmed: false,
          registrationId: '60000000-0000-4000-a000-000000000006',
          artifactId: input.artifactId,
          artifactDigest: input.artifactDigest,
          expiresAt: '2026-07-26T12:05:00.000Z',
          dependencyIdentity: controllerIdentity,
        };
      },
      async inspect() {
        return null;
      },
      async cleanup(input) {
        return {
          schemaVersion: 1,
          acceptanceRunId: input.acceptanceRunId,
          dependencyIdentity: controllerIdentity,
          retention: { expiredProbeDeleted: true, immutableAttemptsPreserved: true },
          orphanCleanup: { cancelledUploadAbsent: true, orphanProbeDeleted: true },
        };
      },
    },
  });
  const response = await handler(
    new Request('https://acceptance.staging.openopc.example/module-beta/trust/registrations', {
      method: 'POST',
      headers: acceptanceRequestHeaders({ controlToken, runId: acceptanceRunId }),
      body: canonicalJson({
        schemaVersion: 1,
        acceptanceRunId,
        scenario: 'clean-wasi',
        accountId,
        artifactId,
        artifactDigest,
      }),
    }),
  );

  expect(response.status).toBe(201);
  expect(registrations).toBe(1);
});

test('cleanup polling accepts only the final response after the retention worker succeeds', async () => {
  const acceptanceRunId = 'gha:12345:1';
  const dependencyIdentity = `module-beta-controller@1.0.0#sha256:${'c'.repeat(64)}`;
  const retentionRunId = '70000000-0000-4000-a000-000000000007';
  const responses = [
    {
      status: 202,
      body: {
        schemaVersion: 1,
        acceptanceRunId,
        dependencyIdentity,
        retentionRunId,
        state: 'queued',
      },
    },
    {
      status: 202,
      body: {
        schemaVersion: 1,
        acceptanceRunId,
        dependencyIdentity,
        retentionRunId,
        state: 'running',
      },
    },
    {
      status: 200,
      body: {
        schemaVersion: 1,
        acceptanceRunId,
        dependencyIdentity,
        retention: { expiredProbeDeleted: true, immutableAttemptsPreserved: true },
        orphanCleanup: { cancelledUploadAbsent: true, orphanProbeDeleted: true },
      },
    },
  ];
  let calls = 0;

  const result = await waitForModuleBetaCleanup({
    acceptanceRunId,
    dependencyIdentity,
    timeoutMs: 1_000,
    pollMs: 0,
    cleanup: async () => {
      const item = responses[calls];
      calls += 1;
      if (!item) throw new Error('unexpected cleanup poll');
      return {
        response: Response.json(item.body, { status: item.status }),
        value: item.body,
      };
    },
  });

  expect(calls).toBe(3);
  expect(result.response.status).toBe(200);
  expect(result.value).toEqual(responses[2].body);
});

test('presigned uploads stay on configured staging object hosts over HTTPS', () => {
  const allowedHosts = ['minio.staging.openopc.internal'];
  expect(
    assertAllowedPresignedUploadUrl(
      'https://minio.staging.openopc.internal/uploads/artifact?signature=opaque',
      allowedHosts,
    ).host,
  ).toBe(allowedHosts[0]);
  for (const url of [
    'https://attacker.example/uploads/artifact?signature=opaque',
    'http://minio.staging.openopc.internal/uploads/artifact?signature=opaque',
  ]) {
    expect(() => assertAllowedPresignedUploadUrl(url, allowedHosts)).toThrow(
      'TRUST_UPLOAD_URL_INVALID',
    );
  }
});

test('cross-account denial is indistinguishable from a random missing resource', () => {
  const opaque = { error: 'DEVELOPER_RELEASE_NOT_FOUND' };
  expect(() =>
    assertOpaqueNotFoundResponses(
      { status: 404, value: opaque },
      { status: 404, value: { ...opaque } },
    ),
  ).not.toThrow();
  expect(() =>
    assertOpaqueNotFoundResponses(
      { status: 404, value: opaque },
      { status: 404, value: { error: 'DIFFERENT_NOT_FOUND' } },
    ),
  ).toThrow('TRUST_CROSS_ACCOUNT_RESPONSE_NOT_OPAQUE');
});

test('cleanup re-reads and compares complete immutable attempt snapshots', async () => {
  const releaseId = '50000000-0000-4000-a000-000000000005';
  const attempt = {
    run_id: '30000000-0000-4000-a000-000000000003',
    attempt: 1,
    state: 'passed',
  };
  const events: string[] = [];
  let reads = 0;

  const preserved = await verifyCleanupPreservesImmutableAttempts({
    releaseIds: [releaseId],
    readTrust: async (requestedReleaseId) => {
      events.push(`read:${reads}`);
      reads += 1;
      return { release_id: requestedReleaseId, attempts: [attempt] };
    },
    cleanup: async () => {
      events.push('cleanup');
      return { deleted: true };
    },
  });

  expect(events).toEqual(['read:0', 'cleanup', 'read:1']);
  expect(preserved.result).toEqual({ deleted: true });
  expect(preserved.attemptCount).toBe(1);

  reads = 0;
  await expect(
    verifyCleanupPreservesImmutableAttempts({
      releaseIds: [releaseId],
      readTrust: async (requestedReleaseId) => ({
        release_id: requestedReleaseId,
        attempts: reads++ === 0 ? [attempt] : [{ ...attempt, state: 'failed' }],
      }),
      cleanup: async () => ({ deleted: true }),
    }),
  ).rejects.toThrow('TRUST_CLEANUP_IMMUTABLE_ATTEMPTS_CHANGED');
});

test('bounds a chunked JSON response before buffering the complete body', async () => {
  let pulls = 0;
  let cancelled = false;
  const chunks = 16;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls > chunks) return controller.close();
        controller.enqueue(new Uint8Array(256 * 1024).fill(0x61));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );

  await expect(readBoundedJsonResponse(response)).rejects.toThrow('MODULE_BETA_RESPONSE_TOO_LARGE');
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(chunks);
});

test('binds every verification registration to the acceptance run and artifact', () => {
  expect(
    buildTrustRegistration({ runId: 'workflow-run-123' }, 'clean-wasi', {
      artifact_id: '50000000-0000-4000-a000-000000000005',
      account_id: '10000000-0000-4000-a000-000000000001',
      artifact_digest: `sha256:${'a'.repeat(64)}`,
    }),
  ).toEqual({
    schemaVersion: 1,
    acceptanceRunId: 'workflow-run-123',
    scenario: 'clean-wasi',
    accountId: '10000000-0000-4000-a000-000000000001',
    artifactId: '50000000-0000-4000-a000-000000000005',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
  });
});

test('trust credentials run only in a protected manual staging job with separate artifacts', async () => {
  const workflow = await readFile(
    join(import.meta.dir, '..', '..', '..', '.github', 'workflows', 'qa-release.yml'),
    'utf8',
  );
  const [pullRequestJob, trustJob] = workflow.split('\n  trust-staging-acceptance:\n');
  expect(trustJob).toBeDefined();
  expect(pullRequestJob).not.toContain('QA_MODULE_BETA_PRIMARY_TOKEN');
  expect(pullRequestJob).not.toContain('QA_MODULE_BETA_EVIDENCE_PRIVATE_KEY_DER_B64');
  expect(trustJob).toContain("github.event_name == 'workflow_dispatch'");
  expect(trustJob).toContain('github.ref_protected == true');
  expect(trustJob).toContain('environment: staging-trust-acceptance');
  expect(trustJob).toContain('runs-on: [self-hosted, linux, x64, staging-trust]');
  expect(trustJob).not.toContain('${{ inputs.');
  expect(trustJob).toContain('if: success()');
  expect(trustJob).toContain('MODULE_BETA_RUN_ID: ${{ github.run_id }}:${{ github.run_attempt }}');
  expect(trustJob).toContain(
    'name: module-beta-trust-evidence-${{ github.run_id }}-${{ github.run_attempt }}',
  );
  expect(trustJob).toContain('if: failure()');
  expect(trustJob).toContain(
    'name: module-beta-trust-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}',
  );
});

test('trust staging targets reject loopback, production, and mocked services without mutating flags', () => {
  const enabled = process.env.DEVELOPER_TRUST_ENABLED;
  for (const api of [
    'http://127.0.0.1:8008/v1',
    'https://api.openopc.com/v1',
    'https://mock-api.staging.openopc.example/v1',
  ]) {
    expect(() =>
      assertTrustStagingTargets({
        api,
        web: 'https://web.staging.openopc.example',
        runner: 'https://trust.staging.openopc.example',
      }),
    ).toThrow();
  }
  expect(process.env.DEVELOPER_TRUST_ENABLED).toBe(enabled);
});

test('loads an explicit real-dependency staging contract and fails closed on missing control identity', () => {
  const pair = generateKeyPairSync('ed25519');
  const environment = {
    MODULE_BETA_API_URL: 'https://api.staging.openopc.example/v1',
    MODULE_BETA_WEB_URL: 'https://web.staging.openopc.example',
    MODULE_BETA_RUNNER_URL: 'https://runner.staging.openopc.example',
    MODULE_BETA_TRUST_ACCEPTANCE_URL: 'https://acceptance.staging.openopc.internal',
    MODULE_BETA_TRUST_WORKER_URL: 'https://trust-worker.staging.openopc.internal',
    MODULE_BETA_PRIMARY_TOKEN: 'primary-access-token-for-staging',
    MODULE_BETA_PRIMARY_ACCOUNT_ID: '10000000-0000-4000-a000-000000000001',
    MODULE_BETA_SECONDARY_TOKEN: 'secondary-access-token-for-staging',
    MODULE_BETA_SECONDARY_ACCOUNT_ID: '10000000-0000-4000-a000-000000000009',
    MODULE_BETA_PUBLISHER_ID: 'acceptance-publisher',
    MODULE_BETA_TRUST_CONTROL_TOKEN: 'private-staging-control-token',
    MODULE_BETA_TRUST_CONTROL_IDENTITY: `trust-acceptance-controller@1.0.0#sha256:${'c'.repeat(64)}`,
    MODULE_BETA_DEPENDENCY_IDENTITIES_JSON: JSON.stringify([
      `trust-worker@1.0.0#sha256:${'a'.repeat(64)}`,
      `trust-acceptance-controller@1.0.0#sha256:${'c'.repeat(64)}`,
      'key:openopc-attestation-staging-2026-07',
    ]),
    MODULE_BETA_EXPECTED_FINDINGS_JSON: JSON.stringify({
      'secret-leak': ['gitleaks:generic-api-key'],
      'vulnerable-lockfile': ['osv-scanner:GHSA-35jh-r3h4-6jhm'],
    }),
    MODULE_BETA_MINIO_HOSTS_JSON: JSON.stringify(['minio.staging.openopc.internal']),
    MODULE_BETA_ATTESTATION_KEYRING_JSON: JSON.stringify({
      'openopc-attestation-staging-2026-07': pair.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
    }),
    MODULE_BETA_EVIDENCE_PRIVATE_KEY_DER_B64: pair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    MODULE_BETA_EVIDENCE_PUBLIC_KEY_DER_B64: pair.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    MODULE_BETA_EVIDENCE_KEY_ID: 'openopc-module-beta-staging-2026-07',
    MODULE_BETA_COMMIT: 'bdf78d314',
    MODULE_BETA_RUN_ID: '12345',
  };

  const config = loadTrustStagingConfig(environment);
  expect(config.targets.api).toBe(environment.MODULE_BETA_API_URL);
  expect(config.acceptanceUrl).toBe(environment.MODULE_BETA_TRUST_ACCEPTANCE_URL);
  expect(config.trustWorkerUrl).toBe(environment.MODULE_BETA_TRUST_WORKER_URL);
  expect(config.acceptanceUrl).not.toBe(environment.MODULE_BETA_RUNNER_URL);
  expect(buildTrustServiceUrl(config, 'acceptance', '/module-beta/trust/registrations')).toBe(
    'https://acceptance.staging.openopc.internal/module-beta/trust/registrations',
  );
  expect(buildTrustServiceUrl(config, 'worker', '/readyz')).toBe(
    'https://trust-worker.staging.openopc.internal/readyz',
  );
  expect(config.dependencyIdentities).toHaveLength(3);
  expect(config.controlIdentity).toBe(environment.MODULE_BETA_TRUST_CONTROL_IDENTITY);
  expect(Object.keys(config.attestationKeyring)).toEqual(['openopc-attestation-staging-2026-07']);
  expect(config.expectedFindings['secret-leak']).toEqual(['gitleaks:generic-api-key']);
  expect(() =>
    loadTrustStagingConfig({ ...environment, MODULE_BETA_TRUST_CONTROL_TOKEN: undefined }),
  ).toThrow('MODULE_BETA_ENV_REQUIRED');
  expect(() =>
    loadTrustStagingConfig({
      ...environment,
      MODULE_BETA_TRUST_WORKER_URL: environment.MODULE_BETA_TRUST_ACCEPTANCE_URL,
    }),
  ).toThrow('MODULE_BETA_TRUST_ACCEPTANCE_URL_NOT_INDEPENDENT');
  expect(() =>
    loadTrustStagingConfig({ ...environment, MODULE_BETA_TRUST_CONTROL_IDENTITY: undefined }),
  ).toThrow('MODULE_BETA_ENV_REQUIRED');
  expect(() =>
    loadTrustStagingConfig({
      ...environment,
      MODULE_BETA_DEPENDENCY_IDENTITIES_JSON: JSON.stringify([
        `trust-worker@1.0.0#sha256:${'a'.repeat(64)}`,
        'key:openopc-attestation-staging-2026-07',
      ]),
    }),
  ).toThrow('MODULE_BETA_TRUST_CONTROL_IDENTITY_UNRECORDED');
});

describe('dynamic trust fixtures', () => {
  test('generate deterministic archives outside the committed fixture tree', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'openopc-trust-fixtures-a-'));
    const secondRoot = await mkdtemp(join(tmpdir(), 'openopc-trust-fixtures-b-'));
    temporaryDirectories.push(firstRoot, secondRoot);

    const input = {
      seed: 'task-6-red-green',
      publisherId: 'acceptance-publisher',
      oversizedFileBytes: 1_024,
    } as const;
    const first = await generateTrustFixtures({ ...input, outputDirectory: firstRoot });
    const second = await generateTrustFixtures({ ...input, outputDirectory: secondRoot });

    expect(first.map(({ scenario }) => scenario)).toEqual([
      'clean-wasi',
      'secret-leak',
      'vulnerable-lockfile',
      'traversal',
      'oversized-file',
      'invalid-signature',
      'stale-policy',
      'scanner-crash',
    ]);
    expect(first.map(({ archiveDigest }) => archiveDigest)).toEqual(
      second.map(({ archiveDigest }) => archiveDigest),
    );
    expect(first.every(({ archivePath }) => archivePath.startsWith(firstRoot))).toBe(true);
    expect(await readFile(first[0].archivePath)).toEqual(await readFile(second[0].archivePath));

    const cleanArchive = JSON.parse(await readFile(first[0].archivePath, 'utf8')) as {
      files: Array<{ path: string; bytes: string }>;
    };
    const encodedComponent = cleanArchive.files.find(
      (file) => file.path === 'runtime/echo.component.wasm',
    )?.bytes;
    expect(encodedComponent).toStartWith('base64:');
    const component = Buffer.from(encodedComponent?.slice('base64:'.length) ?? '', 'base64');
    expect(component.subarray(0, 8).toString('hex')).toBe('0061736d0d000100');
    expect(component.includes(Buffer.from('run', 'utf8'))).toBe(true);
  });
});

test('terminal verification requires the exact state, reason, and finding codes', () => {
  const attempt = {
    run_id: '50000000-0000-4000-a000-000000000005',
    attempt: 1,
    state: 'failed',
    terminal_reason: 'blocking_findings',
    policy_digest: `sha256:${'a'.repeat(64)}`,
    scanner_set_digest: `sha256:${'b'.repeat(64)}`,
    sandbox_profile_digest: `sha256:${'c'.repeat(64)}`,
    sbom_digest: `sha256:${'d'.repeat(64)}`,
    attestation_digest: `sha256:${'e'.repeat(64)}`,
    started_at: '2026-07-26T01:00:00.000Z',
    finished_at: '2026-07-26T01:00:01.000Z',
    created_at: '2026-07-26T00:59:59.000Z',
    findings: [
      {
        scanner: 'gitleaks',
        rule_id: 'generic-api-key',
        severity: 'critical',
        disposition: 'blocking',
      },
    ],
    attestation: {
      attestation_digest: `sha256:${'e'.repeat(64)}`,
      subject_artifact_digest: `sha256:${'f'.repeat(64)}`,
      predicate_type: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policy_digest: `sha256:${'a'.repeat(64)}`,
      result: 'failed',
      sbom_digest: `sha256:${'d'.repeat(64)}`,
      issuer: 'openopc-developer-trust-staging',
      created_at: '2026-07-26T01:00:01.000Z',
    },
  } as const;

  expect(() =>
    validateTerminalAttempt(attempt, {
      state: 'failed',
      terminalReason: 'blocking_findings',
      findingCodes: ['gitleaks:generic-api-key'],
      artifactDigest: `sha256:${'f'.repeat(64)}`,
    }),
  ).not.toThrow();
  expect(() =>
    validateTerminalAttempt(attempt, {
      state: 'failed',
      terminalReason: 'blocking_findings',
      findingCodes: ['gitleaks:wrong-rule'],
      artifactDigest: `sha256:${'f'.repeat(64)}`,
    }),
  ).toThrow('TRUST_FINDING_CODE_MISMATCH');
});

test('terminal verification attempts are immutable across reads', () => {
  const attempt = { run_id: 'run-1', state: 'passed', findings: [] };
  expect(() => assertImmutableAttempt(attempt, structuredClone(attempt))).not.toThrow();
  expect(() =>
    assertImmutableAttempt(attempt, { ...attempt, findings: [{ rule_id: 'late-write' }] }),
  ).toThrow('TRUST_ATTEMPT_MUTATED');
});

test('polls through queued work and re-reads the terminal attempt before returning', async () => {
  const terminal = {
    run_id: '50000000-0000-4000-a000-000000000005',
    state: 'passed',
    findings: [],
  };
  const views = [
    { attempts: [{ ...terminal, state: 'queued' }] },
    { attempts: [terminal] },
    { attempts: [structuredClone(terminal)] },
  ];
  const seen: string[] = [];

  const result = await waitForImmutableTrustAttempt(
    async () => {
      seen.push('read');
      const next = views.shift();
      if (!next) throw new Error('unexpected extra read');
      return next;
    },
    { timeoutMs: 1_000, pollMs: 0 },
  );

  expect(result).toEqual(terminal);
  expect(seen).toHaveLength(3);
});

test('advances only G2 through G4 after signed staging artifacts exist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openopc-trust-ledger-'));
  temporaryDirectories.push(directory);
  const ledgerPath = join(directory, 'evidence.json');
  const baseline = await readFile(join(import.meta.dir, '..', 'evidence.json'), 'utf8');
  await writeFile(ledgerPath, baseline);
  const dependencyIdentities = [
    `trust-worker@1.0.0#sha256:${'a'.repeat(64)}`,
    'key:openopc-attestation-staging-2026-07',
  ];
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'openopc-module-beta-staging-2026-07';
  const artifacts = {} as Record<'G2' | 'G3' | 'G4', string>;
  for (const gate of ['G2', 'G3', 'G4'] as const) {
    artifacts[gate] = join(directory, `${gate}.json`);
    const envelope = await signEvidenceDocument(
      {
        schemaVersion: 1,
        gate,
        outcome: 'passed',
        commit: 'bdf78d314',
        runId: '12345',
        dependencyIdentities,
      },
      { keyId, privateKey: pair.privateKey },
    );
    await writeFile(artifacts[gate], `${JSON.stringify(envelope)}\n`);
  }

  await updateTrustEvidenceLedger({
    ledgerPath,
    commit: 'bdf78d314',
    runId: '12345',
    command: 'bun tests/module-beta/trust/run.ts',
    startedAt: '2026-07-26T01:00:00.000Z',
    finishedAt: '2026-07-26T01:10:00.000Z',
    dependencyIdentities,
    artifacts,
    evidenceKey: {
      keyId,
      publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }),
    },
  });

  const ledger = validateEvidenceLedger(JSON.parse(await readFile(ledgerPath, 'utf8')));
  expect(
    ledger.records.filter(({ outcome }) => outcome === 'passed').map(({ gate }) => gate),
  ).toEqual(['G2', 'G3', 'G4']);
  expect(ledger.records.find(({ gate }) => gate === 'G1')?.outcome).toBe('not-run');
  expect(ledger.records.slice(1, 4).every(({ environment }) => environment === 'staging')).toBe(
    true,
  );
  expect(ledger.records.slice(1, 4).every(({ lane }) => lane === 'integration')).toBe(true);
});

test('refuses to advance the ledger when a signed artifact is bound to the wrong gate', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openopc-trust-ledger-binding-'));
  temporaryDirectories.push(directory);
  const ledgerPath = join(directory, 'evidence.json');
  const baseline = await readFile(join(import.meta.dir, '..', 'evidence.json'), 'utf8');
  await writeFile(ledgerPath, baseline);
  const pair = generateKeyPairSync('ed25519');
  const keyId = 'openopc-module-beta-staging-2026-07';
  const commit = 'bdf78d314';
  const runId = '12345';
  const dependencyIdentities = [
    `trust-worker@1.0.0#sha256:${'a'.repeat(64)}`,
    'key:openopc-attestation-staging-2026-07',
  ];
  const artifacts = {} as Record<'G2' | 'G3' | 'G4', string>;
  for (const gate of ['G2', 'G3', 'G4'] as const) {
    const envelope = await signEvidenceDocument(
      {
        schemaVersion: 1,
        gate: gate === 'G3' ? 'G2' : gate,
        outcome: 'passed',
        commit,
        runId,
        dependencyIdentities,
      },
      { keyId, privateKey: pair.privateKey },
    );
    artifacts[gate] = join(directory, `${gate}.json`);
    await writeFile(artifacts[gate], `${JSON.stringify(envelope)}\n`);
  }

  await expect(
    updateTrustEvidenceLedger({
      ledgerPath,
      commit,
      runId,
      command: 'bun tests/module-beta/trust/run.ts',
      startedAt: '2026-07-26T01:00:00.000Z',
      finishedAt: '2026-07-26T01:10:00.000Z',
      dependencyIdentities,
      artifacts,
      evidenceKey: {
        keyId,
        publicKeyDer: pair.publicKey.export({ format: 'der', type: 'spki' }),
      },
    }),
  ).rejects.toThrow('TRUST_EVIDENCE_ARTIFACT_BINDING_INVALID');
});

test('verifies worker DSSE and signs the gate summary with a distinct staging key', async () => {
  const pair = generateKeyPairSync('ed25519');
  const publicKeyDer = pair.publicKey.export({ format: 'der', type: 'spki' });
  const privateKeyDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'acceptance@1.0.0', digest: { sha256: 'f'.repeat(64) } }],
    predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
    predicate: { result: 'passed', runId: 'run-1' },
  };
  const payload = Buffer.from(canonicalJson(statement));
  const envelope = {
    payloadType: 'application/vnd.in-toto+json',
    payload: payload.toString('base64'),
    signatures: [
      {
        keyid: 'openopc-attestation-staging-2026-07',
        sig: cryptoSign(
          null,
          dssePreAuthEncoding('application/vnd.in-toto+json', payload),
          pair.privateKey,
        ).toString('base64'),
      },
    ],
  };

  expect(
    verifyDsseEnvelope(envelope, {
      keyId: 'openopc-attestation-staging-2026-07',
      publicKeyDer,
    }),
  ).toEqual(statement);

  const signed = await signEvidenceDocument(
    { schemaVersion: 1, gate: 'G3', outcome: 'passed' },
    {
      keyId: 'openopc-module-beta-staging-2026-07',
      privateKey: createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' }),
    },
  );
  expect(
    verifySignedEvidenceDocument(signed, {
      keyId: 'openopc-module-beta-staging-2026-07',
      publicKeyDer,
    }),
  ).toEqual({ schemaVersion: 1, gate: 'G3', outcome: 'passed' });
});

test('re-hashes MinIO evidence and binds the worker DSSE to the terminal attempt', async () => {
  const artifactBytes = Buffer.from('canonical artifact bytes');
  const artifactContentDigest = `sha256:${createHash('sha256')
    .update(artifactBytes)
    .digest('hex')}` as const;
  await expect(
    verifyStoredEvidence(
      {
        storage: 'minio',
        url: 'https://minio.staging.openopc.internal/evidence/artifact',
        contentDigest: artifactContentDigest,
        sizeBytes: artifactBytes.byteLength,
      },
      {
        allowedHosts: ['minio.staging.openopc.internal'],
        fetcher: async () => new Response(artifactBytes, { status: 200 }),
      },
    ),
  ).resolves.toEqual({ digest: artifactContentDigest, sizeBytes: artifactBytes.byteLength });

  const pair = generateKeyPairSync('ed25519');
  const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
  const sbomDigest = `sha256:${'b'.repeat(64)}` as const;
  const policyDigest = `sha256:${'c'.repeat(64)}` as const;
  const scannerSetDigest = `sha256:${'d'.repeat(64)}` as const;
  const sandboxProfileDigest = `sha256:${'e'.repeat(64)}` as const;
  const scannerIdentities = [`gitleaks@8.24.2#sha256:${'f'.repeat(64)}`];
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'acceptance@1.0.0', digest: { sha256: 'a'.repeat(64) } }],
    predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
    predicate: {
      artifactDigest,
      policyDigest,
      scannerSetDigest,
      sandboxProfileDigest,
      sbomDigest,
      runId: '50000000-0000-4000-a000-000000000005',
      attempt: 1,
      result: 'passed',
      scannerIdentities,
      scannerIdentityVerified: true,
      evidenceDigests: [],
      startedAt: '2026-07-26T01:00:00.000Z',
      finishedAt: '2026-07-26T01:00:01.000Z',
      acceptance: {
        acceptanceRunId: 'gha:12345:1',
        registrationId: '40000000-0000-4000-a000-000000000004',
        scenario: 'clean-wasi',
      },
    },
  };
  const payload = Buffer.from(canonicalJson(statement));
  const envelope = {
    payloadType: 'application/vnd.in-toto+json',
    payload: payload.toString('base64'),
    signatures: [
      {
        keyid: 'openopc-attestation-staging-2026-07',
        sig: cryptoSign(
          null,
          dssePreAuthEncoding('application/vnd.in-toto+json', payload),
          pair.privateKey,
        ).toString('base64'),
      },
    ],
  };

  expect(
    verifyInspectorAttestation(
      {
        digest: `sha256:${createHash('sha256').update(canonicalJson(envelope)).digest('hex')}`,
        keyId: 'openopc-attestation-staging-2026-07',
        envelope,
      },
      {
        runId: '50000000-0000-4000-a000-000000000005',
        attempt: 1,
        state: 'passed',
        artifactDigest,
        sbomDigest,
        policyDigest,
        scannerSetDigest,
        sandboxProfileDigest,
        scannerIdentities,
        scannerIdentityVerified: true,
        acceptance: {
          acceptanceRunId: 'gha:12345:1',
          registrationId: '40000000-0000-4000-a000-000000000004',
          scenario: 'clean-wasi',
        },
        keyring: {
          'openopc-attestation-staging-2026-07': pair.publicKey.export({
            format: 'der',
            type: 'spki',
          }),
        },
      },
    ),
  ).toEqual(statement);

  expect(() =>
    verifyInspectorAttestation(
      {
        digest: `sha256:${createHash('sha256').update(canonicalJson(envelope)).digest('hex')}`,
        keyId: 'openopc-attestation-staging-2026-07',
        envelope,
      },
      {
        runId: '50000000-0000-4000-a000-000000000005',
        attempt: 1,
        state: 'passed',
        artifactDigest,
        sbomDigest,
        policyDigest,
        scannerSetDigest,
        sandboxProfileDigest,
        scannerIdentities,
        scannerIdentityVerified: true,
        acceptance: {
          acceptanceRunId: 'gha:12345:1',
          registrationId: '40000000-0000-4000-a000-000000000099',
          scenario: 'clean-wasi',
        },
        keyring: {
          'openopc-attestation-staging-2026-07': pair.publicKey.export({
            format: 'der',
            type: 'spki',
          }),
        },
      },
    ),
  ).toThrow('TRUST_ATTESTATION_STATEMENT_INVALID');

  expect(() =>
    verifyInspectorAttestation(
      {
        digest: `sha256:${createHash('sha256').update(canonicalJson(envelope)).digest('hex')}`,
        keyId: 'openopc-attestation-staging-2026-07',
        envelope,
      },
      {
        runId: '50000000-0000-4000-a000-000000000005',
        attempt: 1,
        state: 'passed',
        artifactDigest,
        sbomDigest,
        policyDigest,
        scannerSetDigest,
        sandboxProfileDigest,
        scannerIdentities: [`syft@1.20.0#sha256:${'1'.repeat(64)}`],
        scannerIdentityVerified: true,
        acceptance: {
          acceptanceRunId: 'gha:12345:1',
          registrationId: '40000000-0000-4000-a000-000000000004',
          scenario: 'clean-wasi',
        },
        keyring: {
          'openopc-attestation-staging-2026-07': pair.publicKey.export({
            format: 'der',
            type: 'spki',
          }),
        },
      },
    ),
  ).toThrow('TRUST_ATTESTATION_STATEMENT_INVALID');
});
