import { describe, expect, test } from 'bun:test';

import { createGitleaksScanner } from './gitleaks';
import { createLicensePolicyScanner } from './license-policy';
import { createOsvScanner } from './osv';
import { createSemgrepScanner } from './semgrep';
import { createSyftScanner } from './syft';
import type { ScannerCommandRunner, ScannerInput } from './types';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const sri = (character: string) =>
  `sha512-${Buffer.alloc(64, character.charCodeAt(0)).toString('base64')}`;

function scannerInput(): ScannerInput {
  return {
    workspacePath: '/tmp/openopc-fixture',
    moduleId: 'acme.clean',
    moduleVersion: '1.0.0',
    artifactDigest: digest('a'),
    verificationProfile: 'desktop-package',
    lockGraph: {
      format: 'openopc-lock.v1',
      nodes: [
        {
          name: 'z-package',
          version: '2.0.0',
          resolved: 'https://registry.example/z-package.tgz',
          integrity: sri('z'),
          dependencies: {},
        },
        {
          name: 'a-package',
          version: '1.0.0',
          resolved: 'https://registry.example/a-package.tgz',
          integrity: sri('a'),
          dependencies: { 'z-package': '2.0.0' },
        },
      ],
    },
    dependencyLicenses: [
      { name: 'a-package', version: '1.0.0', license: 'MIT' },
      { name: 'z-package', version: '2.0.0', license: 'Apache-2.0' },
    ],
  };
}

function runner(
  outputs: Record<string, { exitCode: number; stdout: unknown } | Error>,
): ScannerCommandRunner {
  return {
    async verifyIdentity() {},
    async run(input) {
      const output = outputs[input.scanner.name];
      if (output instanceof Error) throw output;
      if (!output) return { kind: 'inconclusive', reason: 'scanner_unavailable' };
      return {
        kind: 'completed',
        exitCode: output.exitCode,
        stdout: typeof output.stdout === 'string' ? output.stdout : JSON.stringify(output.stdout),
        stderr: '',
      };
    },
  };
}

describe('developer trust scanner adapters', () => {
  test('command scanners target the isolated runner workspace instead of the source path', async () => {
    const seen: string[][] = [];
    const commandRunner: ScannerCommandRunner = {
      async verifyIdentity() {},
      async run(input) {
        seen.push([...input.args]);
        const stdout =
          input.scanner.name === 'gitleaks'
            ? []
            : input.scanner.name === 'syft'
              ? {
                  bomFormat: 'CycloneDX',
                  components: scannerInput().lockGraph?.nodes.map((node) => ({
                    type: 'library',
                    name: node.name,
                    version: node.version,
                  })),
                }
              : input.scanner.name === 'osv-scanner'
                ? { results: [] }
                : { results: [], errors: [] };
        return { kind: 'completed', exitCode: 0, stdout: JSON.stringify(stdout), stderr: '' };
      },
    };
    const signal = new AbortController().signal;
    await Promise.all([
      createGitleaksScanner(commandRunner).scan(scannerInput(), signal),
      createSyftScanner(commandRunner).scan(scannerInput(), signal),
      createOsvScanner(commandRunner).scan(scannerInput(), signal),
      createSemgrepScanner(commandRunner).scan(scannerInput(), signal),
    ]);

    expect(seen.flat()).not.toContain(scannerInput().workspacePath);
    expect(seen.every((args) => args.includes('.'))).toBe(true);
  });

  test('redacts Gitleaks secrets and converts OSV/Semgrep findings into bounded evidence', async () => {
    const secret = 'fixture-sensitive-value-do-not-echo-1234567890';
    const commandRunner = runner({
      gitleaks: {
        exitCode: 1,
        stdout: [
          {
            RuleID: 'generic-api-key',
            Description: 'Generic API key',
            File: 'src/config.ts',
            StartLine: 4,
            Fingerprint: 'fixture-fingerprint',
            Secret: secret,
          },
        ],
      },
      'osv-scanner': {
        exitCode: 1,
        stdout: {
          results: [
            {
              packages: [
                {
                  package: { name: 'a-package', version: '1.0.0' },
                  vulnerabilities: [{ id: 'OSV-2026-1', database_specific: { severity: 'HIGH' } }],
                },
              ],
            },
          ],
        },
      },
      semgrep: {
        exitCode: 1,
        stdout: {
          results: [
            {
              check_id: 'openopc.unsafe-eval',
              path: 'src/index.ts',
              start: { line: 8, col: 2 },
              extra: { severity: 'ERROR', message: 'Unsafe dynamic evaluation' },
            },
          ],
          errors: [],
        },
      },
    });
    const signal = new AbortController().signal;
    const results = await Promise.all([
      createGitleaksScanner(commandRunner).scan(scannerInput(), signal),
      createOsvScanner(commandRunner).scan(scannerInput(), signal),
      createSemgrepScanner(commandRunner).scan(scannerInput(), signal),
    ]);

    expect(results.map((result) => result.state)).toEqual(['failed', 'failed', 'failed']);
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain(secret);
    expect(results.flatMap((result) => result.findings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scanner: 'gitleaks', severity: 'critical' }),
        expect.objectContaining({ scanner: 'osv-scanner', severity: 'high' }),
        expect.objectContaining({ scanner: 'semgrep', severity: 'high' }),
      ]),
    );
  });

  test('normalizes Syft output to deterministic CycloneDX 1.6 and enforces license policy', async () => {
    const commandRunner = runner({
      syft: {
        exitCode: 0,
        stdout: {
          bomFormat: 'CycloneDX',
          specVersion: '1.5',
          serialNumber: 'urn:uuid:random',
          metadata: { timestamp: '2099-01-01T00:00:00Z' },
          components: [
            {
              type: 'library',
              name: 'z-package',
              version: '2.0.0',
              purl: 'pkg:npm/z-package@2.0.0',
            },
            {
              type: 'library',
              name: 'a-package',
              version: '1.0.0',
              purl: 'pkg:npm/wrong@9.0.0',
            },
          ],
        },
      },
    });
    const syft = await createSyftScanner(commandRunner).scan(
      scannerInput(),
      new AbortController().signal,
    );
    const allowed = await createLicensePolicyScanner({
      allowedLicenses: ['MIT', 'Apache-2.0'],
    }).scan(scannerInput(), new AbortController().signal);
    const blocked = await createLicensePolicyScanner({ allowedLicenses: ['MIT'] }).scan(
      scannerInput(),
      new AbortController().signal,
    );

    expect(syft.state).toBe('passed');
    expect(syft.sbom).toEqual(
      expect.objectContaining({
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        components: [
          expect.objectContaining({
            name: 'a-package',
            purl: 'pkg:npm/a-package@1.0.0',
            hashes: [{ alg: 'SHA-512', content: '61'.repeat(64) }],
          }),
          expect.objectContaining({ name: 'z-package' }),
        ],
      }),
    );
    expect(JSON.stringify(syft.sbom)).not.toMatch(/serialNumber|timestamp/);
    expect(allowed.state).toBe('passed');
    expect(blocked).toMatchObject({ state: 'failed', findings: [expect.any(Object)] });
  });

  test('scanner crash and malformed output are inconclusive', async () => {
    const crashed = await createGitleaksScanner(
      runner({ gitleaks: new Error('secret raw crash') }),
    ).scan(scannerInput(), new AbortController().signal);
    const malformed = await createSyftScanner(
      runner({ syft: { exitCode: 0, stdout: '{not-json' } }),
    ).scan(scannerInput(), new AbortController().signal);

    expect(crashed).toEqual(
      expect.objectContaining({ state: 'inconclusive', terminalReason: 'scanner_crash' }),
    );
    expect(malformed).toEqual(
      expect.objectContaining({ state: 'inconclusive', terminalReason: 'malformed_output' }),
    );
    expect(JSON.stringify(crashed)).not.toContain('secret raw crash');
  });

  test('finding exit codes with empty findings are inconclusive', async () => {
    const commandRunner = runner({
      gitleaks: { exitCode: 1, stdout: [] },
      'osv-scanner': { exitCode: 1, stdout: { results: [] } },
      semgrep: { exitCode: 1, stdout: { results: [], errors: [] } },
    });
    const signal = new AbortController().signal;
    const results = await Promise.all([
      createGitleaksScanner(commandRunner).scan(scannerInput(), signal),
      createOsvScanner(commandRunner).scan(scannerInput(), signal),
      createSemgrepScanner(commandRunner).scan(scannerInput(), signal),
    ]);

    expect(results.map((result) => result.state)).toEqual([
      'inconclusive',
      'inconclusive',
      'inconclusive',
    ]);
  });

  test('incomplete lock dependency graphs cannot produce a passing SBOM', async () => {
    const input = scannerInput();
    if (!input.lockGraph) throw new Error('expected lock graph');
    input.lockGraph.nodes[1].dependencies = { missing: '9.0.0' };
    const syft = await createSyftScanner(
      runner({
        syft: {
          exitCode: 0,
          stdout: {
            bomFormat: 'CycloneDX',
            components: input.lockGraph.nodes.map((node) => ({
              type: 'library',
              name: node.name,
              version: node.version,
            })),
          },
        },
      }),
    ).scan(input, new AbortController().signal);

    expect(syft).toMatchObject({ state: 'inconclusive', terminalReason: 'malformed_output' });
  });

  test('invalid lock integrity cannot produce a hashless passing SBOM', async () => {
    const input = scannerInput();
    if (!input.lockGraph) throw new Error('expected lock graph');
    input.lockGraph.nodes[0].integrity = 'sha512-invalid';
    const syft = await createSyftScanner(
      runner({
        syft: {
          exitCode: 0,
          stdout: {
            bomFormat: 'CycloneDX',
            components: input.lockGraph.nodes.map((node) => ({
              type: 'library',
              name: node.name,
              version: node.version,
            })),
          },
        },
      }),
    ).scan(input, new AbortController().signal);

    expect(syft).toMatchObject({ state: 'inconclusive', terminalReason: 'malformed_output' });
  });
});
