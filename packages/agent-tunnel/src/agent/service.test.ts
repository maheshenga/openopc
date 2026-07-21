import { describe, expect, test } from 'bun:test';
import { platform } from 'os';
import { signMessage } from '../shared/crypto';
import { TunnelAgent } from './agent';
import { CapabilityRegistry } from './capabilities';
import type { TunnelConfig } from './config';
import type { PermissionGuard } from './security/permission-guard';
import {
  SERVICE_LABEL,
  buildServiceShellCommand,
  getServicePaths,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsPowerShellScript,
} from './service';

function testConfig(): TunnelConfig {
  return {
    token: 'test-token',
    tunnelId: 'test-tunnel',
    apiUrl: 'http://localhost:8080',
    wsPath: '/ws',
    maxFileSize: 1024,
    allowedPaths: [],
    allowedCommands: [],
    blockedCommands: [],
    blockedPaths: [],
    workingDir: '.',
    shellTimeout: 1_000,
    shellMaxTimeout: 1_000,
    shellMaxOutputSize: 1024,
    shellEnvPassthrough: [],
  };
}

function localGuard(agent: TunnelAgent): PermissionGuard {
  return (agent as unknown as { permissionGuard: PermissionGuard }).permissionGuard;
}

async function handleRpc(
  agent: TunnelAgent,
  request: { id: string; method: string; params?: Record<string, unknown> },
): Promise<void> {
  await (
    agent as unknown as {
      handleRpcRequest(input: typeof request): Promise<void>;
    }
  ).handleRpcRequest(request);
}

async function handleSignedNotification(
  agent: TunnelAgent,
  method: string,
  params: Record<string, unknown>,
  nonce = 1,
): Promise<void> {
  const signingKey = 'local-test-signing-key';
  (agent as unknown as { signingKey: string | null }).signingKey = signingKey;
  const payload = { jsonrpc: '2.0' as const, method, params };
  const raw = JSON.stringify({
    ...payload,
    _sig: signMessage(signingKey, JSON.stringify(payload), nonce),
    _nonce: nonce,
  });
  await (
    agent as unknown as {
      handleMessage(input: string): Promise<void>;
    }
  ).handleMessage(raw);
}

describe('agent tunnel service definitions', () => {
  test('builds a command that runs the supervised tunnel agent', () => {
    const command = buildServiceShellCommand();
    expect(command).toContain("'run'");
    expect(command).toContain("'--service'");
    expect(command).toStartWith('exec ');
  });

  test('keep-awake command wraps the service on supported platforms', () => {
    const command = buildServiceShellCommand({ keepAwake: true });
    expect(command).toContain("'run'");
    expect(command).toContain("'--service'");
    if (platform() === 'darwin') {
      expect(command).toContain('/usr/bin/caffeinate -dimsu');
    }
    if (platform() === 'linux') {
      expect(command).toContain('systemd-inhibit');
    }
  });

  test('launchd plist restarts and runs at login', () => {
    const plist = renderLaunchdPlist('exec /bin/echo tunnel');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('agent-tunnel.out.log');
    expect(plist).toContain('agent-tunnel.err.log');
  });

  test('systemd unit restarts forever', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Description=Kortix Agent Tunnel');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('agent-tunnel.out.log');
    expect(unit).toContain('agent-tunnel.err.log');
  });

  test('windows scheduled-task script restarts forever and can keep awake', () => {
    const script = renderWindowsPowerShellScript(
      { keepAwake: true },
      { command: 'node', args: ['agent-tunnel.js', 'run', '--service'] },
    );
    expect(script).toContain('SetThreadExecutionState');
    expect(script).toContain('while ($true)');
    expect(script).toContain("& 'node' 'agent-tunnel.js' 'run' '--service'");
    expect(script).toContain('Start-Sleep -Seconds 5');
  });

  test('service paths are under the user home', () => {
    const paths = getServicePaths();
    expect(paths.configDir).toContain('.agent-tunnel');
    expect(paths.logDir).toContain('.agent-tunnel');
    expect(paths.launchdPlist).toContain(`${SERVICE_LABEL}.plist`);
    expect(paths.systemdUnit).toContain(`${SERVICE_LABEL}.service`);
    expect(paths.windowsScript).toContain('agent-tunnel-service.ps1');
  });
});

describe('agent tunnel local automation stop boundary', () => {
  test('rejects an RPC before consulting the registry when local authorization fails', async () => {
    let registryLookups = 0;
    const registry = {
      getHandler: () => {
        registryLookups++;
        return async () => ({ ok: true });
      },
      getCapabilityNames: () => [],
    } as unknown as CapabilityRegistry;
    const agent = new TunnelAgent(testConfig(), registry);
    localGuard(agent).addPermission({
      permissionId: 'permission-desktop',
      capability: 'desktop',
      scope: { features: ['screenshot'] },
    });

    await handleRpc(agent, {
      id: 'request-1',
      method: 'shell.exec',
      params: { permissionId: 'permission-desktop' },
    });

    expect(registryLookups).toBe(0);
  });

  test('fails closed for a malformed signed RPC method', async () => {
    let registryLookups = 0;
    const registry = {
      getHandler: () => {
        registryLookups++;
        return async () => ({ ok: true });
      },
      getCapabilityNames: () => [],
    } as unknown as CapabilityRegistry;
    const agent = new TunnelAgent(testConfig(), registry);

    await expect(
      handleRpc(agent, {
        id: 'request-malformed',
        method: 42 as unknown as string,
        params: { permissionId: 'permission-desktop' },
      }),
    ).resolves.toBeUndefined();
    expect(registryLookups).toBe(0);
  });

  test('signed kill switch revokes permissions and stops local input', async () => {
    let stopCalls = 0;
    const registry = new CapabilityRegistry();
    registry.register({
      name: 'desktop',
      methods: new Map([
        [
          'desktop.cua.end_session',
          async () => {
            stopCalls++;
            return { ok: true };
          },
        ],
      ]),
    });
    const agent = new TunnelAgent(testConfig(), registry);
    localGuard(agent).addPermission({
      permissionId: 'permission-1',
      capability: 'desktop',
      scope: {},
    });

    await handleSignedNotification(agent, 'automation.kill_switch', { generation: 9 });

    expect(localGuard(agent).checkPermission('permission-1')).toBe(false);
    expect(stopCalls).toBe(1);
  });

  test('kill switch ignores concurrent permission sync and grant notifications', async () => {
    let releaseStop!: () => void;
    let markStopStarted!: () => void;
    const stopStarted = new Promise<void>((resolve) => {
      markStopStarted = resolve;
    });
    const stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const registry = new CapabilityRegistry();
    registry.register({
      name: 'desktop',
      methods: new Map([
        [
          'desktop.cua.end_session',
          async () => {
            markStopStarted();
            await stopGate;
            return { ok: true };
          },
        ],
      ]),
    });
    const agent = new TunnelAgent(testConfig(), registry);
    localGuard(agent).addPermission({
      permissionId: 'permission-old',
      capability: 'desktop',
      scope: {},
    });

    const killSwitch = handleSignedNotification(
      agent,
      'automation.kill_switch',
      { generation: 9 },
      1,
    );
    await stopStarted;
    await handleSignedNotification(
      agent,
      'tunnel.permissions.sync',
      {
        permissions: [{ permissionId: 'permission-sync', capability: 'desktop', scope: {} }],
      },
      2,
    );
    await handleSignedNotification(
      agent,
      'tunnel.permission.granted',
      { permissionId: 'permission-grant', capability: 'desktop', scope: {} },
      3,
    );
    releaseStop();
    await killSwitch;

    expect(localGuard(agent).checkPermission('permission-old')).toBe(false);
    expect(localGuard(agent).checkPermission('permission-sync')).toBe(false);
    expect(localGuard(agent).checkPermission('permission-grant')).toBe(false);
  });

  test('disconnect revokes permissions and stops local input', async () => {
    let stopCalls = 0;
    const registry = new CapabilityRegistry();
    registry.register({
      name: 'desktop',
      methods: new Map([
        [
          'desktop.cua.end_session',
          async () => {
            stopCalls++;
            return { ok: true };
          },
        ],
      ]),
    });
    const agent = new TunnelAgent(testConfig(), registry);
    localGuard(agent).addPermission({
      permissionId: 'permission-1',
      capability: 'desktop',
      scope: {},
    });

    agent.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(localGuard(agent).checkPermission('permission-1')).toBe(false);
    expect(stopCalls).toBe(1);
  });
});
