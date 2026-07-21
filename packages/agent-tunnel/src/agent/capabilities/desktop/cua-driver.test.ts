import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { createDesktopCapability } from '../desktop';
import { CuaDriver, type CuaInstallApproval } from './cua-driver';

const NOW = Date.parse('2026-07-22T08:00:00.000Z');
const originalAutoInstall = process.env.TUNNEL_CUA_AUTO_INSTALL;

function approval(overrides: Partial<CuaInstallApproval> = {}): CuaInstallApproval {
  return {
    approved: true,
    source: 'github-release',
    expectedSha256: '0'.repeat(64),
    expiresAt: '2026-07-22T09:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TUNNEL_CUA_AUTO_INSTALL = '0';
});

afterEach(() => {
  if (originalAutoInstall === undefined) {
    delete process.env.TUNNEL_CUA_AUTO_INSTALL;
  } else {
    process.env.TUNNEL_CUA_AUTO_INSTALL = originalAutoInstall;
  }
});

describe('CuaDriver explicit installation', () => {
  test('desktop capability initialization does not install or start the daemon', async () => {
    let ensureCalls = 0;
    let daemonCalls = 0;
    const driver = {
      ensureInstalled: async () => {
        ensureCalls++;
        return 'C:/cua-driver.exe';
      },
      startDaemon: async () => {
        daemonCalls++;
        return { ok: true as const };
      },
      status: async () => 'missing',
    } as unknown as CuaDriver;

    const capability = createDesktopCapability(driver);
    await Promise.resolve();

    expect(ensureCalls).toBe(0);
    expect(daemonCalls).toBe(0);
    expect(await capability.methods.get('desktop.cua.status')?.({})).toEqual({ status: 'missing' });
  });

  test('status returns missing without downloading when no binary exists', async () => {
    let fetchCalls = 0;
    const driver = new CuaDriver({
      findBinary: () => null,
      fetch: async () => {
        fetchCalls++;
        throw new Error('network must not be used');
      },
    });

    expect(await driver.status()).toBe('missing');
    expect(fetchCalls).toBe(0);
  });

  test('installation rejects when approval is missing', async () => {
    const driver = new CuaDriver({ findBinary: () => null });

    await expect(driver.ensureInstalled()).rejects.toThrow(/install approval is required/i);
  });

  test('ensure requires approval even when the binary is already installed', async () => {
    const driver = new CuaDriver({
      findBinary: () => '/opt/cua-driver',
      fileExists: () => true,
    });

    await expect(driver.ensureInstalled()).rejects.toThrow(/install approval is required/i);
  });

  test('installation rejects expired approval', async () => {
    const driver = new CuaDriver({ findBinary: () => null, now: () => NOW });

    await expect(
      driver.ensureInstalled(approval({ expiresAt: '2026-07-22T07:59:59.999Z' })),
    ).rejects.toThrow(/approval.*expired/i);
  });

  test('installation rejects unsupported approval source', async () => {
    const driver = new CuaDriver({ findBinary: () => null, now: () => NOW });

    await expect(
      driver.ensureInstalled(approval({ source: 'arbitrary-url' as CuaInstallApproval['source'] })),
    ).rejects.toThrow(/approval source/i);
  });

  test('installation rejects a downloaded script with the wrong hash', async () => {
    const driver = new CuaDriver({
      findBinary: () => null,
      now: () => NOW,
      platform: () => 'linux',
      fetch: async () => new Response('#!/bin/sh\nexit 0\n'),
    });

    await expect(driver.ensureInstalled(approval())).rejects.toThrow(/sha-256 mismatch/i);
  });

  test('installation rechecks approval expiry before executing the verified script', async () => {
    const script = '#!/bin/sh\nexit 0\n';
    const expectedSha256 = createHash('sha256').update(script).digest('hex');
    let now = NOW;
    let execCalls = 0;
    const driver = new CuaDriver({
      findBinary: () => null,
      now: () => now,
      platform: () => 'linux',
      fetch: async () => {
        now = Date.parse('2026-07-22T09:00:00.001Z');
        return new Response(script);
      },
      execFile: async () => {
        execCalls++;
        return { stdout: '', stderr: '' };
      },
    });

    await expect(driver.ensureInstalled(approval({ expectedSha256 }))).rejects.toThrow(
      /approval.*expired/i,
    );
    expect(execCalls).toBe(0);
  });

  test('approved fixed-source install verifies the hash before fixed execution', async () => {
    const script = '#!/bin/sh\nexit 0\n';
    const expectedSha256 = createHash('sha256').update(script).digest('hex');
    let installed = false;
    let requestedUrl = '';
    let executed: { command: string; args: string[] } | undefined;
    const driver = new CuaDriver({
      findBinary: () => (installed ? '/opt/cua-driver' : null),
      now: () => NOW,
      platform: () => 'linux',
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(script);
      },
      execFile: async (command, args) => {
        executed = { command, args };
        installed = true;
        return { stdout: '', stderr: '' };
      },
    });

    await expect(driver.ensureInstalled(approval({ expectedSha256 }))).resolves.toBe(
      '/opt/cua-driver',
    );
    expect(requestedUrl).toStartWith('https://raw.githubusercontent.com/trycua/cua/');
    expect(executed?.command).toBe('/bin/bash');
    expect(executed?.args.at(-1)).toBe('--no-modify-path');
  });

  test('a concurrent install cannot reuse a different approval hash', async () => {
    const script = '#!/bin/sh\nexit 0\n';
    const expectedSha256 = createHash('sha256').update(script).digest('hex');
    let installed = false;
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const driver = new CuaDriver({
      findBinary: () => (installed ? '/opt/cua-driver' : null),
      now: () => NOW,
      platform: () => 'linux',
      fetch: async () => {
        await downloadGate;
        return new Response(script);
      },
      execFile: async () => {
        installed = true;
        return { stdout: '', stderr: '' };
      },
    });

    const firstInstall = driver.ensureInstalled(approval({ expectedSha256 }));
    const mismatchedInstall = driver.ensureInstalled(approval({ expectedSha256: 'f'.repeat(64) }));
    releaseDownload();

    await expect(mismatchedInstall).rejects.toThrow(/in-progress install approval does not match/i);
    await expect(firstInstall).resolves.toBe('/opt/cua-driver');
  });

  test('desktop ensure forwards the explicit approval to the driver', async () => {
    const installApproval = approval();
    let received: CuaInstallApproval | undefined;
    const driver = {
      ensureInstalled: async (input?: CuaInstallApproval) => {
        received = input;
        return 'C:/cua-driver.exe';
      },
      version: async () => '1.2.3',
    } as unknown as CuaDriver;
    const capability = createDesktopCapability(driver);

    await expect(
      capability.methods.get('desktop.cua.ensure')?.({ approval: installApproval }),
    ).resolves.toEqual({ ok: true, binary: 'C:/cua-driver.exe', version: '1.2.3' });
    expect(received).toEqual(installApproval);
  });

  test('tool calls do not forward authorization metadata to CUA', async () => {
    let payload = '';
    const driver = new CuaDriver({
      findBinary: () => '/opt/cua-driver',
      fileExists: () => true,
      execFile: async (_command, args) => {
        payload = args[2] ?? '';
        return { stdout: '{"ok":true}', stderr: '' };
      },
    });

    await driver.call('click', {
      x: 10,
      permissionId: 'permission-1',
      action_hash: 'action-1',
      killSwitchGeneration: 4,
      policyVersion: 'policy-v1',
      __permission: { scope: 'secret' },
    });

    expect(JSON.parse(payload)).toEqual({ x: 10 });
  });

  test('stopping input prevents a transient input call from retrying', async () => {
    let clickAttempts = 0;
    let releaseFirstAttempt!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      releaseFirstAttempt = resolve;
    });
    const driver = new CuaDriver({
      findBinary: () => '/opt/cua-driver',
      fileExists: () => true,
      execFile: async (_command, args) => {
        if (args[1] === 'end_session') return { stdout: '{"ok":true}', stderr: '' };
        if (args[1] === 'click') {
          clickAttempts++;
          releaseFirstAttempt();
          return {
            stdout: '',
            stderr: 'daemon proxy: Resource temporarily unavailable',
          };
        }
        return { stdout: '{}', stderr: '' };
      },
    });

    expect(typeof driver.stopInput).toBe('function');
    const call = driver.call('click', { x: 10, y: 20 });
    await firstAttempt;
    await driver.stopInput('automation_kill_switch');

    await expect(call).rejects.toThrow(/input.*stopped|aborted/i);
    expect(clickAttempts).toBe(1);
  });

  test('stopping input aborts active child execution', async () => {
    let markClickStarted!: () => void;
    let activeCallAborted = false;
    const clickStarted = new Promise<void>((resolve) => {
      markClickStarted = resolve;
    });
    const driver = new CuaDriver({
      findBinary: () => '/opt/cua-driver',
      fileExists: () => true,
      execFile: async (_command, args, _timeout, signal) => {
        if (args[1] === 'end_session') return { stdout: '{"ok":true}', stderr: '' };
        if (args[1] !== 'click') return { stdout: '{}', stderr: '' };
        markClickStarted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            activeCallAborted = true;
            reject(new Error('CUA input is stopped'));
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      },
    });

    const call = driver.call('click', { x: 10, y: 20 });
    await clickStarted;
    await driver.stopInput('connection_closed');

    await expect(call).rejects.toThrow(/input.*stopped/i);
    expect(activeCallAborted).toBe(true);
  });

  test('desktop end_session uses the fail-closed stop path', async () => {
    let stopCalls = 0;
    let genericCalls = 0;
    const driver = {
      call: async () => {
        genericCalls++;
        return { ok: true };
      },
      stopInput: async () => {
        stopCalls++;
        return { ok: true as const };
      },
    } as unknown as CuaDriver;
    const capability = createDesktopCapability(driver);

    await capability.methods.get('desktop.cua.end_session')?.({});

    expect(stopCalls).toBe(1);
    expect(genericCalls).toBe(0);
  });
});
