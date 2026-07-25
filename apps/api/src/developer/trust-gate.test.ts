import { expect, test } from 'bun:test';

import type { DeveloperModuleRelease } from './releases';
import { DeveloperModuleTrustGate } from './trust-gate';
import {
  type DeveloperModuleVerificationFindingInput,
  createMemoryDeveloperModuleVerificationRepository,
} from './verification';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const RELEASE_ID = '30000000-0000-4000-a000-000000000003';
const ARTIFACT_ID = '40000000-0000-4000-a000-000000000004';
const ARTIFACT_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const POLICY_DIGEST = `sha256:${'b'.repeat(64)}` as const;
const SCANNER_DIGEST = `sha256:${'c'.repeat(64)}` as const;
const SANDBOX_DIGEST = `sha256:${'d'.repeat(64)}` as const;
const SBOM_DIGEST = `sha256:${'e'.repeat(64)}` as const;
const ATTESTATION_DIGEST = `sha256:${'f'.repeat(64)}` as const;

function release(overrides: Partial<DeveloperModuleRelease> = {}): DeveloperModuleRelease {
  return {
    release_id: RELEASE_ID,
    account_id: ACCOUNT_ID,
    item_name: 'recruiting-workbench',
    publisher_id: 'acme',
    module_id: 'acme.recruiting',
    module_version: '1.0.0',
    manifest: {
      schemaVersion: 2,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
    },
    manifest_digest: `sha256:${'9'.repeat(64)}`,
    artifact_id: ARTIFACT_ID,
    artifact_digest: ARTIFACT_DIGEST,
    sbom_digest: SBOM_DIGEST,
    trust_attestation_digest: ATTESTATION_DIGEST,
    verification_policy_digest: POLICY_DIGEST,
    runtime_descriptor_digest: null,
    runtime_descriptor_path: null,
    runtime_kind: null,
    review_requirements: ['manifest_review', 'source_scan', 'human_review'],
    status: 'approved',
    review_revision: 2,
    signature_algorithm: null,
    signature_key_id: null,
    signature: null,
    signature_payload_digest: null,
    signed_at: null,
    published_at: null,
    revoked_at: null,
    created_by: '20000000-0000-4000-a000-000000000002',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T01:00:00.000Z',
    ...overrides,
  };
}

async function passedRepository(findings: DeveloperModuleVerificationFindingInput[] = []) {
  const repository = createMemoryDeveloperModuleVerificationRepository({
    releases: [
      {
        releaseId: RELEASE_ID,
        accountId: ACCOUNT_ID,
        artifactId: ARTIFACT_ID,
        artifactDigest: ARTIFACT_DIGEST,
        mediaType: 'application/vnd.openopc.developer-module.v2+json',
        sizeBytes: 128,
        sourceProvenance: null,
        createdAt: '2026-07-25T00:00:00.000Z',
      },
    ],
    createLeaseToken: () => 'A'.repeat(43),
  });
  await repository.enqueue({
    releaseId: RELEASE_ID,
    accountId: ACCOUNT_ID,
    artifactId: ARTIFACT_ID,
    artifactDigest: ARTIFACT_DIGEST,
    policyDigest: POLICY_DIGEST,
    scannerSetDigest: SCANNER_DIGEST,
    sandboxProfileDigest: SANDBOX_DIGEST,
  });
  const claim = await repository.claim({ workerId: 'worker-a', leaseMs: 30_000 });
  if (!claim) throw new Error('Expected claim');
  await repository.finalize({
    runId: claim.runId,
    workerId: 'worker-a',
    leaseToken: claim.leaseToken,
    artifactDigest: ARTIFACT_DIGEST,
    policyDigest: POLICY_DIGEST,
    scannerSetDigest: SCANNER_DIGEST,
    result: 'passed',
    terminalReason: 'passed',
    sbomDigest: SBOM_DIGEST,
    resourceSummary: {},
    findings,
    attestation: {
      attestationDigest: ATTESTATION_DIGEST,
      subjectArtifactDigest: ARTIFACT_DIGEST,
      predicateType: 'https://openopc.dev/attestations/developer-module-verification/v1',
      policyDigest: POLICY_DIGEST,
      result: 'passed',
      sbomDigest: SBOM_DIGEST,
      dsseEnvelope: { payloadType: 'application/vnd.in-toto+json', payload: 'redacted' },
      issuer: 'openopc-developer-trust-worker',
    },
  });
  return repository;
}

test('accepts only current passed evidence bound to the release artifact and digests', async () => {
  const gate = new DeveloperModuleTrustGate({
    repository: await passedRepository(),
    currentPolicyDigest: POLICY_DIGEST,
  });

  await expect(gate.evaluate(release())).resolves.toMatchObject({
    ok: true,
    evidence: {
      artifact_digest: ARTIFACT_DIGEST,
      sbom_digest: SBOM_DIGEST,
      attestation_digest: ATTESTATION_DIGEST,
      policy_digest: POLICY_DIGEST,
      runtime_descriptor_digest: null,
      runtime_kind: null,
    },
  });
});

test('returns server runtime evidence as release-signing trust inputs', async () => {
  const descriptorDigest = `sha256:${'1'.repeat(64)}` as const;
  const gate = new DeveloperModuleTrustGate({
    repository: await passedRepository(),
    currentPolicyDigest: POLICY_DIGEST,
  });

  await expect(
    gate.evaluate(
      release({
        manifest: {
          ...release().manifest,
          execution: { mode: 'server-adapter', entry: 'runtime/openopc.runtime.json' },
          verification: { profile: 'server-conformance' },
        },
        runtime_descriptor_digest: descriptorDigest,
        runtime_descriptor_path: 'runtime/openopc.runtime.json',
        runtime_kind: 'wasi-component',
      }),
    ),
  ).resolves.toMatchObject({
    ok: true,
    evidence: {
      runtime_descriptor_digest: descriptorDigest,
      runtime_kind: 'wasi-component',
    },
  });
});

test('rejects third-party desktop-native execution at the trust boundary', async () => {
  const gate = new DeveloperModuleTrustGate({
    repository: await passedRepository(),
    currentPolicyDigest: POLICY_DIGEST,
  });
  await expect(
    gate.evaluate(
      release({
        manifest: {
          ...release().manifest,
          execution: { mode: 'desktop-native', entry: 'desktop/main.js' },
          verification: { profile: 'desktop-package' },
        },
      }),
    ),
  ).resolves.toEqual({ ok: false, code: 'DEVELOPER_TRUST_EXECUTION_MODE_UNSUPPORTED' });
});

test.each([
  [
    'artifact mismatch',
    { artifact_digest: `sha256:${'0'.repeat(64)}` },
    'DEVELOPER_TRUST_ARTIFACT_MISMATCH',
  ],
  [
    'SBOM mismatch',
    { sbom_digest: `sha256:${'0'.repeat(64)}` },
    'DEVELOPER_TRUST_EVIDENCE_MISMATCH',
  ],
  [
    'attestation mismatch',
    { trust_attestation_digest: `sha256:${'0'.repeat(64)}` },
    'DEVELOPER_TRUST_EVIDENCE_MISMATCH',
  ],
  [
    'release policy mismatch',
    { verification_policy_digest: `sha256:${'0'.repeat(64)}` },
    'DEVELOPER_TRUST_POLICY_STALE',
  ],
] as const)('rejects %s', async (_label, overrides, code) => {
  const gate = new DeveloperModuleTrustGate({
    repository: await passedRepository(),
    currentPolicyDigest: POLICY_DIGEST,
  });
  await expect(gate.evaluate(release(overrides))).resolves.toEqual({ ok: false, code });
});

test('rejects high and critical blocking findings', async () => {
  const gate = new DeveloperModuleTrustGate({
    repository: await passedRepository([
      {
        fingerprint: `sha256:${'1'.repeat(64)}`,
        scanner: 'osv-scanner',
        ruleId: 'GHSA-example',
        severity: 'high',
        path: 'package-lock.json',
        location: null,
        summary: 'A high severity dependency finding.',
        disposition: 'blocking',
      },
    ]),
    currentPolicyDigest: POLICY_DIGEST,
  });

  await expect(gate.evaluate(release())).resolves.toEqual({
    ok: false,
    code: 'DEVELOPER_TRUST_BLOCKING_FINDINGS',
  });
});
