import { describe, expect, test } from 'bun:test';
import type { LocalPermission } from 'agent-tunnel';

import {
  canonicalPermissionScopeDigest,
  createAesGcmConsentCipher,
  createDesktopConsentStore,
} from './consent-store';

const START = Date.parse('2026-07-29T08:00:00.000Z');

function permission(overrides: Partial<LocalPermission> = {}): LocalPermission {
  return {
    permissionId: 'permission-1',
    capability: 'filesystem',
    scope: {
      operations: ['read'],
      paths: ['C:/workspace'],
      nested: { z: true, a: 1 },
    },
    expiresAt: '2026-07-29T12:00:00.000Z',
    policyVersion: '2026-07-01',
    ...overrides,
  };
}

function grantInput(serverPermission: LocalPermission, overrides: Record<string, unknown> = {}) {
  return {
    tunnelId: 'tunnel-1',
    permissionId: serverPermission.permissionId,
    capability: serverPermission.capability,
    scopeDigest: canonicalPermissionScopeDigest(serverPermission),
    expiresAt: serverPermission.expiresAt ?? null,
    userId: 'user-1',
    deviceId: 'device-1',
    ...overrides,
  };
}

function authorization(serverPermission: LocalPermission, overrides: Record<string, unknown> = {}) {
  return {
    tunnelId: 'tunnel-1',
    permission: serverPermission,
    userId: 'user-1',
    deviceId: 'device-1',
    method: 'fs.read',
    params: {
      path: 'C:/workspace/readme.md',
      __permission: serverPermission,
    },
    ...overrides,
  };
}

describe('desktop consent store', () => {
  test('uses stable recursive ordering for the canonical server permission digest', () => {
    const left = permission();
    const right = permission({
      scope: {
        nested: { a: 1, z: true },
        paths: ['C:/workspace'],
        operations: ['read'],
      },
    });

    expect(canonicalPermissionScopeDigest(left)).toBe(canonicalPermissionScopeDigest(right));
    expect(
      canonicalPermissionScopeDigest(
        permission({ scope: { ...left.scope, paths: ['C:/different'] } }),
      ),
    ).not.toBe(canonicalPermissionScopeDigest(left));
  });

  test('binds consent to the exact tunnel, permission, capability, user, device, scope, and expiry', async () => {
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => START,
      nonce: () => `nonce-${++nonce}`,
    });
    const serverPermission = permission();
    store.grant(grantInput(serverPermission));

    const mismatches = [
      authorization(serverPermission, { tunnelId: 'tunnel-2' }),
      authorization(permission({ permissionId: 'permission-2' })),
      authorization(permission({ capability: 'shell' }), { method: 'shell.exec' }),
      authorization(serverPermission, { userId: 'user-2' }),
      authorization(serverPermission, { deviceId: 'device-2' }),
      authorization(permission({ scope: { ...serverPermission.scope, paths: ['C:/other'] } })),
      authorization(permission({ expiresAt: '2026-07-29T12:00:01.000Z' })),
    ];

    for (const mismatch of mismatches) {
      await expect(store.authorize(mismatch)).rejects.toThrow('LOCAL_CONSENT_MISMATCH');
    }

    await expect(store.authorize(authorization(serverPermission))).resolves.toBeUndefined();
  });

  test('fails closed for missing, expired, and revoked consent', async () => {
    let now = START;
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => now,
      nonce: () => `nonce-${++nonce}`,
    });
    const serverPermission = permission({ expiresAt: '2026-07-29T08:30:00.000Z' });

    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_MISSING',
    );

    store.grant(grantInput(serverPermission));
    store.revoke(serverPermission.permissionId, 'server_revoked');
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_REVOKED',
    );

    store.grant(grantInput(serverPermission));
    now = Date.parse('2026-07-29T08:30:00.001Z');
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_EXPIRED',
    );
  });

  test('consumes the same request-bound permit once and rejects its replay', async () => {
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => START,
      nonce: () => `permit-${++nonce}`,
    });
    const serverPermission = permission();
    store.grant(grantInput(serverPermission));
    const input = authorization(serverPermission);
    const permit = store.issuePermit(input);

    await expect(store.consumePermit(permit, input)).resolves.toBeUndefined();
    await expect(store.consumePermit(permit, input)).rejects.toThrow('LOCAL_PERMIT_REPLAYED');
  });

  test('rejects a permit issued before the consent generation changed', async () => {
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => START,
      nonce: () => `generation-${++nonce}`,
    });
    const original = permission();
    const changed = permission({
      scope: {
        ...original.scope,
        paths: ['C:/workspace', 'D:/expanded'],
      },
    });
    store.grant(grantInput(original));
    const oldPermit = store.issuePermit(authorization(original));
    store.revoke(original.permissionId, 'server_revoked');
    store.grant(grantInput(changed));

    await expect(store.consumePermit(oldPermit, authorization(changed))).rejects.toThrow(
      'LOCAL_PERMIT_INVALID',
    );
  });

  test('bounds a full-access bundle consent to at most one hour', async () => {
    let now = START;
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => now,
      nonce: () => `full-access-${++nonce}`,
    });
    const serverPermission = permission({ expiresAt: '2026-07-29T18:00:00.000Z' });
    const shellPermission = permission({
      permissionId: 'permission-shell',
      capability: 'shell',
      scope: { commands: ['git'] },
      expiresAt: '2026-07-29T18:00:00.000Z',
    });
    const desktopPermission = permission({
      permissionId: 'permission-desktop',
      capability: 'desktop',
      scope: { tools: ['click'] },
      expiresAt: '2026-07-29T18:00:00.000Z',
    });
    store.grantBundle(
      [serverPermission, shellPermission, desktopPermission].map((entry) =>
        grantInput(entry, { consentKind: 'full_access', bundleId: 'bundle-1' }),
      ),
    );

    now = START + 60 * 60 * 1000 - 1;
    await expect(store.authorize(authorization(serverPermission))).resolves.toBeUndefined();

    now = START + 60 * 60 * 1000;
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_EXPIRED',
    );
  });

  test('expires every full-access member at the earliest cloud permission expiry', async () => {
    let now = START;
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => now,
      nonce: () => `bundle-expiry-${++nonce}`,
    });
    const filesystemPermission = permission({ expiresAt: '2026-07-29T10:00:00.000Z' });
    const shellPermission = permission({
      permissionId: 'permission-shell',
      capability: 'shell',
      scope: { commands: ['git'] },
      expiresAt: '2026-07-29T08:20:00.000Z',
    });
    const desktopPermission = permission({
      permissionId: 'permission-desktop',
      capability: 'desktop',
      scope: { tools: ['click'] },
      expiresAt: '2026-07-29T09:00:00.000Z',
    });
    store.grantBundle(
      [filesystemPermission, shellPermission, desktopPermission].map((entry) =>
        grantInput(entry, { consentKind: 'full_access', bundleId: 'bundle-early-expiry' }),
      ),
    );

    now = Date.parse('2026-07-29T08:20:00.000Z');
    await expect(store.authorize(authorization(filesystemPermission))).rejects.toThrow(
      'LOCAL_CONSENT_EXPIRED',
    );
  });

  test('persists only encrypted metadata and appends redacted audit events', async () => {
    let encrypted: string | null = null;
    let failureMarker = false;
    const auditEvents: unknown[] = [];
    let nonce = 0;
    const persistence = {
      readEncrypted: () => encrypted,
      writeEncrypted: (value: string) => {
        encrypted = value;
      },
      clear: () => {
        encrypted = null;
      },
      readFailureMarker: () => failureMarker,
      quarantine: () => {
        failureMarker = true;
      },
      clearFailureMarker: () => {
        failureMarker = false;
      },
    };
    const cipher = createAesGcmConsentCipher(Buffer.alloc(32, 7));
    const serverPermission = permission();
    const createStore = () =>
      createDesktopConsentStore({
        now: () => START,
        nonce: () => `persisted-${++nonce}`,
        persistence,
        cipher,
        audit: { append: (event: unknown) => auditEvents.push(event) },
      });
    const store = createStore();

    store.grant(grantInput(serverPermission));
    expect(encrypted).toStartWith('aead.v1.');
    expect(encrypted).not.toContain('tunnel-1');
    expect(encrypted).not.toContain('user-1');
    expect(encrypted).not.toContain('C:/workspace');

    const rehydrated = createStore();
    await expect(rehydrated.authorize(authorization(serverPermission))).resolves.toBeUndefined();
    rehydrated.revoke(serverPermission.permissionId, 'contains-sensitive-reason');

    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain('tunnel-1');
    expect(serializedAudit).not.toContain('user-1');
    expect(serializedAudit).not.toContain('device-1');
    expect(serializedAudit).not.toContain('C:/workspace');
    expect(serializedAudit).not.toContain('contains-sensitive-reason');
  });

  test('refuses persistence when no encryption port is available', () => {
    expect(() =>
      createDesktopConsentStore({
        persistence: {
          readEncrypted: () => null,
          writeEncrypted: () => undefined,
          clear: () => undefined,
          readFailureMarker: () => false,
          quarantine: () => undefined,
          clearFailureMarker: () => undefined,
        },
      }),
    ).toThrow('LOCAL_CONSENT_ENCRYPTION_REQUIRED');
  });

  test('checks the durable failure marker before reading encrypted consent', () => {
    let encryptedReads = 0;
    let decrypts = 0;
    let markerClears = 0;

    expect(() =>
      createDesktopConsentStore({
        persistence: {
          readEncrypted: () => {
            encryptedReads += 1;
            return 'stale-encrypted-grant';
          },
          writeEncrypted: () => undefined,
          clear: () => undefined,
          readFailureMarker: () => true,
          quarantine: () => undefined,
          clearFailureMarker: () => {
            markerClears += 1;
          },
        },
        cipher: {
          kind: 'authenticated',
          encrypt: (plaintext) => plaintext,
          decrypt: () => {
            decrypts += 1;
            return '{}';
          },
        },
      }),
    ).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    expect(encryptedReads).toBe(0);
    expect(decrypts).toBe(0);
    expect(markerClears).toBe(0);
  });

  test('fails closed when the durable failure marker cannot be read', () => {
    let encryptedReads = 0;
    let markerReadable = false;

    expect(() =>
      createDesktopConsentStore({
        persistence: {
          readEncrypted: () => {
            encryptedReads += 1;
            return null;
          },
          writeEncrypted: () => undefined,
          clear: () => undefined,
          readFailureMarker: () => {
            if (!markerReadable) throw new Error('marker unavailable');
            return true;
          },
          quarantine: () => {
            markerReadable = true;
          },
          clearFailureMarker: () => undefined,
        },
        cipher: createAesGcmConsentCipher(Buffer.alloc(32, 8)),
      }),
    ).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    expect(encryptedReads).toBe(0);
  });

  test('enters a fail-closed state when revoke persistence fails', async () => {
    let encrypted: string | null = null;
    let failureMarker = false;
    let failWrites = false;
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => START,
      nonce: () => `failure-${++nonce}`,
      persistence: {
        readEncrypted: () => encrypted,
        writeEncrypted: (value) => {
          if (failWrites) throw new Error('disk unavailable');
          encrypted = value;
        },
        clear: () => {
          throw new Error('disk unavailable');
        },
        readFailureMarker: () => failureMarker,
        quarantine: () => {
          failureMarker = true;
        },
        clearFailureMarker: () => {
          failureMarker = false;
        },
      },
      cipher: createAesGcmConsentCipher(Buffer.alloc(32, 9)),
    });
    const serverPermission = permission();
    store.grant(grantInput(serverPermission));
    failWrites = true;

    expect(() => store.revoke(serverPermission.permissionId, 'server_revoked')).toThrow(
      'LOCAL_CONSENT_PERSIST_FAILED',
    );
    expect(failureMarker).toBe(true);
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
    expect(() => store.grant(grantInput(serverPermission))).toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
    expect(() => store.revoke(serverPermission.permissionId, 'retry')).toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
    expect(() => store.clear('retry')).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    expect(() =>
      createDesktopConsentStore({
        persistence: {
          readEncrypted: () => encrypted,
          writeEncrypted: () => undefined,
          clear: () => undefined,
          readFailureMarker: () => failureMarker,
          quarantine: () => {
            failureMarker = true;
          },
          clearFailureMarker: () => {
            failureMarker = false;
          },
        },
        cipher: createAesGcmConsentCipher(Buffer.alloc(32, 9)),
      }),
    ).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
  });

  test('enters a fail-closed state when clearing encrypted consent fails', async () => {
    let encrypted: string | null = null;
    let failureMarker = false;
    let nonce = 0;
    const store = createDesktopConsentStore({
      now: () => START,
      nonce: () => `clear-failure-${++nonce}`,
      persistence: {
        readEncrypted: () => encrypted,
        writeEncrypted: (value) => {
          encrypted = value;
        },
        clear: () => {
          throw new Error('disk unavailable');
        },
        readFailureMarker: () => failureMarker,
        quarantine: () => {
          failureMarker = true;
        },
        clearFailureMarker: () => {
          failureMarker = false;
        },
      },
      cipher: createAesGcmConsentCipher(Buffer.alloc(32, 11)),
    });
    const serverPermission = permission();
    store.grant(grantInput(serverPermission));

    expect(() => store.clear('logout')).toThrow('LOCAL_CONSENT_PERSIST_FAILED');
    expect(failureMarker).toBe(true);
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
    expect(() =>
      createDesktopConsentStore({
        persistence: {
          readEncrypted: () => encrypted,
          writeEncrypted: () => undefined,
          clear: () => undefined,
          readFailureMarker: () => failureMarker,
          quarantine: () => {
            failureMarker = true;
          },
          clearFailureMarker: () => {
            failureMarker = false;
          },
        },
        cipher: createAesGcmConsentCipher(Buffer.alloc(32, 11)),
      }),
    ).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
  });

  test('persists a failure marker when encryption fails and blocks rehydration', async () => {
    let encrypted: string | null = null;
    let failureMarker = false;
    const persistence = {
      readEncrypted: () => encrypted,
      writeEncrypted: (value: string) => {
        encrypted = value;
      },
      clear: () => {
        encrypted = null;
      },
      readFailureMarker: () => failureMarker,
      quarantine: () => {
        failureMarker = true;
      },
      clearFailureMarker: () => {
        failureMarker = false;
      },
    };
    const failingCipher = {
      kind: 'authenticated' as const,
      encrypt: () => {
        throw new Error('key unavailable');
      },
      decrypt: () => {
        throw new Error('not expected');
      },
    };
    const serverPermission = permission();
    const store = createDesktopConsentStore({
      now: () => START,
      persistence,
      cipher: failingCipher,
    });

    expect(() => store.grant(grantInput(serverPermission))).toThrow(
      'LOCAL_CONSENT_ENCRYPTION_FAILED',
    );
    expect(failureMarker).toBe(true);
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
    expect(() => createDesktopConsentStore({ persistence, cipher: failingCipher })).toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
  });

  test('persists revoke state before an audit failure and blocks rehydration', () => {
    let encrypted: string | null = null;
    let failureMarker = false;
    let writes = 0;
    const persistence = {
      readEncrypted: () => encrypted,
      writeEncrypted: (value: string) => {
        writes += 1;
        encrypted = value;
      },
      clear: () => {
        encrypted = null;
      },
      readFailureMarker: () => failureMarker,
      quarantine: () => {
        failureMarker = true;
      },
      clearFailureMarker: () => {
        failureMarker = false;
      },
    };
    const serverPermission = permission();
    const store = createDesktopConsentStore({
      now: () => START,
      persistence,
      cipher: createAesGcmConsentCipher(Buffer.alloc(32, 13)),
      audit: {
        append: (event: { action?: string }) => {
          if (event.action === 'revoke') throw new Error('audit unavailable');
        },
      },
    });
    store.grant(grantInput(serverPermission));

    expect(() => store.revoke(serverPermission.permissionId, 'server_revoked')).toThrow(
      'LOCAL_CONSENT_AUDIT_FAILED',
    );
    expect(writes).toBe(2);
    expect(failureMarker).toBe(true);
    expect(() =>
      createDesktopConsentStore({
        persistence,
        cipher: createAesGcmConsentCipher(Buffer.alloc(32, 13)),
      }),
    ).toThrow('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
  });

  test('accepts atomic quarantine that removes stale encrypted consent', async () => {
    let encrypted: string | null = null;
    let failWrites = false;
    let clearCalls = 0;
    const persistence = {
      readEncrypted: () => encrypted,
      writeEncrypted: (value: string) => {
        if (failWrites) throw new Error('disk unavailable');
        encrypted = value;
      },
      clear: () => {
        clearCalls += 1;
        encrypted = null;
      },
      readFailureMarker: () => false,
      quarantine: () => {
        clearCalls += 1;
        encrypted = null;
      },
      clearFailureMarker: () => undefined,
    };
    const cipher = createAesGcmConsentCipher(Buffer.alloc(32, 15));
    const serverPermission = permission();
    const store = createDesktopConsentStore({ now: () => START, persistence, cipher });
    store.grant(grantInput(serverPermission));
    failWrites = true;

    expect(() => store.revoke(serverPermission.permissionId, 'server_revoked')).toThrow(
      'LOCAL_CONSENT_PERSIST_FAILED',
    );
    expect(clearCalls).toBe(1);
    expect(encrypted).toBeNull();
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );

    const recovered = createDesktopConsentStore({ now: () => START, persistence, cipher });
    await expect(recovered.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_MISSING',
    );
  });

  test('raises a fatal storage error when durable quarantine cannot be established', async () => {
    let encrypted: string | null = null;
    let failWrites = false;
    const fatalReasons: string[] = [];
    const persistence = {
      readEncrypted: () => encrypted,
      writeEncrypted: (value: string) => {
        if (failWrites) throw new Error('disk unavailable');
        encrypted = value;
      },
      clear: () => {
        throw new Error('disk unavailable');
      },
      readFailureMarker: () => false,
      quarantine: () => {
        throw new Error('marker unavailable');
      },
      clearFailureMarker: () => undefined,
    };
    const serverPermission = permission();
    const store = createDesktopConsentStore({
      now: () => START,
      persistence,
      cipher: createAesGcmConsentCipher(Buffer.alloc(32, 17)),
      onFatalStorageFailure: (reason: string) => fatalReasons.push(reason),
    });
    store.grant(grantInput(serverPermission));
    failWrites = true;

    expect(() => store.revoke(serverPermission.permissionId, 'server_revoked')).toThrow(
      'LOCAL_CONSENT_FATAL_STORAGE_FAILURE',
    );
    expect(fatalReasons).toEqual(['LOCAL_CONSENT_QUARANTINE_FAILED']);
    await expect(store.authorize(authorization(serverPermission))).rejects.toThrow(
      'LOCAL_CONSENT_STORAGE_UNAVAILABLE',
    );
  });

  test('rejects partial or standalone full-access grants', () => {
    const store = createDesktopConsentStore({ now: () => START });
    const serverPermission = permission();

    expect(() =>
      store.grant(
        grantInput(serverPermission, { consentKind: 'full_access', bundleId: 'bundle-1' }),
      ),
    ).toThrow('LOCAL_CONSENT_BUNDLE_REQUIRED');
    expect(() =>
      store.grantBundle([
        grantInput(serverPermission, { consentKind: 'full_access', bundleId: 'bundle-1' }),
      ]),
    ).toThrow('LOCAL_CONSENT_BUNDLE_INVALID');
  });
});
