import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import type { DeveloperTrustScannerPolicy } from '../policy';
import type { ScannerCommandRunner } from './types';

const SCANNER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const SCANNER_IDENTITY_TIMEOUT_MS = 30_000;

function scannerProcessEnvironment(home: string) {
  return {
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: SCANNER_PATH,
    SEMGREP_ENABLE_VERSION_CHECK: '0',
    SEMGREP_SEND_METRICS: 'off',
  } as const;
}

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

export function createPinnedScannerCommandRunner(): ScannerCommandRunner {
  return {
    async verifyIdentity(scanner) {
      const actualDigest = await executableDigest(scanner.executable);
      if (actualDigest !== scanner.imageDigest) throw new Error('SCANNER_IDENTITY_MISMATCH');
      const version = await executableVersion(scanner.executable);
      if (version !== scanner.version) throw new Error('SCANNER_IDENTITY_MISMATCH');
    },
    async run(input) {
      let actualDigest: `sha256:${string}`;
      try {
        actualDigest = await executableDigest(input.scanner.executable);
      } catch {
        return { kind: 'inconclusive', reason: 'scanner_unavailable' };
      }
      return executePinnedScannerProcess({
        executable: input.scanner.executable,
        args: input.args,
        runtimeIdentityDigest: actualDigest,
        expectedIdentityDigest: input.scanner.imageDigest,
        timeoutMs: input.scanner.timeoutMs,
        maxOutputBytes: input.scanner.maxOutputBytes,
        signal: input.signal,
        prepareWorkspace: async (directory) => {
          await assertSafeWorkspace(input.scanInput.workspacePath);
          await cp(input.scanInput.workspacePath, directory, {
            recursive: true,
            force: false,
            errorOnExist: true,
            dereference: false,
          });
        },
      });
    },
  };
}

async function executableDigest(path: string): Promise<`sha256:${string}`> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new Error('SCANNER_PATH_INVALID');
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('SCANNER_PATH_INVALID');
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return `sha256:${hash.digest('hex')}`;
}

async function executableVersion(path: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'openopc-scanner-identity-'));
  try {
    return await new Promise((resolve, reject) => {
      let total = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const child = spawn(path, ['--version'], {
        env: scannerProcessEnvironment(home),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timeout = setTimeout(() => child.kill('SIGKILL'), SCANNER_IDENTITY_TIMEOUT_MS);
      const collect = (target: Buffer[], chunk: Buffer | string) => {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += value.byteLength;
        if (total > 4_096) child.kill('SIGKILL');
        else target.push(value);
      };
      child.stdout.on('data', (chunk) => collect(stdout, chunk));
      child.stderr.on('data', (chunk) => collect(stderr, chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || total > 4_096 || stderr.length > 0) {
          reject(new Error('SCANNER_VERSION_UNAVAILABLE'));
        } else {
          resolve(Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/, 1)[0]);
        }
      });
    });
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 2 });
  }
}

async function assertSafeWorkspace(root: string): Promise<void> {
  const pending = [root];
  let files = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      files += 1;
      if (files > 2_048 || entry.isSymbolicLink()) throw new Error('WORKSPACE_INVALID');
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (!entry.isFile()) throw new Error('WORKSPACE_INVALID');
    }
  }
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
      env: scannerProcessEnvironment(workspace),
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
