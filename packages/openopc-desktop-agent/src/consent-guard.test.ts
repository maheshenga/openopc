import { describe, expect, test } from 'bun:test';
import type { Capability, LocalPermission } from 'agent-tunnel';

import { createConsentGuardedRegistry, expandDesktopCapabilitySelection } from './capabilities';
import { confirmAndGrantDesktopConsent, wrapCapabilityWithConsent } from './consent-guard';
import { canonicalPermissionScopeDigest, createDesktopConsentStore } from './consent-store';

const NOW = Date.parse('2026-07-29T08:00:00.000Z');

function permission(scope: Record<string, unknown> = { paths: ['C:/workspace'] }): LocalPermission {
  return {
    permissionId: 'permission-1',
    capability: 'filesystem',
    scope,
    expiresAt: '2026-07-29T09:00:00.000Z',
  };
}

function request(serverPermission: LocalPermission) {
  return {
    tunnelId: 'tunnel-1',
    permissionId: serverPermission.permissionId,
    capability: serverPermission.capability,
    scopeDigest: canonicalPermissionScopeDigest(serverPermission),
    expiresAt: serverPermission.expiresAt ?? null,
  };
}

describe('desktop consent guard', () => {
  test('never invokes a capability handler when local consent is absent or mismatched', async () => {
    let calls = 0;
    let nonce = 0;
    const consentStore = createDesktopConsentStore({
      now: () => NOW,
      nonce: () => `guard-${++nonce}`,
    });
    const capability: Capability = {
      name: 'filesystem',
      methods: new Map([
        [
          'fs.read',
          async () => {
            calls += 1;
            return { ok: true };
          },
        ],
      ]),
    };
    const guarded = wrapCapabilityWithConsent(capability, {
      consentStore,
      tunnelId: 'tunnel-1',
      userId: 'user-1',
      deviceId: 'device-1',
    });
    const handler = guarded.methods.get('fs.read');
    const serverPermission = permission();

    await expect(
      handler?.({ path: 'C:/workspace/a.txt', __permission: serverPermission }),
    ).rejects.toThrow('LOCAL_CONSENT_MISSING');
    expect(calls).toBe(0);

    consentStore.grant({
      ...request(serverPermission),
      userId: 'user-2',
      deviceId: 'device-1',
    });
    await expect(
      handler?.({ path: 'C:/workspace/a.txt', __permission: serverPermission }),
    ).rejects.toThrow('LOCAL_CONSENT_MISMATCH');
    expect(calls).toBe(0);
  });

  test('preserves the server permission object and invokes the handler only after authorization', async () => {
    let observedPermission: unknown;
    let nonce = 0;
    const consentStore = createDesktopConsentStore({
      now: () => NOW,
      nonce: () => `guard-success-${++nonce}`,
    });
    const serverPermission = permission();
    consentStore.grant({
      ...request(serverPermission),
      userId: 'user-1',
      deviceId: 'device-1',
    });
    const capability: Capability = {
      name: 'filesystem',
      methods: new Map([
        [
          'fs.read',
          async (params) => {
            observedPermission = params.__permission;
            return { path: params.path };
          },
        ],
      ]),
    };
    const guarded = wrapCapabilityWithConsent(capability, {
      consentStore,
      tunnelId: 'tunnel-1',
      userId: 'user-1',
      deviceId: 'device-1',
    });

    await expect(
      guarded.methods.get('fs.read')?.({
        path: 'C:/workspace/a.txt',
        __permission: serverPermission,
      }),
    ).resolves.toEqual({ path: 'C:/workspace/a.txt' });
    expect(observedPermission).toBe(serverPermission);
  });

  test('requires an explicit native confirmation before adding consent', async () => {
    let confirmationCalls = 0;
    let nonce = 0;
    const consentStore = createDesktopConsentStore({
      now: () => NOW,
      nonce: () => `confirmation-${++nonce}`,
    });
    const serverPermission = permission();
    const nativeRequest = request(serverPermission);

    await expect(
      confirmAndGrantDesktopConsent({
        confirmation: {
          confirm: async () => {
            confirmationCalls += 1;
            return false;
          },
        },
        consentStore,
        request: nativeRequest,
        userId: 'user-1',
        deviceId: 'device-1',
      }),
    ).resolves.toBe(false);
    await expect(
      consentStore.authorize({
        tunnelId: 'tunnel-1',
        permission: serverPermission,
        userId: 'user-1',
        deviceId: 'device-1',
        method: 'fs.read',
        params: { path: 'C:/workspace/a.txt', __permission: serverPermission },
      }),
    ).rejects.toThrow('LOCAL_CONSENT_MISSING');

    await expect(
      confirmAndGrantDesktopConsent({
        confirmation: {
          confirm: async () => {
            confirmationCalls += 1;
            return true;
          },
        },
        consentStore,
        request: nativeRequest,
        userId: 'user-1',
        deviceId: 'device-1',
      }),
    ).resolves.toBe(true);
    expect(confirmationCalls).toBe(2);
    await expect(
      consentStore.authorize({
        tunnelId: 'tunnel-1',
        permission: serverPermission,
        userId: 'user-1',
        deviceId: 'device-1',
        method: 'fs.read',
        params: { path: 'C:/workspace/a.txt', __permission: serverPermission },
      }),
    ).resolves.toBeUndefined();
  });

  test('confirms and grants full access only as a three-permission bundle', async () => {
    let confirmationCalls = 0;
    let nonce = 0;
    const consentStore = createDesktopConsentStore({
      now: () => NOW,
      nonce: () => `bundle-confirmation-${++nonce}`,
    });
    const filesystemPermission = permission();
    const shellPermission: LocalPermission = {
      permissionId: 'permission-shell',
      capability: 'shell',
      scope: { commands: ['git'] },
      expiresAt: '2026-07-29T09:00:00.000Z',
    };
    const desktopPermission: LocalPermission = {
      permissionId: 'permission-desktop',
      capability: 'desktop',
      scope: { tools: ['click'] },
      expiresAt: '2026-07-29T09:00:00.000Z',
    };

    await expect(
      confirmAndGrantDesktopConsent({
        confirmation: {
          confirm: async () => {
            confirmationCalls += 1;
            return true;
          },
        },
        consentStore,
        request: [
          request(filesystemPermission),
          request(shellPermission),
          request(desktopPermission),
        ],
        userId: 'user-1',
        deviceId: 'device-1',
        consentKind: 'full_access',
        bundleId: 'bundle-1',
      }),
    ).resolves.toBe(true);
    expect(confirmationCalls).toBe(3);
    await expect(
      consentStore.authorize({
        tunnelId: 'tunnel-1',
        permission: filesystemPermission,
        userId: 'user-1',
        deviceId: 'device-1',
        method: 'fs.read',
        params: { path: 'C:/workspace/a.txt', __permission: filesystemPermission },
      }),
    ).resolves.toBeUndefined();
  });

  test('registers guarded capabilities without inventing a full_access capability', async () => {
    let calls = 0;
    let nonce = 0;
    const consentStore = createDesktopConsentStore({
      now: () => NOW,
      nonce: () => `registry-${++nonce}`,
    });
    const serverPermission = permission();
    consentStore.grant({
      ...request(serverPermission),
      userId: 'user-1',
      deviceId: 'device-1',
    });
    const registry = createConsentGuardedRegistry({
      capabilities: [
        {
          name: 'filesystem',
          methods: new Map([
            [
              'fs.read',
              async () => {
                calls += 1;
                return 'ok';
              },
            ],
          ]),
        },
      ],
      consentStore,
      tunnelId: 'tunnel-1',
      userId: 'user-1',
      deviceId: 'device-1',
    });

    expect(registry.getCapabilityNames()).toEqual(['filesystem']);
    expect(registry.has('full_access')).toBe(false);
    await expect(
      registry.getHandler('fs.read')?.({
        path: 'C:/workspace/a.txt',
        __permission: serverPermission,
      }),
    ).resolves.toBe('ok');
    expect(calls).toBe(1);
  });

  test('maps UI selections only to existing Tunnel capabilities', () => {
    expect(expandDesktopCapabilitySelection('filesystem')).toEqual(['filesystem']);
    expect(expandDesktopCapabilitySelection('local_execution')).toEqual(['shell']);
    expect(expandDesktopCapabilitySelection('desktop_automation')).toEqual(['desktop']);
    expect(expandDesktopCapabilitySelection('full_access')).toEqual([
      'filesystem',
      'shell',
      'desktop',
    ]);
  });
});
