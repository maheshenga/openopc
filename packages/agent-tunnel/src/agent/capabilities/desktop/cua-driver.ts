import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { tmpdir } from 'os';
import { extname, join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';

const INSTALL_SCRIPT_URL =
  'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh';
const INSTALL_PS_URL =
  'https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export interface CuaInstallApproval {
  approved: true;
  source: 'github-release' | 'operator-package';
  expectedSha256: string;
  expiresAt: string;
}

export type CuaFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type CuaExecFile = (
  cmd: string,
  args: string[],
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<ExecResult>;

export interface CuaDriverDependencies {
  now?: () => number;
  platform?: typeof platform;
  findBinary?: () => string | null;
  fileExists?: (path: string) => boolean;
  fetch?: CuaFetch;
  execFile?: CuaExecFile;
  spawn?: typeof spawn;
  operatorPackagePath?: string;
}

export interface CuaToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

function candidateBins(): string[] {
  const candidates = [
    process.env.CUA_DRIVER_BIN,
    join(
      homedir(),
      '.local',
      'bin',
      process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver',
    ),
    '/usr/local/bin/cua-driver',
    '/opt/homebrew/bin/cua-driver',
  ];
  return candidates.filter((p): p is string => !!p);
}

function findBinaryOnPath(): string | null {
  for (const candidate of candidateBins()) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function inputStoppedError(): Error {
  return new Error('CUA input is stopped');
}

function executeFile(
  cmd: string,
  args: string[],
  timeoutMs = 30_000,
  signal?: AbortSignal,
): Promise<ExecResult> {
  if (signal?.aborted) return Promise.reject(inputStoppedError());

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      cleanup();
      reject(inputStoppedError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });

    proc.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`${cmd} failed (${code})${detail ? `: ${detail}` : ''}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function isDaemonProxyFallback(message: string): boolean {
  return message.includes('daemon proxy') && message.includes('Resource temporarily unavailable');
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw inputStoppedError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(inputStoppedError());
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      key === 'permissionId' ||
      key === 'permission_id' ||
      key === 'tunnelId' ||
      key === 'tunnel_id' ||
      key === 'actionHash' ||
      key === 'action_hash' ||
      key === 'killSwitchGeneration' ||
      key === 'kill_switch_generation' ||
      key === 'policyVersion' ||
      key === 'policy_version' ||
      key === 'approval' ||
      key === 'automation' ||
      key === 'lease' ||
      key === '__permission'
    ) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export class CuaDriver {
  private binary: string | null = null;
  private installPromise: Promise<string> | null = null;
  private installApprovalKey: string | null = null;
  private readonly now: () => number;
  private readonly currentPlatform: typeof platform;
  private readonly findBinary: () => string | null;
  private readonly fileExists: (path: string) => boolean;
  private readonly fetchFile: CuaFetch;
  private readonly runFile: CuaExecFile;
  private readonly spawnProcess: typeof spawn;
  private readonly operatorPackagePath?: string;
  private inputGeneration = 0;
  private inputStopped = false;
  private inputAbortController = new AbortController();

  constructor(dependencies: CuaDriverDependencies = {}) {
    this.now = dependencies.now ?? Date.now;
    this.currentPlatform = dependencies.platform ?? platform;
    this.findBinary = dependencies.findBinary ?? findBinaryOnPath;
    this.fileExists = dependencies.fileExists ?? existsSync;
    this.fetchFile = dependencies.fetch ?? globalThis.fetch;
    this.runFile = dependencies.execFile ?? executeFile;
    this.spawnProcess = dependencies.spawn ?? spawn;
    this.operatorPackagePath = dependencies.operatorPackagePath;
  }

  private locateBinary(): string | null {
    if (this.binary && this.fileExists(this.binary)) return this.binary;
    const found = this.findBinary();
    this.binary = found;
    return found;
  }

  private requireInstalled(): string {
    const found = this.locateBinary();
    if (!found) {
      throw new Error('cua-driver is not installed; explicit install approval is required');
    }
    return found;
  }

  private assertInputActive(generation: number): void {
    if (this.inputStopped || generation !== this.inputGeneration) {
      throw inputStoppedError();
    }
  }

  private validateApproval(approval: CuaInstallApproval | undefined): CuaInstallApproval {
    if (!approval || approval.approved !== true) {
      throw new Error('CUA install approval is required');
    }
    if (approval.source !== 'github-release' && approval.source !== 'operator-package') {
      throw new Error('Unsupported CUA install approval source');
    }
    if (!/^[a-f0-9]{64}$/i.test(approval.expectedSha256)) {
      throw new Error('CUA install approval expectedSha256 must be a SHA-256 hash');
    }
    const expiresAt = new Date(approval.expiresAt).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      throw new Error('CUA install approval has expired');
    }
    return approval;
  }

  private async approvedInstaller(approval: CuaInstallApproval): Promise<Uint8Array> {
    if (approval.source === 'github-release') {
      const url = this.currentPlatform() === 'win32' ? INSTALL_PS_URL : INSTALL_SCRIPT_URL;
      const response = await this.fetchFile(url, { redirect: 'error' });
      if (!response.ok) {
        throw new Error(`CUA fixed-source download failed (${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    const packagePath = this.operatorPackagePath ?? process.env.TUNNEL_CUA_OPERATOR_PACKAGE;
    if (!packagePath) {
      throw new Error('CUA install approval source operator-package is not configured');
    }
    const requiredExtension = this.currentPlatform() === 'win32' ? '.ps1' : '.sh';
    if (extname(packagePath).toLowerCase() !== requiredExtension) {
      throw new Error(
        `CUA install approval source requires a ${requiredExtension} operator package`,
      );
    }
    return new Uint8Array(await readFile(packagePath));
  }

  private async install(approval: CuaInstallApproval): Promise<string> {
    const installer = await this.approvedInstaller(approval);
    const actualSha256 = createHash('sha256').update(installer).digest('hex');
    if (actualSha256.toLowerCase() !== approval.expectedSha256.toLowerCase()) {
      throw new Error('CUA installer SHA-256 mismatch');
    }

    const directory = await mkdtemp(join(tmpdir(), 'cua-driver-install-'));
    const windows = this.currentPlatform() === 'win32';
    const installerPath = join(directory, windows ? 'install.ps1' : 'install.sh');
    try {
      await writeFile(installerPath, installer, { mode: 0o700 });
      this.validateApproval(approval);
      if (windows) {
        await this.runFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', installerPath],
          180_000,
        );
      } else {
        await this.runFile('/bin/bash', [installerPath, '--no-modify-path'], 180_000);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const installed = this.findBinary();
    if (!installed) {
      throw new Error('cua-driver install completed, but no cua-driver binary was found');
    }
    this.binary = installed;
    return installed;
  }

  async ensureInstalled(approval?: CuaInstallApproval): Promise<string> {
    const validatedApproval = this.validateApproval(approval);
    const found = this.locateBinary();
    if (found) return found;

    const approvalKey = [
      validatedApproval.source,
      validatedApproval.expectedSha256.toLowerCase(),
      validatedApproval.expiresAt,
    ].join(':');
    if (this.installPromise) {
      if (this.installApprovalKey !== approvalKey) {
        throw new Error('CUA in-progress install approval does not match');
      }
      return this.installPromise;
    }

    const installPromise = this.install(validatedApproval).finally(() => {
      if (this.installPromise === installPromise) {
        this.installPromise = null;
        this.installApprovalKey = null;
      }
    });
    this.installApprovalKey = approvalKey;
    this.installPromise = installPromise;
    return installPromise;
  }

  async version(): Promise<string> {
    const bin = this.requireInstalled();
    const { stdout } = await this.runFile(bin, ['--version'], 10_000);
    return stdout.trim();
  }

  async listTools(): Promise<string> {
    const bin = this.requireInstalled();
    const { stdout } = await this.runFile(bin, ['list-tools'], 10_000);
    return stdout.trim();
  }

  async describe(tool: string): Promise<string> {
    const bin = this.requireInstalled();
    const { stdout } = await this.runFile(bin, ['describe', tool], 10_000);
    return stdout.trim();
  }

  async status(): Promise<string> {
    const bin = this.locateBinary();
    if (!bin) return 'missing';
    const { stdout } = await this.runFile(bin, ['status'], 10_000);
    return stdout.trim();
  }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!tool || typeof tool !== 'string') throw new Error('CUA tool name is required');
    if (tool === 'end_session') return this.stopInput('remote_end_session');
    if (tool === 'start_session') return this.startInputSession(args);

    const bin = this.requireInstalled();
    const payload = JSON.stringify(sanitizeArgs(args));
    const generation = this.inputGeneration;
    const signal = this.inputAbortController.signal;
    this.assertInputActive(generation);
    let lastError: unknown;

    for (let attempt = 0; attempt < 4; attempt++) {
      this.assertInputActive(generation);
      try {
        const { stdout, stderr } = await this.runFile(bin, ['call', tool, payload], 60_000, signal);
        this.assertInputActive(generation);
        if (isDaemonProxyFallback(stderr)) {
          lastError = new Error(stderr.trim());
          await sleep(150 * (attempt + 1), signal);
          continue;
        }
        return parseJsonOutput(stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isDaemonProxyFallback(message)) {
          throw err;
        }
        lastError = err;
        await sleep(150 * (attempt + 1), signal);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async stopInput(reason = 'local_stop'): Promise<{ ok: true }> {
    this.inputStopped = true;
    this.inputGeneration++;
    this.inputAbortController.abort();

    const bin = this.locateBinary();
    if (!bin) return { ok: true };
    const payload = JSON.stringify({ reason });
    await this.runFile(bin, ['call', 'end_session', payload], 10_000);
    return { ok: true };
  }

  async startInputSession(args: Record<string, unknown> = {}): Promise<unknown> {
    const bin = this.requireInstalled();
    this.inputGeneration++;
    const generation = this.inputGeneration;
    this.inputAbortController.abort();
    this.inputAbortController = new AbortController();
    this.inputStopped = false;
    const signal = this.inputAbortController.signal;

    try {
      const payload = JSON.stringify(sanitizeArgs(args));
      const { stdout } = await this.runFile(
        bin,
        ['call', 'start_session', payload],
        60_000,
        signal,
      );
      this.assertInputActive(generation);
      return parseJsonOutput(stdout);
    } catch (err) {
      if (generation === this.inputGeneration) {
        this.inputStopped = true;
        this.inputAbortController.abort();
      }
      throw err;
    }
  }

  async startDaemon(): Promise<{ ok: true; status?: string }> {
    const bin = this.requireInstalled();

    if (this.currentPlatform() === 'darwin') {
      const child = this.spawnProcess('open', ['-n', '-g', '-a', 'CuaDriver', '--args', 'serve'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } else {
      const child = this.spawnProcess(bin, ['serve'], {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CUA_DRIVER_RS_PERMISSIONS_GATE: process.env.CUA_DRIVER_RS_PERMISSIONS_GATE ?? '0',
        },
      });
      child.unref();
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
    try {
      return { ok: true, status: await this.status() };
    } catch {
      return { ok: true };
    }
  }
}
