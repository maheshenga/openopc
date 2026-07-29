import { describe, expect, test } from 'bun:test';

import { signMessage } from '../shared/crypto';
import { TunnelAgent, type TunnelAgentLifecycleEvent } from './agent';
import { CapabilityRegistry } from './capabilities';
import type { TunnelConfig } from './config';

function config(): TunnelConfig {
  return {
    token: 'setup-token',
    tunnelId: 'tunnel-1',
    apiUrl: 'https://api.example.com/v1/tunnel',
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

function registry(): CapabilityRegistry {
  const value = new CapabilityRegistry();
  value.register({
    name: 'desktop',
    methods: new Map([['desktop.cua.end_session', async () => ({ ok: true })]]),
  });
  return value;
}

async function handleRaw(agent: TunnelAgent, raw: string): Promise<void> {
  await (
    agent as unknown as {
      handleMessage(input: string): Promise<void>;
    }
  ).handleMessage(raw);
}

async function handleSigned(
  agent: TunnelAgent,
  signingKey: string,
  method: string,
  params: Record<string, unknown>,
  nonce: number,
  signature = signMessage(
    signingKey,
    JSON.stringify({ jsonrpc: '2.0' as const, method, params }),
    nonce,
  ),
): Promise<void> {
  await handleRaw(
    agent,
    JSON.stringify({ jsonrpc: '2.0', method, params, _sig: signature, _nonce: nonce }),
  );
}

describe('TunnelAgent lifecycle observer', () => {
  test('emits lifecycle events only after the existing authentication and signature gates', async () => {
    const events: TunnelAgentLifecycleEvent[] = [];
    const agent = new TunnelAgent(config(), registry(), {
      onEvent: (event) => events.push(event),
    });
    const signingKey = 'verified-signing-key';

    await handleRaw(agent, JSON.stringify({ type: 'auth_ok', signingKey }));
    await handleSigned(
      agent,
      signingKey,
      'tunnel.permissions.sync',
      {
        permissions: [
          {
            permissionId: 'permission-1',
            capability: 'filesystem',
            scope: { paths: ['C:/workspace'] },
          },
        ],
      },
      1,
      'invalid-signature',
    );
    expect(events).toEqual([{ type: 'auth_ok' }]);

    await handleSigned(
      agent,
      signingKey,
      'tunnel.permissions.sync',
      {
        permissions: [
          {
            permissionId: 'permission-1',
            capability: 'filesystem',
            scope: { paths: ['C:/workspace'] },
          },
        ],
      },
      1,
    );
    await handleSigned(
      agent,
      signingKey,
      'tunnel.permission.revoked',
      { permissionId: 'permission-1' },
      2,
    );
    await handleSigned(agent, signingKey, 'automation.kill_switch', { generation: 9 }, 3);
    await handleSigned(agent, signingKey, 'tunnel.token.rotated', {}, 4);

    expect(events).toEqual([
      { type: 'auth_ok' },
      {
        type: 'permissions_synced',
        permissions: [
          {
            permissionId: 'permission-1',
            capability: 'filesystem',
            scope: { paths: ['C:/workspace'] },
          },
        ],
      },
      { type: 'permission_revoked', permissionId: 'permission-1' },
      { type: 'kill_switch', generation: 9 },
      { type: 'token_rotated' },
    ]);
  });

  test('reports fake WebSocket close codes without changing the default transport', async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sockets: FakeWebSocket[] = [];
    class FakeWebSocket extends EventTarget {
      static readonly OPEN = 1;
      readyState = 0;

      constructor(readonly url: string | URL) {
        super();
        sockets.push(this);
      }

      send(): void {}

      close(code = 1000): void {
        this.readyState = 3;
        const event = new Event('close') as Event & { code: number };
        Object.defineProperty(event, 'code', { value: code });
        this.dispatchEvent(event);
      }
    }
    const events: TunnelAgentLifecycleEvent[] = [];
    try {
      globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
      const agent = new TunnelAgent(config(), registry(), {
        onEvent: (event) => events.push(event),
      });
      agent.connect();
      sockets[0]?.close(4001);
      await Promise.resolve();

      expect(events).toContainEqual({ type: 'connection_closed', code: 4001 });
      agent.disconnect();
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  });
});
