import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type ScannerProcessExecutionResult =
  | { kind: 'completed'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'inconclusive'; reason: string };

export interface ExecutePinnedScannerProcessInput {
  executable: string;
  args: readonly string[];
  runtimeIdentityDigest: `sha256:${string}`;
  expectedIdentityDigest: `sha256:${string}`;
  timeoutMs: number;
  maxOutputBytes: number;
  prepareWorkspace(directory: string): Promise<void>;
  signal?: AbortSignal;
}

export async function executePinnedScannerProcess(
  input: ExecutePinnedScannerProcessInput,
): Promise<ScannerProcessExecutionResult> {
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  if (
    !isAbsolute(input.executable) ||
    input.executable.includes('\0') ||
    input.args.some((argument) => argument.includes('\0')) ||
    !digestPattern.test(input.runtimeIdentityDigest) ||
    !digestPattern.test(input.expectedIdentityDigest) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    input.timeoutMs < 1 ||
    !Number.isSafeInteger(input.maxOutputBytes) ||
    input.maxOutputBytes < 1
  ) {
    return { kind: 'inconclusive', reason: 'invalid_configuration' };
  }
  if (input.runtimeIdentityDigest !== input.expectedIdentityDigest) {
    return { kind: 'inconclusive', reason: 'identity_mismatch' };
  }
  if (input.signal?.aborted) return { kind: 'inconclusive', reason: 'cancelled' };

  const workspace = await mkdtemp(join(tmpdir(), 'openopc-developer-trust-'));
  let result: ScannerProcessExecutionResult;
  try {
    try {
      await input.prepareWorkspace(workspace);
    } catch {
      return { kind: 'inconclusive', reason: 'workspace_prepare_failed' };
    }
    if (input.signal?.aborted) return { kind: 'inconclusive', reason: 'cancelled' };
    result = await runChildProcess(input, workspace);
  } finally {
    try {
      await rm(workspace, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      result = { kind: 'inconclusive', reason: 'workspace_cleanup_failed' };
    }
  }
  return result;
}

function runChildProcess(
  input: ExecutePinnedScannerProcessInput,
  workspace: string,
): Promise<ScannerProcessExecutionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let terminalReason: string | null = null;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(input.executable, [...input.args], {
      cwd: workspace,
      env: { LANG: 'C', LC_ALL: 'C' },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (result: ScannerProcessExecutionResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', cancel);
      resolve(result);
    };
    const stop = (reason: string): void => {
      if (terminalReason) return;
      terminalReason = reason;
      child.kill('SIGKILL');
    };
    const collect = (target: Buffer[], chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > input.maxOutputBytes) {
        stdout.length = 0;
        stderr.length = 0;
        stop('output_limit_exceeded');
        return;
      }
      target.push(buffer);
    };
    const cancel = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timeout'), input.timeoutMs);

    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', () => {
      terminalReason = terminalReason ?? 'process_unavailable';
      finish({ kind: 'inconclusive', reason: terminalReason });
    });
    child.once('close', (exitCode) => {
      if (terminalReason) {
        finish({ kind: 'inconclusive', reason: terminalReason });
        return;
      }
      if (exitCode === null) {
        finish({ kind: 'inconclusive', reason: 'process_terminated' });
        return;
      }
      finish({
        kind: 'completed',
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) cancel();
  });
}
