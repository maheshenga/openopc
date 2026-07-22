import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import {
  createAutomationDesktopExecutorApp,
  createMemoryAutomationDesktopNonceStore,
} from '../../../api/src/automation/desktop-executor';
import { createAutomationApiTunnelExecutor } from './api-tunnel-executor';

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

function validParams() {
  return {
    permissionId: PERMISSION_ID,
    automation: {
      lease: {
        lease_id: LEASE_ID,
        job_id: JOB_ID,
        project_id: PROJECT_ID,
        execution_domain: 'desktop' as const,
        owner: 'desktop-worker:session-1',
        permission_id: PERMISSION_ID,
        request_hash: `sha256:${'a'.repeat(64)}` as const,
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
  };
}

describe('automation API Tunnel executor client', () => {
  test('signs and sends the exact desktop permission fence to the API bridge', async () => {
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
    const requestFetch = ((input: string | URL | Request, init?: RequestInit) =>
      root.fetch(new Request(input, init))) as typeof fetch;
    const executeTunnelRpc = createAutomationApiTunnelExecutor({
      baseUrl: 'http://api.local',
      sharedSecret: SHARED_SECRET,
      serviceId: 'automation-control',
      audience: 'kortix-api',
      now: () => NOW,
      nextNonce: () => NONCE,
      nextRequestId: () => REQUEST_ID,
      fetch: requestFetch,
    });
    const params = validParams();

    const outcome = await executeTunnelRpc({
      tunnelId: TUNNEL_ID,
      accountId: ACCOUNT_ID,
      method: 'desktop.cua.get_screen_size',
      requiredPermissionId: PERMISSION_ID,
      params,
    });

    expect(outcome).toEqual({ ok: true, result: { width: 1920, height: 1080 } });
    expect(relayInputs).toEqual([
      {
        tunnelId: TUNNEL_ID,
        accountId: ACCOUNT_ID,
        method: 'desktop.cua.get_screen_size',
        requiredPermissionId: PERMISSION_ID,
        params,
      },
    ]);
  });

  test('never treats a non-success HTTP response as a relayed Tunnel success', async () => {
    const executeTunnelRpc = createAutomationApiTunnelExecutor({
      baseUrl: 'http://api.local',
      sharedSecret: SHARED_SECRET,
      now: () => NOW,
      nextNonce: () => NONCE,
      nextRequestId: () => REQUEST_ID,
      fetch: (async () =>
        Response.json(
          { ok: true, result: { forged: true } },
          { status: 401 },
        )) as unknown as typeof fetch,
    });

    const outcome = await executeTunnelRpc({
      tunnelId: TUNNEL_ID,
      accountId: ACCOUNT_ID,
      method: 'desktop.cua.get_screen_size',
      requiredPermissionId: PERMISSION_ID,
      params: validParams(),
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'error',
      message: 'Automation API desktop executor rejected the request (401)',
    });
  });

  test('combines coordinator cancellation with the bounded transport timeout', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const abortController = new AbortController();
    const executeTunnelRpc = createAutomationApiTunnelExecutor({
      baseUrl: 'http://api.local',
      sharedSecret: SHARED_SECRET,
      now: () => NOW,
      nextNonce: () => NONCE,
      nextRequestId: () => REQUEST_ID,
      fetch: (async (_input, init) => {
        requestSignal = init?.signal;
        return Response.json({ ok: true, result: { width: 1920, height: 1080 } });
      }) as typeof fetch,
    });

    await executeTunnelRpc({
      tunnelId: TUNNEL_ID,
      accountId: ACCOUNT_ID,
      method: 'desktop.cua.get_screen_size',
      requiredPermissionId: PERMISSION_ID,
      params: validParams(),
      signal: abortController.signal,
    });
    abortController.abort();

    expect(requestSignal?.aborted).toBeTrue();
  });
});
