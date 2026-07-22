import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { Hono } from 'hono';
import {
  createAutomationDesktopExecutorApp,
  createMemoryAutomationDesktopNonceStore,
} from './desktop-executor';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const TUNNEL_ID = '50000000-0000-4000-a000-000000000001';
const PERMISSION_ID = '60000000-0000-4000-a000-000000000001';
const REQUEST_ID = '70000000-0000-4000-a000-000000000001';
const NONCE = '80000000-0000-4000-a000-000000000001';
const NOW = new Date('2099-07-22T10:00:00.000Z');
const SHARED_SECRET = 'test-shared-secret-at-least-thirty-two-characters';
const PATH = '/internal/automation/desktop/execute';

function validBody() {
  return {
    protocol_version: 'automation.v1',
    request_id: REQUEST_ID,
    tunnel_id: TUNNEL_ID,
    account_id: ACCOUNT_ID,
    method: 'desktop.cua.get_screen_size',
    required_permission_id: PERMISSION_ID,
    params: {
      permissionId: PERMISSION_ID,
      automation: {
        lease: {
          lease_id: LEASE_ID,
          job_id: JOB_ID,
          project_id: PROJECT_ID,
          execution_domain: 'desktop',
          owner: 'desktop-worker:session-1',
          permission_id: PERMISSION_ID,
          request_hash: `sha256:${'a'.repeat(64)}`,
          kill_switch_generation: 7,
          issued_at: '2099-07-22T09:59:00.000Z',
          expires_at: '2099-07-22T10:01:00.000Z',
          signature: `hmac-sha256:${'b'.repeat(64)}`,
        },
        job_id: JOB_ID,
        project_id: PROJECT_ID,
        lease_id: LEASE_ID,
        lease_owner: 'desktop-worker:session-1',
        action_hash: `sha256:${'c'.repeat(64)}`,
        policy_version: `sha256:${'d'.repeat(64)}`,
        kill_switch_generation: 7,
        traceparent: null,
      },
    },
  };
}

function signedRequest(body: unknown, options: { timestamp?: Date; nonce?: string } = {}): Request {
  const timestamp = options.timestamp ?? NOW;
  const nonce = options.nonce ?? NONCE;
  const rawBody = JSON.stringify(body);
  const bodyHash = `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
  const canonical = [
    'automation-desktop-executor.v1',
    timestamp.toISOString(),
    'automation-control',
    'kortix-api',
    nonce,
    'POST',
    PATH,
    bodyHash,
    ACCOUNT_ID,
    PROJECT_ID,
  ].join('\n');
  const signature = createHmac('sha256', SHARED_SECRET).update(canonical).digest('hex');
  return new Request(`http://api.local${PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-automation-service-id': 'automation-control',
      'x-automation-audience': 'kortix-api',
      'x-automation-timestamp': timestamp.toISOString(),
      'x-automation-nonce': nonce,
      'x-automation-body-sha256': bodyHash,
      'x-automation-signature': `hmac-sha256:${signature}`,
      'x-automation-account-id': ACCOUNT_ID,
      'x-automation-project-id': PROJECT_ID,
    },
    body: rawBody,
  });
}

describe('automation desktop executor bridge', () => {
  test('relays one signed observe-only call with the exact permission fence', async () => {
    const relayInputs: unknown[] = [];
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async (input) => {
          relayInputs.push(input);
          return { ok: true, result: { width: 1920, height: 1080 } };
        },
      }),
    );

    const response = await root.fetch(signedRequest(validBody()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: { width: 1920, height: 1080 },
    });
    expect(relayInputs).toEqual([
      {
        tunnelId: TUNNEL_ID,
        accountId: ACCOUNT_ID,
        method: 'desktop.cua.get_screen_size',
        requiredPermissionId: PERMISSION_ID,
        params: validBody().params,
      },
    ]);
  });

  test('rejects a replay for the entire timestamp acceptance window', async () => {
    const signedAt = new Date(NOW.getTime() + 60_000);
    const replayedAt = new Date(signedAt.getTime() + 60_000);
    const checkedAt = [NOW, NOW, replayedAt, replayedAt];
    let nowIndex = 0;
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => checkedAt[Math.min(nowIndex++, checkedAt.length - 1)] ?? replayedAt,
        maxSkewMs: 60_000,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: { width: 1920, height: 1080 } };
        },
      }),
    );

    const first = await root.fetch(signedRequest(validBody(), { timestamp: signedAt }));
    const replay = await root.fetch(signedRequest(validBody(), { timestamp: signedAt }));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(relayCalls).toBe(1);
  });

  test('rejects an expired lease before any Tunnel relay', async () => {
    const body = validBody();
    body.params.automation.lease.issued_at = '2099-07-22T09:57:00.000Z';
    body.params.automation.lease.expires_at = '2099-07-22T09:59:00.000Z';
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: { width: 1920, height: 1080 } };
        },
      }),
    );

    const response = await root.fetch(signedRequest(body));

    expect(response.status).toBe(400);
    expect(relayCalls).toBe(0);
  });

  test('rechecks lease expiry after asynchronous scope checks and before relay', async () => {
    let currentTime = NOW;
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => currentTime,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => {
          currentTime = new Date('2099-07-22T10:01:01.000Z');
          return true;
        },
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: { width: 1920, height: 1080 } };
        },
      }),
    );

    const response = await root.fetch(signedRequest(validBody()));

    expect(response.status).toBe(400);
    expect(relayCalls).toBe(0);
  });

  test('does not let accepted mTLS evidence bypass an invalid HMAC', async () => {
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        requireMtls: true,
        isMtlsAuthenticated: () => true,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: null };
        },
      }),
    );
    const request = signedRequest(validBody());
    request.headers.set('x-automation-signature', `hmac-sha256:${'0'.repeat(64)}`);

    const response = await root.fetch(request);

    expect(response.status).toBe(401);
    expect(relayCalls).toBe(0);
  });

  test('rejects an operate method before any Tunnel relay', async () => {
    const body = validBody();
    body.method = 'desktop.cua.click';
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: null };
        },
      }),
    );

    const response = await root.fetch(signedRequest(body));

    expect(response.status).toBe(400);
    expect(relayCalls).toBe(0);
  });

  test('requires both feature flags before authenticating or relaying', async () => {
    let relayCalls = 0;
    for (const flags of [
      { controlEnabled: false, desktopExecutorEnabled: true },
      { controlEnabled: true, desktopExecutorEnabled: false },
    ]) {
      const root = new Hono();
      root.route(
        '/internal/automation/desktop',
        createAutomationDesktopExecutorApp({
          ...flags,
          sharedSecret: SHARED_SECRET,
          allowedServiceIds: ['automation-control'],
          audience: 'kortix-api',
          nonceStore: createMemoryAutomationDesktopNonceStore(),
          now: () => NOW,
          verifyProjectScope: async () => true,
          verifyTunnelOwnership: async () => true,
          executeTunnelRpc: async () => {
            relayCalls += 1;
            return { ok: true, result: null };
          },
        }),
      );

      const response = await root.fetch(signedRequest(validBody()));
      expect(response.status).toBe(503);
    }
    expect(relayCalls).toBe(0);
  });

  test('returns an opaque not-found response for a tunnel outside the signed account', async () => {
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        verifyProjectScope: async () => true,
        verifyTunnelOwnership: async () => false,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: null };
        },
      }),
    );

    const response = await root.fetch(signedRequest(validBody()));

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'AUTOMATION_DESKTOP_EXECUTOR_NOT_FOUND',
    });
    expect(relayCalls).toBe(0);
  });

  test('rejects permission substitution before scope lookup or Tunnel relay', async () => {
    const body = validBody();
    body.params.permissionId = '60000000-0000-4000-a000-000000000002';
    let scopeCalls = 0;
    let relayCalls = 0;
    const root = new Hono();
    root.route(
      '/internal/automation/desktop',
      createAutomationDesktopExecutorApp({
        controlEnabled: true,
        desktopExecutorEnabled: true,
        sharedSecret: SHARED_SECRET,
        allowedServiceIds: ['automation-control'],
        audience: 'kortix-api',
        nonceStore: createMemoryAutomationDesktopNonceStore(),
        now: () => NOW,
        verifyProjectScope: async () => {
          scopeCalls += 1;
          return true;
        },
        verifyTunnelOwnership: async () => true,
        executeTunnelRpc: async () => {
          relayCalls += 1;
          return { ok: true, result: null };
        },
      }),
    );

    const response = await root.fetch(signedRequest(body));

    expect(response.status).toBe(400);
    expect(scopeCalls).toBe(0);
    expect(relayCalls).toBe(0);
  });
});
