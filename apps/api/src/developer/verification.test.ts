import { describe, expect, test } from 'bun:test';

import {
  type DeveloperModuleVerificationClaim,
  DeveloperModuleVerificationService,
  type FinalizeVerificationInput,
  assertDeveloperModuleServiceNetworkPolicy,
  createMemoryDeveloperModuleVerificationRepository,
} from './verification';

const ACCOUNT_A = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_B = '10000000-0000-4000-a000-000000000009';
const RELEASE_A = '30000000-0000-4000-a000-000000000003';
const ARTIFACT_A = '40000000-0000-4000-a000-000000000004';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const POLICY_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const SCANNER_SET_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const SANDBOX_PROFILE_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const SBOM_DIGEST = `sha256:${'e'.repeat(64)}` as const;
const ATTESTATION_DIGEST = `sha256:${'f'.repeat(64)}` as const;

function clock() {
  let value = new Date('2026-07-25T01:00:00.000Z').getTime();
  return {
    now: () => new Date(value),
    advance: (milliseconds: number) => {
      value += milliseconds;
    },
  };
}

function fixture() {
  const time = clock();
  let id = 0;
  let token = 0;
  const repository = createMemoryDeveloperModuleVerificationRepository({
    releases: [
      {
        releaseId: RELEASE_A,
        accountId: ACCOUNT_A,
        artifactId: ARTIFACT_A,
        artifactDigest: ARTIFACT_DIGEST,
        mediaType: 'application/vnd.openopc.developer-module.v2+json',
        sizeBytes: 4096,
        sourceProvenance: { repository: 'https://example.invalid/acme/recruiting' },
        createdAt: '2026-07-25T00:00:00.000Z',
      },
    ],
    now: time.now,
    createId: () => `50000000-0000-4000-a000-${String(++id).padStart(12, '0')}`,
    createLeaseToken: () => `${String.fromCharCode(64 + ++token)}`.repeat(43),
  });
  return { repository, time };
}

function enqueue(repository: ReturnType<typeof fixture>['repository']) {
  return repository.enqueue({
    releaseId: RELEASE_A,
    accountId: ACCOUNT_A,
    artifactId: ARTIFACT_A,
    artifactDigest: ARTIFACT_DIGEST,
    policyDigest: POLICY_DIGEST,
    scannerSetDigest: SCANNER_SET_DIGEST,
    sandboxProfileDigest: SANDBOX_PROFILE_DIGEST,
  });
}

function passedResult(
  claim: DeveloperModuleVerificationClaim,
  overrides: Partial<FinalizeVerificationInput> = {},
): FinalizeVerificationInput {
  return {
    runId: claim.runId,
    workerId: 'worker-a',
    leaseToken: claim.leaseToken,
    artifactDigest: claim.artifactDigest,
    policyDigest: claim.policyDigest,
    scannerSetDigest: claim.scannerSetDigest,
    result: 'passed',
    terminalReason: 'verification completed',
    sbomDigest: SBOM_DIGEST,
    resourceSummary: { cpu_ms: 1200, peak_memory_bytes: 1024 },
    findings: [
      {
        fingerprint: `sha256:${'1'.repeat(64)}`,
        scanner: 'semgrep',
        ruleId: 'openopc.safe-rule',
        severity: 'low',
        path: 'src/index.ts',
        location: { line: 12 },
        summary: 'A bounded non-blocking observation.',
        disposition: 'observed',
      },
    ],
    attestation: {
      attestationDigest: ATTESTATION_DIGEST,
      subjectArtifactDigest: claim.artifactDigest,
      predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policyDigest: claim.policyDigest,
      result: 'passed',
      sbomDigest: SBOM_DIGEST,
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: 'redacted' },
      issuer: 'openopc-developer-trust-worker',
    },
    ...overrides,
  };
}

describe('developer module verification lifecycle', () => {
  test('rejects a declared platform service provider origin in network permissions', () => {
    const manifest = {
      schemaVersion: 3,
      id: 'acme.weather',
      version: '1.0.0',
      publisher: { id: 'acme' },
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'sandboxed-web' },
      openopc: {
        sdkApiVersion: 'v1',
        services: { ai: { operations: ['models.read'] } },
      },
      permissions: { network: ['https://newapi.example.test'] },
    } as const;

    expect(() =>
      assertDeveloperModuleServiceNetworkPolicy(manifest as never, {
        newApiBaseUrl: 'https://newapi.example.test/v1',
      }),
    ).toThrow('DEVELOPER_VERIFICATION_RESULT_INVALID');
  });

  test('rejects either configured platform provider origin for every declared service', () => {
    const manifest = {
      schemaVersion: 3,
      id: 'acme.weather',
      version: '1.0.0',
      publisher: { id: 'acme' },
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'sandboxed-web' },
      openopc: { sdkApiVersion: 'v1', services: { ai: { operations: ['models.read'] } } },
      permissions: { network: ['https://zpay.example.test'] },
    } as const;

    expect(() =>
      assertDeveloperModuleServiceNetworkPolicy(manifest as never, {
        newApiBaseUrl: 'https://newapi.example.test/v1',
        zPayBaseUrl: 'https://zpay.example.test',
      }),
    ).toThrow('DEVELOPER_VERIFICATION_RESULT_INVALID');
  });

  test('rejects provider origins for data and settings only modules', () => {
    const manifest = {
      schemaVersion: 3,
      id: 'acme.canvas',
      version: '1.0.0',
      publisher: { id: 'acme' },
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'sandboxed-web' },
      openopc: {
        sdkApiVersion: 'v1',
        services: {
          data: { operations: ['documents.read'] },
          settings: { operations: ['settings.read'] },
        },
      },
      permissions: { network: ['https://newapi.example.test'] },
    } as const;

    expect(() =>
      assertDeveloperModuleServiceNetworkPolicy(manifest as never, {
        newApiBaseUrl: 'https://newapi.example.test/v1',
      }),
    ).toThrow('DEVELOPER_VERIFICATION_RESULT_INVALID');
  });

  test('claims, heartbeats, finalizes, and exposes only a safe account view', async () => {
    const { repository } = fixture();
    await enqueue(repository);
    const claim = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(claim).not.toBeNull();
    if (!claim) throw new Error('Expected a verification claim');

    await repository.heartbeat({
      runId: claim.runId,
      workerId: 'worker-a',
      leaseToken: claim.leaseToken,
      leaseMs: 30_000,
    });
    await expect(repository.finalize(passedResult(claim))).resolves.toMatchObject({
      state: 'passed',
      sbom_digest: SBOM_DIGEST,
      attestation_digest: ATTESTATION_DIGEST,
    });

    const view = await repository.getPublisherView(ACCOUNT_A, RELEASE_A);
    expect(JSON.stringify(view)).not.toMatch(
      /lease_token|token_hash|storage_key|signed_url|dsse_envelope|command_line|raw_log/i,
    );
    expect(view?.attempts[0]?.attestation).not.toHaveProperty('dsse_envelope');
    expect(
      'dsse_envelope' in
        ((view?.attempts[0]?.attestation ?? {}) as unknown as Record<string, unknown>),
    ).toBe(false);
    expect(view).toMatchObject({
      release_id: RELEASE_A,
      artifact: { artifact_digest: ARTIFACT_DIGEST, size_bytes: 4096 },
      attempts: [
        expect.objectContaining({
          state: 'passed',
          findings: [expect.objectContaining({ scanner: 'semgrep', severity: 'low' })],
          attestation: expect.objectContaining({ attestation_digest: ATTESTATION_DIGEST }),
        }),
      ],
    });
  });

  test('a stale worker cannot finalize after its lease fence expires', async () => {
    const { repository, time } = fixture();
    await enqueue(repository);
    const first = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    if (!first) throw new Error('Expected first claim');
    time.advance(31_000);
    const second = await repository.claim({ workerId: 'worker-b', leaseMs: 30_000 });
    if (!second) throw new Error('Expected reclaimed claim');

    await expect(repository.finalize(passedResult(first))).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_LEASE_LOST',
    });
    await expect(
      repository.finalize(
        passedResult(second, { workerId: 'worker-b', leaseToken: second.leaseToken }),
      ),
    ).resolves.toMatchObject({ state: 'passed' });
  });

  test('replays an identical terminal result but rejects a different finalization', async () => {
    const { repository } = fixture();
    await enqueue(repository);
    const claim = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    if (!claim) throw new Error('Expected claim');
    const input = passedResult(claim);
    const first = await repository.finalize(input);

    await expect(repository.finalize(structuredClone(input))).resolves.toEqual(first);
    await expect(
      repository.finalize({ ...input, terminalReason: 'different terminal result' }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_ALREADY_FINALIZED' });
  });

  test('retries only terminal attempts, cancels active work, and hides cross-account identifiers', async () => {
    const { repository } = fixture();
    await enqueue(repository);
    const service = new DeveloperModuleVerificationService({
      repository,
      currentPolicy: {
        policyDigest: POLICY_DIGEST,
        scannerSetDigest: SCANNER_SET_DIGEST,
        sandboxProfileDigest: SANDBOX_PROFILE_DIGEST,
      },
    });

    await expect(
      service.getTrustView({ accountId: ACCOUNT_B, releaseId: RELEASE_A }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_RELEASE_NOT_FOUND', status: 404 });
    await expect(
      service.retryPublisher({ accountId: ACCOUNT_A, releaseId: RELEASE_A }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_RETRY_NOT_ALLOWED', status: 409 });

    const cancelled = await service.cancelAdmin({ releaseId: RELEASE_A });
    expect(cancelled.state).toBe('cancelled');
    const retried = await service.retryPublisher({ accountId: ACCOUNT_A, releaseId: RELEASE_A });
    expect(retried).toMatchObject({ state: 'queued', attempt: 2 });
  });

  test('rejects unsafe findings and identifier substitution without terminal mutation', async () => {
    const { repository } = fixture();
    await enqueue(repository);
    const claim = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    if (!claim) throw new Error('Expected claim');

    await expect(
      repository.finalize(
        passedResult(claim, {
          findings: [
            {
              fingerprint: `sha256:${'2'.repeat(64)}`,
              scanner: 'gitleaks',
              ruleId: 'credential',
              severity: 'critical',
              path: '../outside.env',
              location: null,
              summary: 'token=do-not-store-this-credential',
              disposition: 'blocking',
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_RESULT_INVALID', status: 400 });
    await expect(
      repository.finalize({
        ...passedResult(claim),
        artifactDigest: `sha256:${'0'.repeat(64)}`,
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_RESULT_INVALID', status: 400 });
    expect((await repository.getAdminView(RELEASE_A))?.attempts[0]?.state).toBe('running');
  });
});
