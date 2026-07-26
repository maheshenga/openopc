import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';

import {
  type EvidenceSigner,
  createEd25519EvidenceSigner,
  verifyDeveloperTrustAttestation,
} from './attestation';
import { DeveloperTrustPipeline } from './pipeline';
import { defineDeveloperTrustPolicy } from './policy';
import type { DeveloperModuleSandboxInput, DeveloperModuleSandboxResult } from './sandbox/types';
import {
  DEVELOPER_TRUST_SCANNER_FAULT,
  type DeveloperScannerAdapter,
  type ScannerInput,
  type ScannerResult,
  inconclusiveScannerResult,
} from './scanners/types';
import { policyInput } from './test-fixtures';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

function claim() {
  const policy = defineDeveloperTrustPolicy(policyInput());
  return {
    runId: '50000000-0000-4000-a000-000000000005',
    releaseId: '30000000-0000-4000-a000-000000000003',
    accountId: '10000000-0000-4000-a000-000000000001',
    artifactId: '40000000-0000-4000-a000-000000000004',
    artifactDigest: digest('a'),
    policyDigest: policy.policyDigest,
    scannerSetDigest: policy.scannerSetDigest,
    sandboxProfileDigest: policy.sandboxProfiles['desktop-package'].profileDigest,
    attempt: 1,
    leaseToken: 'A'.repeat(43),
    leaseExpiresAt: '2026-07-25T00:05:00.000Z',
    verificationProfile: 'desktop-package' as const,
    moduleId: 'acme.clean',
    moduleVersion: '1.0.0',
    workspacePath: '/tmp/openopc-clean',
    lockGraph: null,
    dependencyLicenses: [],
  };
}

function scanner(
  name: DeveloperScannerAdapter['name'],
  result: ScannerResult | Error,
  onScan?: (name: DeveloperScannerAdapter['name'], input: ScannerInput) => void,
): DeveloperScannerAdapter {
  return {
    name,
    async verifyIdentity() {},
    async scan(input) {
      onScan?.(name, input);
      if (input[DEVELOPER_TRUST_SCANNER_FAULT] === 'terminate-process') {
        return inconclusiveScannerResult(name, 'process_terminated');
      }
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
}

function evidence(
  name: DeveloperScannerAdapter['name'],
  overrides: Partial<ScannerResult> = {},
): ScannerResult {
  return {
    scanner: name,
    state: 'passed',
    findings: [],
    evidenceDigest: digest(name === 'syft' ? '2' : '1'),
    terminalReason: null,
    ...(name === 'syft'
      ? {
          sbom: {
            bomFormat: 'CycloneDX',
            specVersion: '1.6',
            version: 1,
            components: [],
          },
        }
      : {}),
    ...overrides,
  };
}

function sandboxEvidence(
  overrides: Partial<DeveloperModuleSandboxResult> = {},
): DeveloperModuleSandboxResult {
  const item = claim();
  return {
    runId: item.runId,
    sandboxInstanceId: 'sandbox-instance-1',
    artifactDigest: item.artifactDigest,
    sandboxProfileDigest: item.sandboxProfileDigest,
    state: 'passed',
    terminalReason: 'sandbox_verification_completed',
    stdoutDigest: digest('3'),
    stderrDigest: digest('4'),
    evidenceDigest: digest('5'),
    resourceUsage: { cpuMillis: 10, peakMemoryBytes: 1_024, pids: 2, outputBytes: 16 },
    tests: [{ id: 'load-entry', outcome: 'passed', summary: 'Entry loaded' }],
    capabilityAttempts: [],
    networkAttempts: [],
    ...overrides,
  };
}

function preparedSandboxInput(item: ReturnType<typeof claim>): DeveloperModuleSandboxInput {
  return {
    artifactDigest: item.artifactDigest,
    artifactMount: {
      source: '/var/lib/openopc/artifacts/aa/fixture',
      target: '/artifact',
      digest: item.artifactDigest,
      readOnly: true,
    },
    profile: item.verificationProfile,
    fixtures: [],
    verificationCapability: 'verification-capability-fixture',
    limits: {
      cpuMillis: 1_000,
      memoryBytes: 512 * 1024 * 1024,
      pids: 128,
      fileDescriptors: 256,
      maxFileBytes: 128 * 1024 * 1024,
      maxOutputBytes: 1024 * 1024,
      wallTimeMs: 60_000,
    },
    networkPolicy: {
      mode: 'none',
      allowedOrigins: [],
      allowedMethods: ['GET'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
      maxRedirects: 0,
    },
  };
}

function evidenceSigner(): EvidenceSigner {
  const { privateKey } = generateKeyPairSync('ed25519');
  return createEd25519EvidenceSigner({
    privateKey,
    keyId: 'openopc-worker-test',
    issuer: 'openopc-developer-trust-worker',
  });
}

function pipelineWith(
  replacements: Partial<Record<DeveloperScannerAdapter['name'], ScannerResult | Error>> = {},
  onScan?: (name: DeveloperScannerAdapter['name'], input: ScannerInput) => void,
  sandboxOutcome: DeveloperModuleSandboxResult | Error | null = sandboxEvidence(),
  signer: EvidenceSigner = evidenceSigner(),
) {
  const policy = defineDeveloperTrustPolicy(policyInput());
  const names = ['gitleaks', 'syft', 'osv-scanner', 'semgrep', 'license-policy'] as const;
  return new DeveloperTrustPipeline({
    policy,
    scanners: names.map((name) => scanner(name, replacements[name] ?? evidence(name), onScan)),
    signer,
    now: () => new Date('2026-07-25T00:00:00.000Z'),
    ...(sandboxOutcome === null
      ? {}
      : {
          sandbox: {
            port: {
              async run() {
                if (sandboxOutcome instanceof Error) throw sandboxOutcome;
                return structuredClone(sandboxOutcome);
              },
            },
            async prepare(item: ReturnType<typeof claim>) {
              return {
                sandboxInstanceId: 'sandbox-instance-1',
                input: preparedSandboxInput(item),
              };
            },
          },
        }),
  });
}

describe('developer trust pipeline', () => {
  test('records verified scanner identities in immutable and signed evidence', async () => {
    const result = await pipelineWith().run(claim());
    const scannerIdentities = policyInput()
      .scanners.map((scanner) => `${scanner.name}@${scanner.version}#${scanner.imageDigest}`)
      .sort();
    const statement = JSON.parse(
      Buffer.from(result.attestation.payload, 'base64').toString('utf8'),
    );

    expect(result.resourceSummary).toMatchObject({
      scanner_identities: scannerIdentities,
      scanner_identity_verified: true,
    });
    expect(statement.predicate).toMatchObject({
      scannerIdentities,
      scannerIdentityVerified: true,
    });
  });

  test('returns canonical SBOM bytes whose digest matches the exact document', async () => {
    const result = await pipelineWith().run(claim());
    expect(result.terminalReason).toBe('verification_completed');
    const serialized = new TextDecoder().decode(result.sbom.bytes);

    expect(serialized).toBe(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    expect(result.sbom.document).toEqual(JSON.parse(serialized));
    expect(result.sbom.digest).toBe(result.sbomDigest);
    expect(`sha256:${createHash('sha256').update(result.sbom.bytes).digest('hex')}`).toBe(
      result.sbomDigest,
    );
  });

  test('returns a canonical digest-bound unavailable SBOM document', async () => {
    const mismatched = { ...claim(), policyDigest: digest('0') };
    const result = await pipelineWith().run(mismatched);
    const serialized = new TextDecoder().decode(result.sbom.bytes);

    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'policy_mismatch' });
    expect(serialized).toBe('{"bomFormat":"CycloneDX","specVersion":"1.6","unavailable":true}');
    expect(result.sbom.document).toEqual(JSON.parse(serialized));
    expect(`sha256:${createHash('sha256').update(result.sbom.bytes).digest('hex')}`).toBe(
      result.sbomDigest,
    );
  });

  test('clean fixture creates deterministic CycloneDX and DSSE evidence', async () => {
    const pipeline = pipelineWith();
    const first = await pipeline.run(claim());
    const second = await pipeline.run(claim());

    expect(first.state).toBe('passed');
    expect(first.sbomDigest).toBe(second.sbomDigest);
    expect(first.attestationDigest).toBe(second.attestationDigest);
    expect(first.attestation.payloadType).toBe('application/vnd.in-toto+json');
    const statement = JSON.parse(Buffer.from(first.attestation.payload, 'base64').toString('utf8'));
    expect(Object.hasOwn(statement.predicate, 'acceptance')).toBe(false);
    expect(Object.hasOwn(first.resourceSummary, 'acceptance')).toBe(false);
  });

  test('binds acceptance context into the signed predicate and resource summary', async () => {
    const acceptance = {
      acceptanceRunId: 'module-beta-run-1',
      registrationId: '60000000-0000-4000-a000-000000000006',
      scenario: 'clean-wasi' as const,
    };
    const result = await pipelineWith().run({
      ...claim(),
      ...acceptance,
    });
    const statement = JSON.parse(
      Buffer.from(result.attestation.payload, 'base64').toString('utf8'),
    );

    expect(statement.predicate.acceptance).toEqual(acceptance);
    expect(result.resourceSummary.acceptance).toEqual(acceptance);
  });

  test('stale-policy acceptance produces a valid signed policy mismatch without scanning', async () => {
    let scans = 0;
    const signer = evidenceSigner();
    const pipeline = pipelineWith(
      {},
      () => {
        scans += 1;
      },
      sandboxEvidence(),
      signer,
    );
    const result = await pipeline.run({
      ...claim(),
      acceptanceRunId: 'module-beta-run-1',
      registrationId: '60000000-0000-4000-a000-000000000006',
      scenario: 'stale-policy',
    });

    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'policy_mismatch' });
    expect(scans).toBe(0);
    await expect(
      verifyDeveloperTrustAttestation({ envelope: result.attestation, signer }),
    ).resolves.toBe(true);
  });

  test('scanner-crash acceptance delegates a process termination fault to semgrep', async () => {
    let scans = 0;
    let faultedScans = 0;
    const result = await pipelineWith(
      { semgrep: new Error('fixture-sensitive-value-must-not-leak') },
      (name, input) => {
        scans += 1;
        if (input[DEVELOPER_TRUST_SCANNER_FAULT] === 'terminate-process') {
          expect(name).toBe('semgrep');
          faultedScans += 1;
        }
      },
    ).run({
      ...claim(),
      acceptanceRunId: 'module-beta-run-1',
      registrationId: '60000000-0000-4000-a000-000000000006',
      scenario: 'scanner-crash',
    });

    expect(result).toMatchObject({
      state: 'inconclusive',
      terminalReason: 'scanner_inconclusive',
      findings: [],
      resourceSummary: { scanner_count: 5, inconclusive_scanners: 1 },
    });
    expect(scans).toBe(5);
    expect(faultedScans).toBe(1);
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive-value-must-not-leak');
  });

  test('invalid-signature acceptance detects a corrupted DSSE and emits valid fail-closed evidence', async () => {
    const baseSigner = evidenceSigner();
    const verificationResults: boolean[] = [];
    const observingSigner: EvidenceSigner = {
      ...baseSigner,
      async verify(payload, signature) {
        const verified = await baseSigner.verify(payload, signature);
        verificationResults.push(verified);
        return verified;
      },
    };
    const result = await pipelineWith({}, undefined, sandboxEvidence(), observingSigner).run({
      ...claim(),
      acceptanceRunId: 'module-beta-run-1',
      registrationId: '60000000-0000-4000-a000-000000000006',
      scenario: 'invalid-signature',
    });

    expect(result).toMatchObject({
      state: 'inconclusive',
      terminalReason: 'attestation_signature_invalid',
      attestationRecord: { result: 'inconclusive' },
    });
    expect(verificationResults).toEqual([true, false]);
    await expect(
      verifyDeveloperTrustAttestation({ envelope: result.attestation, signer: baseSigner }),
    ).resolves.toBe(true);
    const statement = JSON.parse(
      Buffer.from(result.attestation.payload, 'base64').toString('utf8'),
    );
    expect(statement.predicate).toMatchObject({
      result: 'inconclusive',
      acceptance: { scenario: 'invalid-signature' },
    });
  });

  test.each([
    [
      'secret',
      {
        gitleaks: evidence('gitleaks', {
          state: 'failed',
          findings: [],
          terminalReason: 'findings',
        }),
      },
    ],
    [
      'vulnerability',
      {
        'osv-scanner': evidence('osv-scanner', {
          state: 'failed',
          findings: [],
          terminalReason: 'findings',
        }),
      },
    ],
    ['scanner-crash', { semgrep: new Error('fixture-sensitive-value-must-not-leak') }],
    [
      'malformed-output',
      { syft: { ...evidence('syft'), state: 'unknown' } as unknown as ScannerResult },
    ],
  ] as const)('%s cannot produce a passing attestation', async (_fixture, replacements) => {
    const result = await pipelineWith(replacements).run(claim());
    expect(result.state).not.toBe('passed');
    expect(JSON.stringify(result)).not.toContain('fixture-sensitive-value-must-not-leak');
  });

  test('policy mismatch is inconclusive and scanners do not run', async () => {
    let scans = 0;
    const pipeline = pipelineWith({}, () => {
      scans += 1;
    });
    const mismatched = { ...claim(), policyDigest: digest('0') };

    const result = await pipeline.run(mismatched);
    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'policy_mismatch' });
    expect(scans).toBe(0);
  });

  test('cyclic malformed SBOM is inconclusive instead of escaping the pipeline', async () => {
    const cyclic = {
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      version: 1,
      components: [],
    } as Record<string, unknown>;
    cyclic.self = cyclic;

    const result = await pipelineWith({
      syft: evidence('syft', { sbom: cyclic as unknown as ScannerResult['sbom'] }),
    }).run(claim());

    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'sbom_unavailable' });
  });

  test('unexpected SBOM fields cannot place raw source in signed evidence', async () => {
    const rawSource = 'console.log("fixture raw source")';
    const result = await pipelineWith({
      syft: evidence('syft', {
        sbom: {
          bomFormat: 'CycloneDX',
          specVersion: '1.6',
          version: 1,
          components: [
            {
              type: 'library',
              name: 'fixture',
              version: '1.0.0',
              purl: 'pkg:npm/fixture@1.0.0',
              'bom-ref': 'pkg:npm/fixture@1.0.0',
              rawSource,
            },
          ],
        },
      }),
    }).run(claim());

    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'sbom_unavailable' });
    expect(JSON.stringify(result)).not.toContain(rawSource);
  });

  test.each([
    [
      'failed sandbox',
      sandboxEvidence({ state: 'failed', terminalReason: 'wall_time_limit' }),
      'failed',
      'sandbox_failed',
    ],
    [
      'stale sandbox',
      sandboxEvidence({ runId: 'stale-run' }),
      'inconclusive',
      'stale_sandbox_result',
    ],
    [
      'sandbox crash',
      new Error('fixture sandbox raw crash'),
      'inconclusive',
      'sandbox_unavailable',
    ],
  ] as const)(
    '%s cannot produce passing evidence',
    async (_label, outcome, state, terminalReason) => {
      const result = await pipelineWith({}, undefined, outcome).run(claim());
      expect(result).toMatchObject({ state, terminalReason });
      expect(JSON.stringify(result)).not.toContain('fixture sandbox raw crash');
    },
  );

  test('missing required sandbox is inconclusive', async () => {
    const result = await pipelineWith({}, undefined, null).run(claim());
    expect(result).toMatchObject({ state: 'inconclusive', terminalReason: 'sandbox_unavailable' });
  });
});
