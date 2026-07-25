import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import { createEd25519EvidenceSigner } from './attestation';
import { DeveloperTrustPipeline } from './pipeline';
import { defineDeveloperTrustPolicy } from './policy';
import type { DeveloperScannerAdapter, ScannerResult } from './scanners/types';
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
  onScan?: () => void,
): DeveloperScannerAdapter {
  return {
    name,
    async verifyIdentity() {},
    async scan() {
      onScan?.();
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

function pipelineWith(
  replacements: Partial<Record<DeveloperScannerAdapter['name'], ScannerResult | Error>> = {},
  onScan?: () => void,
) {
  const policy = defineDeveloperTrustPolicy(policyInput());
  const { privateKey } = generateKeyPairSync('ed25519');
  const names = ['gitleaks', 'syft', 'osv-scanner', 'semgrep', 'license-policy'] as const;
  return new DeveloperTrustPipeline({
    policy,
    scanners: names.map((name) => scanner(name, replacements[name] ?? evidence(name), onScan)),
    signer: createEd25519EvidenceSigner({
      privateKey,
      keyId: 'openopc-worker-test',
      issuer: 'openopc-developer-trust-worker',
    }),
    now: () => new Date('2026-07-25T00:00:00.000Z'),
  });
}

describe('developer trust pipeline', () => {
  test('clean fixture creates deterministic CycloneDX and DSSE evidence', async () => {
    const pipeline = pipelineWith();
    const first = await pipeline.run(claim());
    const second = await pipeline.run(claim());

    expect(first.state).toBe('passed');
    expect(first.sbomDigest).toBe(second.sbomDigest);
    expect(first.attestationDigest).toBe(second.attestationDigest);
    expect(first.attestation.payloadType).toBe('application/vnd.in-toto+json');
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
});
