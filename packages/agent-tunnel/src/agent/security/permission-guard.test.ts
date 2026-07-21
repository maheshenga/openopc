import { describe, expect, test } from 'bun:test';
import { type LocalPermission, PermissionGuard } from './permission-guard';

const NOW = Date.parse('2026-07-22T08:00:00.000Z');

function desktopPermission(overrides: Partial<LocalPermission> = {}): LocalPermission {
  return {
    permissionId: 'permission-desktop',
    capability: 'desktop',
    scope: { features: ['screenshot'] },
    expiresAt: '2026-07-22T09:00:00.000Z',
    policyVersion: 'policy-v1',
    ...overrides,
  };
}

function checkScreenshot(guard: PermissionGuard, params: Record<string, unknown> = {}) {
  return guard.checkRequest({
    permissionId: 'permission-desktop',
    capability: 'desktop',
    method: 'desktop.cua.get_screen_size',
    params: { policyVersion: 'policy-v1', ...params },
    now: NOW,
  });
}

describe('PermissionGuard local request authorization', () => {
  test('rejects an unknown permission id', () => {
    const guard = new PermissionGuard();

    expect(() => checkScreenshot(guard)).toThrow(/unknown permission/i);
  });

  test('rejects an expired permission', () => {
    const guard = new PermissionGuard();
    guard.addPermission(desktopPermission({ expiresAt: '2026-07-22T07:59:59.999Z' }));

    expect(() => checkScreenshot(guard)).toThrow(/expired permission/i);
  });

  test('rejects a capability mismatch', () => {
    const guard = new PermissionGuard();
    guard.addPermission(desktopPermission());

    expect(() =>
      guard.checkRequest({
        permissionId: 'permission-desktop',
        capability: 'shell',
        method: 'shell.exec',
        params: { policyVersion: 'policy-v1' },
        now: NOW,
      }),
    ).toThrow(/permission capability .* does not match/i);
  });

  test('rejects a desktop method outside the feature scope', () => {
    const guard = new PermissionGuard();
    guard.addPermission(desktopPermission());

    expect(() =>
      guard.checkRequest({
        permissionId: 'permission-desktop',
        capability: 'desktop',
        method: 'desktop.cua.click',
        params: { policyVersion: 'policy-v1' },
        now: NOW,
      }),
    ).toThrow(/feature.*mouse/i);
  });

  test('rejects an action hash that does not match the permission scope', () => {
    const guard = new PermissionGuard();
    guard.addPermission(
      desktopPermission({
        scope: { features: ['screenshot'], action_hash: 'action-expected' },
      }),
    );

    expect(() => checkScreenshot(guard, { actionHash: 'action-other' })).toThrow(/action hash/i);
  });

  test('rejects a stale kill-switch generation', () => {
    const guard = new PermissionGuard();
    guard.addPermission(
      desktopPermission({
        scope: { features: ['screenshot'], killSwitchGeneration: 7 },
      }),
    );

    expect(() => checkScreenshot(guard, { kill_switch_generation: 6 })).toThrow(
      /kill-switch generation/i,
    );
  });

  test('rejects a mismatched policy version', () => {
    const guard = new PermissionGuard();
    guard.addPermission(desktopPermission());

    expect(() => checkScreenshot(guard, { policyVersion: 'policy-v2' })).toThrow(/policy version/i);
  });

  test('allows a scoped screenshot read with matching automation fencing', () => {
    const guard = new PermissionGuard();
    const permission = desktopPermission({
      scope: {
        features: ['screenshot'],
        actionHash: 'action-1',
        kill_switch_generation: 7,
      },
    });
    guard.addPermission(permission);

    expect(
      checkScreenshot(guard, {
        action_hash: 'action-1',
        killSwitchGeneration: 7,
      }),
    ).toEqual(permission);
  });

  test('accepts snake-case policy version from the permission wire payload', () => {
    const guard = new PermissionGuard();
    const permission = {
      ...desktopPermission({ policyVersion: undefined }),
      policy_version: 'policy-v1',
    } as LocalPermission & { policy_version: string };
    guard.addPermission(permission);

    expect(
      checkScreenshot(guard, { policyVersion: undefined, policy_version: 'policy-v1' }),
    ).toEqual(permission);
  });

  test('revokeAll invalidates every cached permission', () => {
    const guard = new PermissionGuard();
    guard.addPermission(desktopPermission());

    guard.revokeAll();

    expect(() => checkScreenshot(guard)).toThrow(/unknown permission/i);
  });

  test('kill-switch latch rejects permissions granted after revocation', () => {
    const guard = new PermissionGuard();

    guard.activateKillSwitch(9);
    guard.addPermission(desktopPermission());

    expect(() => checkScreenshot(guard)).toThrow(/kill switch.*active/i);
  });
});
