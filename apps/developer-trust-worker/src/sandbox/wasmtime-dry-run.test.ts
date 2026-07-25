import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DeveloperModuleSandboxInput } from './types';
import { createWasmtimeDryRun } from './wasmtime-dry-run';

const workspaces: string[] = [];
const digest = (character: string) => `sha256:${character.repeat(64)}` as const;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Wasmtime dry-run control', () => {
  test('uses argv-only execution with no ambient network or filesystem', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'openopc-wasi-test-'));
    workspaces.push(workspace);
    const component = join(workspace, 'module.wasm');
    await writeFile(component, Buffer.from([0x00, 0x61, 0x73, 0x6d]));
    const executions: Array<{ args: readonly string[]; env: Readonly<Record<string, string>> }> =
      [];
    const control = createWasmtimeDryRun({
      executable:
        process.platform === 'win32' ? 'C:/openopc/bin/wasmtime.exe' : '/opt/openopc/bin/wasmtime',
      expectedExecutableDigest: digest('a'),
      expectedVersion: 'wasmtime 47.0.2',
      identity: async () => ({ digest: digest('a'), version: 'wasmtime 47.0.2' }),
      execute: async (input) => {
        executions.push({ args: input.args, env: input.env });
        return { kind: 'completed', exitCode: 0, stdout: 'ok', stderr: '', durationMs: 8 };
      },
    });
    const sandboxInput: DeveloperModuleSandboxInput = {
      runId: '50000000-0000-4000-a000-000000000005',
      sandboxInstanceId: 'wasi-50000000',
      sandboxProfileDigest: digest('b'),
      artifactDigest: digest('c'),
      artifactMount: {
        source: workspace,
        target: '/artifact',
        digest: digest('c'),
        readOnly: true,
      },
      profile: 'server-conformance',
      fixtures: [],
      verificationCapability: 'verification-capability',
      limits: {
        cpuMillis: 1000,
        memoryBytes: 64 * 1024 * 1024,
        pids: 1,
        fileDescriptors: 16,
        maxFileBytes: 1024 * 1024,
        maxOutputBytes: 1024,
        wallTimeMs: 1000,
      },
      networkPolicy: {
        mode: 'none',
        allowedOrigins: [],
        allowedMethods: ['GET'],
        maxRequestBytes: 1,
        maxResponseBytes: 1,
        maxRedirects: 0,
      },
      runtime: {
        kind: 'wasi-component',
        componentPath: 'module.wasm',
        world: 'openopc:module/verification',
        operation: 'verify',
      },
    };

    await expect(control.run(sandboxInput, new AbortController().signal)).resolves.toMatchObject({
      state: 'passed',
      runId: sandboxInput.runId,
      sandboxInstanceId: sandboxInput.sandboxInstanceId,
    });
    expect(executions).toHaveLength(1);
    expect(executions[0].args).not.toContain('--dir');
    expect(Object.keys(executions[0].env).sort()).toEqual(['LANG', 'LC_ALL', 'TZ']);
  });
});
