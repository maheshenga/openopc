import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { evidenceDigest } from '../scanners/types';
import type {
  DeveloperModuleSandboxInput,
  DeveloperModuleSandboxPort,
  DeveloperModuleSandboxResult,
} from './types';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class WasmtimeDryRunError extends Error {
  override readonly name = 'WasmtimeDryRunError';

  constructor(readonly code: string) {
    super(code);
  }
}

export type WasmtimeExecutionResult =
  | {
      kind: 'completed';
      exitCode: number;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | { kind: 'inconclusive'; reason: string; durationMs: number };

export interface WasmtimeExecutorInput {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export interface WasmtimeDryRunControl extends DeveloperModuleSandboxPort {
  assertReady(): Promise<void>;
}

export function createWasmtimeDryRun(input: {
  executable: string;
  expectedExecutableDigest: `sha256:${string}`;
  expectedVersion: string;
  identity?: () => Promise<{ digest: `sha256:${string}`; version: string }>;
  execute?: (input: WasmtimeExecutorInput) => Promise<WasmtimeExecutionResult>;
}): WasmtimeDryRunControl {
  if (
    !absoluteExecutable(input.executable) ||
    !DIGEST.test(input.expectedExecutableDigest) ||
    !safeText(input.expectedVersion, 128)
  ) {
    fail('DEVELOPER_WASMTIME_CONFIG_INVALID');
  }
  const identity = input.identity ?? (() => readWasmtimeIdentity(input.executable));
  const execute = input.execute ?? executeWasmtime;
  const assertReady = async (): Promise<void> => {
    let actual: { digest: `sha256:${string}`; version: string };
    try {
      actual = await identity();
    } catch {
      fail('DEVELOPER_WASMTIME_UNAVAILABLE');
    }
    if (
      actual.digest !== input.expectedExecutableDigest ||
      actual.version !== input.expectedVersion
    ) {
      fail('DEVELOPER_WASMTIME_IDENTITY_MISMATCH');
    }
  };

  return {
    assertReady,
    async run(sandboxInput, signal) {
      await assertReady();
      const runtime = validateInput(sandboxInput);
      if (signal.aborted) return inconclusive(sandboxInput, 'cancelled', 0);
      const componentPath = await safeComponentPath(
        sandboxInput.artifactMount.source,
        runtime.componentPath,
      );
      let execution: WasmtimeExecutionResult;
      try {
        execution = await execute({
          executable: input.executable,
          args: ['run', '--invoke', runtime.operation, componentPath],
          cwd: sandboxInput.artifactMount.source,
          env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
          timeoutMs: sandboxInput.limits.wallTimeMs,
          maxOutputBytes: sandboxInput.limits.maxOutputBytes,
          signal,
        });
      } catch {
        return inconclusive(sandboxInput, 'process_unavailable', 0);
      }
      if (execution.kind === 'inconclusive') {
        return inconclusive(sandboxInput, execution.reason, execution.durationMs);
      }
      return completed(sandboxInput, execution);
    },
  };
}

function validateInput(
  input: DeveloperModuleSandboxInput,
): Extract<NonNullable<DeveloperModuleSandboxInput['runtime']>, { kind: 'wasi-component' }> {
  const runtime = input.runtime;
  if (
    input.profile !== 'server-conformance' ||
    input.networkPolicy.mode !== 'none' ||
    input.networkPolicy.allowedOrigins.length !== 0 ||
    input.networkPolicy.maxRedirects !== 0 ||
    runtime?.kind !== 'wasi-component' ||
    !safeRelativePath(runtime.componentPath) ||
    !safeText(runtime.world, 256) ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(runtime.operation) ||
    !safeText(input.runId, 128) ||
    !safeText(input.sandboxInstanceId, 128) ||
    !DIGEST.test(input.sandboxProfileDigest ?? '') ||
    !DIGEST.test(input.artifactDigest)
  ) {
    fail('DEVELOPER_WASMTIME_INPUT_INVALID');
  }
  return runtime;
}

async function safeComponentPath(workspace: string, component: string): Promise<string> {
  const root = await realpath(workspace);
  const target = await realpath(join(root, component));
  const stats = await lstat(target);
  if (!target.startsWith(`${root}${sep}`) || !stats.isFile() || stats.isSymbolicLink()) {
    fail('DEVELOPER_WASMTIME_COMPONENT_INVALID');
  }
  return target;
}

function completed(
  input: DeveloperModuleSandboxInput,
  execution: Extract<WasmtimeExecutionResult, { kind: 'completed' }>,
): DeveloperModuleSandboxResult {
  const passed = execution.exitCode === 0;
  const normalized = {
    exitCode: execution.exitCode,
    stdoutDigest: sha256(execution.stdout),
    stderrDigest: sha256(execution.stderr),
    durationMs: execution.durationMs,
  };
  return {
    runId: input.runId as string,
    sandboxInstanceId: input.sandboxInstanceId as string,
    artifactDigest: input.artifactDigest,
    sandboxProfileDigest: input.sandboxProfileDigest as `sha256:${string}`,
    state: passed ? 'passed' : 'failed',
    terminalReason: passed ? 'verification_completed' : 'component_failed',
    stdoutDigest: normalized.stdoutDigest,
    stderrDigest: normalized.stderrDigest,
    evidenceDigest: evidenceDigest(normalized),
    resourceUsage: {
      cpuMillis: Math.min(execution.durationMs, input.limits.cpuMillis),
      peakMemoryBytes: 0,
      pids: 1,
      outputBytes: Buffer.byteLength(execution.stdout) + Buffer.byteLength(execution.stderr),
    },
    tests: [
      {
        id: 'wasi-component-dry-run',
        outcome: passed ? 'passed' : 'failed',
        summary: passed ? 'WASI component dry-run passed' : 'WASI component dry-run failed',
      },
    ],
    capabilityAttempts: [],
    networkAttempts: [],
  };
}

function inconclusive(
  input: DeveloperModuleSandboxInput,
  reason: string,
  durationMs: number,
): DeveloperModuleSandboxResult {
  const terminalReason = new Set([
    'cancelled',
    'output_limit_exceeded',
    'process_terminated',
    'process_unavailable',
    'timeout',
  ]).has(reason)
    ? reason
    : 'process_unavailable';
  const stdoutDigest = sha256('');
  const stderrDigest = sha256('');
  return {
    runId: input.runId as string,
    sandboxInstanceId: input.sandboxInstanceId as string,
    artifactDigest: input.artifactDigest,
    sandboxProfileDigest: input.sandboxProfileDigest as `sha256:${string}`,
    state: terminalReason === 'cancelled' ? 'cancelled' : 'inconclusive',
    terminalReason,
    stdoutDigest,
    stderrDigest,
    evidenceDigest: evidenceDigest({ terminalReason, durationMs }),
    resourceUsage: { cpuMillis: 0, peakMemoryBytes: 0, pids: 0, outputBytes: 0 },
    tests: [],
    capabilityAttempts: [],
    networkAttempts: [],
  };
}

async function readWasmtimeIdentity(
  executable: string,
): Promise<{ digest: `sha256:${string}`; version: string }> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(executable);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolvePromise);
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const version = await executeWasmtime({
      executable,
      args: ['--version'],
      cwd: resolve(executable, '..'),
      env: { LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096,
      signal: controller.signal,
    });
    if (version.kind !== 'completed' || version.exitCode !== 0) {
      fail('DEVELOPER_WASMTIME_UNAVAILABLE');
    }
    return {
      digest: `sha256:${hash.digest('hex')}`,
      version: version.stdout.trim(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function executeWasmtime(input: WasmtimeExecutorInput): Promise<WasmtimeExecutionResult> {
  return new Promise((resolvePromise) => {
    const startedAt = performance.now();
    let settled = false;
    let reason: string | null = null;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: { ...input.env },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result: WasmtimeExecutionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', cancel);
      resolvePromise(result);
    };
    const stop = (nextReason: string) => {
      if (reason) return;
      reason = nextReason;
      child.kill('SIGKILL');
    };
    const collect = (target: Buffer[], chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += value.byteLength;
      if (outputBytes > input.maxOutputBytes) {
        stdout.length = 0;
        stderr.length = 0;
        stop('output_limit_exceeded');
      } else {
        target.push(value);
      }
    };
    const cancel = () => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs);
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', () =>
      finish({
        kind: 'inconclusive',
        reason: 'process_unavailable',
        durationMs: elapsed(startedAt),
      }),
    );
    child.once('close', (exitCode) => {
      if (reason) {
        finish({ kind: 'inconclusive', reason, durationMs: elapsed(startedAt) });
      } else if (exitCode === null) {
        finish({
          kind: 'inconclusive',
          reason: 'process_terminated',
          durationMs: elapsed(startedAt),
        });
      } else {
        finish({
          kind: 'completed',
          exitCode,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: elapsed(startedAt),
        });
      }
    });
    input.signal.addEventListener('abort', cancel, { once: true });
    if (input.signal.aborted) cancel();
  });
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.ceil(performance.now() - startedAt));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function absoluteExecutable(value: string): boolean {
  return (
    (/^\/[A-Za-z0-9._/-]+$/.test(value) || /^[A-Za-z]:\/[A-Za-z0-9._/-]+$/.test(value)) &&
    !value.includes('..') &&
    !/[\0\r\n]/.test(value)
  );
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/^[A-Za-z]:/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    !/[\0\r\n]/.test(value)
  );
}

function fail(code: string): never {
  throw new WasmtimeDryRunError(code);
}
