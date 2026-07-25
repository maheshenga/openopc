import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { executePinnedScannerProcess } from './process-adapter';

const digest = (character: string) => `sha256:${character.repeat(64)}` as const;
const originalSecret = process.env.TEST_SCANNER_SECRET;

afterEach(() => {
  if (originalSecret === undefined) delete process.env.TEST_SCANNER_SECRET;
  else process.env.TEST_SCANNER_SECRET = originalSecret;
});

describe('pinned scanner process adapter', () => {
  test('uses a temporary workspace, closed stdin, and an allow-listed environment', async () => {
    process.env.TEST_SCANNER_SECRET = 'must-not-reach-child';
    let workspace = '';
    const result = await executePinnedScannerProcess({
      executable: process.execPath,
      args: [
        '-e',
        'process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.TEST_SCANNER_SECRET,lang:process.env.LANG}))',
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
    expect(JSON.parse(result.stdout)).toEqual({ cwd: workspace, lang: 'C' });
    expect(existsSync(workspace)).toBe(false);
  });

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
