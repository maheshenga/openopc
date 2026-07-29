const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTunnelProfileStore } = require('./tunnel-profile-store');

const PROFILE = {
  apiOrigin: 'https://app.example.test',
  tunnelId: 'tunnel-1',
  setupToken: 'setup-token-1234567890',
  userId: 'user-1',
  deviceId: 'device-1',
  accountId: 'account-1',
};

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => Buffer.from(value).toString('utf8').slice('encrypted:'.length),
  };
}

describe('Tunnel profile store', () => {
  test('round-trips a profile through safe storage without plaintext fallback', () => {
    const values = new Map();
    const store = createTunnelProfileStore({ safeStorage: fakeSafeStorage(), values });

    store.save(PROFILE);

    assert.deepEqual(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      PROFILE,
    );
    assert.equal([...values.values()][0].includes(PROFILE.setupToken), false);
  });

  test('rejects malformed profiles and refuses mismatched bindings', () => {
    const store = createTunnelProfileStore({ safeStorage: fakeSafeStorage(), values: new Map() });

    assert.throws(() => store.save({ ...PROFILE, apiOrigin: 'file:///tmp/app' }), {
      code: 'TUNNEL_PROFILE_ORIGIN_INVALID',
    });
    assert.throws(() => store.save({ ...PROFILE, setupToken: 'short' }), {
      code: 'TUNNEL_PROFILE_INVALID',
    });

    store.save(PROFILE);
    assert.equal(
      store.load({
        origin: 'https://other.example.test',
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      null,
    );
    assert.equal(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: 'other-user',
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      null,
    );
    assert.equal(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: 'other-device',
        accountId: PROFILE.accountId,
      }),
      null,
    );
    assert.equal(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: 'other-account',
      }),
      null,
    );
  });

  test('requires the complete origin, user, device, and account binding to load credentials', () => {
    const store = createTunnelProfileStore({ safeStorage: fakeSafeStorage(), values: new Map() });
    store.save(PROFILE);

    assert.throws(
      () => store.load({ origin: PROFILE.apiOrigin, userId: PROFILE.userId, deviceId: PROFILE.deviceId }),
      { code: 'TUNNEL_PROFILE_BINDING_REQUIRED' },
    );
    assert.throws(() => store.load({}), {
      code: 'TUNNEL_PROFILE_BINDING_REQUIRED',
    });
  });

  test('falls back to remote-only when secure storage is unavailable', () => {
    const values = new Map();
    const store = createTunnelProfileStore({
      values,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.from('must-not-run'),
        decryptString: () => 'must-not-run',
      },
    });

    assert.deepEqual(store.status(), { mode: 'remote_only' });
    assert.equal(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      null,
    );
    assert.throws(() => store.save(PROFILE), {
      code: 'TUNNEL_PROFILE_SECURE_STORAGE_UNAVAILABLE',
    });
    assert.equal(values.size, 0);
  });

  test('persists a fatal latch and clears it with credentials on unpair', () => {
    const values = new Map();
    const store = createTunnelProfileStore({ safeStorage: fakeSafeStorage(), values });

    store.save(PROFILE);
    store.setFatalLatch('LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.equal(store.getFatalLatch().reason, 'LOCAL_CONSENT_QUARANTINE_FAILED');
    assert.deepEqual(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      PROFILE,
    );

    store.clear();
    assert.equal(store.getFatalLatch(), null);
    assert.equal(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      null,
    );
    assert.equal(values.size, 0);
  });

  test('keeps the last committed credential when a disk write fails', () => {
    const values = new Map();
    let failWrites = false;
    const store = createTunnelProfileStore({
      safeStorage: fakeSafeStorage(),
      values,
      writeDisk: () => {
        if (failWrites) throw new Error('disk unavailable');
      },
    });

    store.save(PROFILE);
    failWrites = true;

    assert.throws(() => store.clear(), /disk unavailable/);
    assert.deepEqual(
      store.load({
        origin: PROFILE.apiOrigin,
        userId: PROFILE.userId,
        deviceId: PROFILE.deviceId,
        accountId: PROFILE.accountId,
      }),
      PROFILE,
    );
  });

  test('persists a non-secret fatal marker even if the encrypted envelope write fails', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openopc-tunnel-profile-'));
    const storagePath = path.join(directory, 'profile.json');
    let failWrites = false;
    const writeDisk = (entries) => {
      if (failWrites) throw new Error('encrypted store unavailable');
      fs.writeFileSync(storagePath, `${JSON.stringify(entries)}\n`, 'utf8');
    };
    try {
      const store = createTunnelProfileStore({
        safeStorage: fakeSafeStorage(),
        storagePath,
        writeDisk,
      });
      store.save(PROFILE);
      failWrites = true;

      assert.throws(
        () => store.setFatalLatch('LOCAL_CONSENT_QUARANTINE_FAILED'),
        /encrypted store unavailable/,
      );

      const restarted = createTunnelProfileStore({
        safeStorage: fakeSafeStorage(),
        storagePath,
      });
      assert.equal(
        restarted.getFatalLatch().reason,
        'LOCAL_CONSENT_QUARANTINE_FAILED',
      );
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
