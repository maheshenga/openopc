import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PERMISSION_A = '10000000-0000-4000-a000-000000000001';
const PERMISSION_B = '10000000-0000-4000-a000-000000000002';

let permissionResult: { allowed: boolean; permissionId?: string; reason?: string };
let checkedRequiredPermissionId: string | undefined;
let permissionRequestInsertCalls = 0;
const relayInputs: Array<Record<string, unknown>> = [];

mock.module('@kortix/db', () => ({
  tunnelConnections: {},
  tunnelPermissionRequests: {},
}));
mock.module('../shared/db', () => ({
  db: {
    insert: () => {
      permissionRequestInsertCalls += 1;
      throw new Error('permission request persistence must not run in this test');
    },
  },
}));
mock.module('agent-tunnel', () => ({
  TunnelMethods: { 'desktop.cua.click': 'desktop' },
  TunnelErrorCode: { LOCAL_ERROR: 1, NOT_CONNECTED: 2, TIMEOUT: 3 },
  TunnelRelayError: class TunnelRelayError extends Error {
    code = 1;
  },
}));
mock.module('../tunnel/core/permission-checker', () => ({
  checkPermission: async (
    _tunnelId: string,
    _capability: string,
    _operation: string,
    _params: Record<string, unknown>,
    requiredPermissionId?: string,
  ) => {
    checkedRequiredPermissionId = requiredPermissionId;
    return permissionResult;
  },
}));
mock.module('../tunnel/core/audit-logger', () => ({
  buildRequestSummary: () => ({}),
  writeAuditLog: () => undefined,
}));
mock.module('../tunnel/routes/permission-requests', () => ({
  notifyPermissionRequest: () => undefined,
}));
mock.module('../tunnel/core/rate-limiter', () => ({
  tunnelRateLimiter: { check: () => ({ allowed: true }) },
}));
mock.module('../tunnel/core/scope-validator', () => ({
  isValidCapability: () => true,
  validateScope: () => ({ valid: true, sanitized: {} }),
}));
mock.module('../tunnel/core/cluster-forwarder', () => ({
  isTunnelConnectionLive: () => true,
  relayRpcToConnectedAgent: async (input: Record<string, unknown>) => {
    relayInputs.push(input);
    return 'relayed';
  },
}));

const { executeTunnelRpc } = await import('../tunnel/core/rpc-core');

describe('tunnel RPC required permission fencing', () => {
  beforeEach(() => {
    permissionResult = { allowed: true, permissionId: PERMISSION_A };
    checkedRequiredPermissionId = undefined;
    permissionRequestInsertCalls = 0;
    relayInputs.length = 0;
  });

  test('passes the exact required permission through check and relay', async () => {
    permissionResult = { allowed: true, permissionId: PERMISSION_B };

    const outcome = await executeTunnelRpc({
      tunnelId: '20000000-0000-4000-a000-000000000001',
      accountId: '30000000-0000-4000-a000-000000000001',
      method: 'desktop.cua.click',
      params: { x: 12, y: 24, permissionId: PERMISSION_A },
      requiredPermissionId: PERMISSION_B,
    });

    expect(outcome).toEqual({ ok: true, result: 'relayed' });
    expect(checkedRequiredPermissionId).toBe(PERMISSION_B);
    expect(relayInputs[0]).toMatchObject({ params: { permissionId: PERMISSION_B } });
  });

  test('rejects permission substitution and malformed required IDs before relay', async () => {
    const substituted = await executeTunnelRpc({
      tunnelId: '20000000-0000-4000-a000-000000000001',
      accountId: '30000000-0000-4000-a000-000000000001',
      method: 'desktop.cua.click',
      params: { x: 12, y: 24 },
      requiredPermissionId: PERMISSION_B,
    });
    expect(substituted).toMatchObject({ ok: false, kind: 'bad_request' });
    expect(relayInputs).toHaveLength(0);

    const malformed = await executeTunnelRpc({
      tunnelId: '20000000-0000-4000-a000-000000000001',
      accountId: '30000000-0000-4000-a000-000000000001',
      method: 'desktop.cua.click',
      params: { x: 12, y: 24 },
      requiredPermissionId: 'not-a-uuid',
    });
    expect(malformed).toMatchObject({ ok: false, kind: 'bad_request' });
    expect(relayInputs).toHaveLength(0);
  });

  test('fails closed without creating a permission request when the required permission is denied', async () => {
    permissionResult = {
      allowed: false,
      reason: 'Required permission is inactive',
    };

    const outcome = await executeTunnelRpc({
      tunnelId: '20000000-0000-4000-a000-000000000001',
      accountId: '30000000-0000-4000-a000-000000000001',
      method: 'desktop.cua.click',
      params: { x: 12, y: 24 },
      requiredPermissionId: PERMISSION_B,
    });

    expect(outcome).toEqual({
      ok: false,
      kind: 'bad_request',
      message: 'Required permission is inactive',
    });
    expect(checkedRequiredPermissionId).toBe(PERMISSION_B);
    expect(relayInputs).toHaveLength(0);
    expect(permissionRequestInsertCalls).toBe(0);
  });

  test('keeps existing callers compatible when no required permission is supplied', async () => {
    const outcome = await executeTunnelRpc({
      tunnelId: '20000000-0000-4000-a000-000000000001',
      accountId: '30000000-0000-4000-a000-000000000001',
      method: 'desktop.cua.click',
      params: { x: 12, y: 24 },
    });

    expect(outcome).toEqual({ ok: true, result: 'relayed' });
    expect(checkedRequiredPermissionId).toBeUndefined();
    expect(relayInputs[0]).toMatchObject({ params: { permissionId: PERMISSION_A } });
  });
});
