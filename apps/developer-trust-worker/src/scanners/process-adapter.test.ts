import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPinnedScannerCommandRunner, executePinnedScannerProcess } from './process-adapter';
import { DEVELOPER_TRUST_SCANNER_FAULT } from './types';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const originalSecret = process.env.TEST_SCANNER_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.TEST_SCANNER_SECRET;
  else process.env.TEST_SCANNER_SECRET = originalSecret;
});

describe('pinned scanner process adapter', () => {
  test('verifies exact binary identity and copies only the artifact workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openopc-scanner-source-'));
    try {
      const executable = Bun.which('node') ?? process.execPath;
      const version = spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim();
      await writeFile(join(workspace, 'fixture.txt'), 'artifact-only');
      const executableDigest = `sha256:${createHash('sha256')
        .update(await readFile(executable))
        .digest('hex')}` as const;
      const runner = createPinnedScannerCommandRunner();
      const scanner = {
        name: 'gitleaks' as const,
        executable,
        imageDigest: executableDigest,
        version,
        ruleDigest: digest('b'),
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      };
      await expect(runner.verifyIdentity(scanner)).resolves.toBeUndefined();
      await expect(
        runner.run({
          scanner,
          args: ['-e', "process.stdout.write(require('fs').readFileSync('fixture.txt','utf8'))"],
          scanInput: {
            workspacePath: workspace,
            moduleId: 'acme.clean',
            moduleVersion: '1.0.0',
            artifactDigest: digest('a'),
            verificationProfile: 'desktop-package',
            lockGraph: null,
            dependencyLicenses: [],
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toMatchObject({ kind: 'completed', stdout: 'artifact-only' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45_000);

  test('uses a temporary workspace, closed stdin, and an allow-listed environment', async () => {
    process.env.TEST_SCANNER_SECRET = 'must-not-reach-child';
    let workspace = '';
    const result = await executePinnedScannerProcess({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.TEST_SCANNER_SECRET,home:process.env.HOME,lang:process.env.LANG,path:process.env.PATH,semgrepMetrics:process.env.SEMGREP_SEND_METRICS,semgrepVersionCheck:process.env.SEMGREP_ENABLE_VERSION_CHECK}))',
      ],
      runtimeIdentityDigest: digest('a'),
      expectedIdentityDigest: digest('a'),
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      prepareWorkspace: async (directory) => {
        workspace = directory;
        expect(existsSync(directory)).toBe(true);
      },
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('expected completed process');
    expect(JSON.parse(result.stdout)).toEqual({
      cwd: workspace,
      home: workspace,
      lang: 'C',
      path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      semgrepMetrics: 'off',
      semgrepVersionCheck: '0',
    });
    expect(existsSync(workspace)).toBe(false);
  });

  test('acceptance fault starts and terminates the pinned scanner process', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openopc-scanner-source-'));
    try {
      const executable = Bun.which('node') ?? process.execPath;
      const executableDigest = `sha256:${createHash('sha256')
        .update(await readFile(executable))
        .digest('hex')}` as const;
      const runner = createPinnedScannerCommandRunner();

      await expect(
        runner.run({
          scanner: {
            name: 'semgrep',
            executable,
            imageDigest: executableDigest,
            version: spawnSync(executable, ['--version'], { encoding: 'utf8' }).stdout.trim(),
            ruleDigest: digest('b'),
            timeoutMs: 250,
            maxOutputBytes: 4_096,
          },
          args: ['-e', 'setInterval(() => undefined, 1_000)'],
          scanInput: {
            workspacePath: workspace,
            moduleId: 'acme.crash-probe',
            moduleVersion: '1.0.0',
            artifactDigest: digest('a'),
            verificationProfile: 'desktop-package',
            lockGraph: null,
            dependencyLicenses: [],
            [DEVELOPER_TRUST_SCANNER_FAULT]: 'terminate-process',
          },
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ kind: 'inconclusive', reason: 'process_terminated' });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45_000);

  test('fails closed for identity mismatch, timeout, output overflow, and cancellation', async () => {
    const identityMismatch = await executePinnedScannerProcess({
      executable: process.execPath,
      args: ['--version'],
      runtimeIdentityDigest: digest('a'),
      expectedIdentityDigest: digest('b'),
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      prepareWorkspace: async () => undefined,
    });
    const timeout = await executePinnedScannerProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      runtimeIdentityDigest: digest('a'),
      expectedIdentityDigest: digest('a'),
      timeoutMs: 100,
      maxOutputBytes: 4_096,
      prepareWorkspace: async () => undefined,
    });
    const overflow = await executePinnedScannerProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(1024))"],
      runtimeIdentityDigest: digest('a'),
      expectedIdentityDigest: digest('a'),
      timeoutMs: 5_000,
      maxOutputBytes: 64,
      prepareWorkspace: async () => undefined,
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const cancelled = await executePinnedScannerProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1_000)'],
      runtimeIdentityDigest: digest('a'),
      expectedIdentityDigest: digest('a'),
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      prepareWorkspace: async () => undefined,
      signal: controller.signal,
    });

    expect(identityMismatch).toEqual({ kind: 'inconclusive', reason: 'identity_mismatch' });
    expect(timeout).toEqual({ kind: 'inconclusive', reason: 'timeout' });
    expect(overflow).toEqual({ kind: 'inconclusive', reason: 'output_limit_exceeded' });
    expect(cancelled).toEqual({ kind: 'inconclusive', reason: 'cancelled' });
  });
});
