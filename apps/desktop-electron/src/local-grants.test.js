const { describe, expect, test } = require('bun:test');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const {
  canonicalizeGrantCommand,
  canonicalizeGrantRequest,
  createNativeConfirmation,
  createLocalGrantController,
  createElectronKeychainStore,
  LocalGrantStore,
  normalizeRoot,
  requestLocalGrant,
} = require('./local-grants');

function signedCommand(overrides = {}) {
  const request = {
    grantId: 'grant-1',
    capability: 'filesystem',
    roots: ['C:/workspace'],
    userId: 'user-1',
    deviceId: 'device-1',
    nonce: 'nonce-1',
    issuedAt: '2026-07-29T00:00:00.000Z',
    expiresAt: '2026-07-29T00:30:00.000Z',
    executionMode: 'foreground',
    ...overrides,
  };
  const commandDigest = `sha256:${createHash('sha256')
    .update(canonicalizeGrantRequest(request))
    .digest('hex')}`;
  const command = { ...request, commandDigest };
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    command: {
      ...command,
      signature: sign(null, Buffer.from(canonicalizeGrantCommand(command)), privateKey).toString(
        'base64url',
      ),
    },
    publicKey,
  };
}

describe('local grants', () => {
  test('rejects full access when no native confirmation is supplied', async () => {
    await expect(
      requestLocalGrant({
        command: {
          grantId: 'grant-1',
          capability: 'full_access',
          roots: ['C:/workspace'],
          userId: 'user-1',
          deviceId: 'device-1',
          nonce: 'nonce-1',
          issuedAt: '2026-07-29T00:00:00.000Z',
          expiresAt: '2026-07-29T00:30:00.000Z',
          commandDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          signature: 'invalid',
        },
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_CONFIRMATION_REQUIRED' });
  });

  test('issues a locally approved grant after verifying the paired device signature', async () => {
    const { command, publicKey } = signedCommand();
    const grant = await requestLocalGrant({
      command,
      publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    });

    expect(grant).toMatchObject({
      grantId: 'grant-1',
      capability: 'filesystem',
      roots: ['C:/workspace'],
      approvedLocally: true,
      commandDigest: command.commandDigest,
    });
  });

  test('does not treat a renderer callback as native full-access confirmation', async () => {
    const { command, publicKey } = signedCommand({
      capability: 'full_access',
      grantId: 'grant-full',
      nonce: 'nonce-full',
    });
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => true,
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_NATIVE_CONFIRMATION_REQUIRED' });
  });

  test('keeps the preload surface limited to the three local-grant operations', () => {
    const preload = readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    expect(preload).toContain('requestLocalGrant');
    expect(preload).toContain('listLocalGrants');
    expect(preload).toContain('revokeLocalGrant');
    expect(preload).not.toContain('readFile');
    expect(preload).not.toContain('writeFile');
    expect(preload).not.toContain('executeJavaScript');
  });

  test('caps full-access grants at one hour even after local approval', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-too-long',
      nonce: 'nonce-too-long',
      capability: 'full_access',
      expiresAt: '2026-07-29T02:00:00.000Z',
    });
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        nativeConfirmation: createNativeConfirmation(),
        confirm: async () => true,
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_FULL_ACCESS_TOO_LONG' });
  });

  test('consumes a signed nonce before allowing a second grant request', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-replay',
      nonce: 'nonce-replay',
    });
    const controller = createLocalGrantController();
    const input = {
      command,
      publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    };
    await controller.requestLocalGrant(input);
    await expect(controller.requestLocalGrant(input)).rejects.toMatchObject({
      code: 'LOCAL_GRANT_REPLAYED',
    });
  });

  test('rejects a correctly signed command bound to another user or device', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-wrong-binding',
      nonce: 'nonce-wrong-binding',
      userId: 'user-a',
      deviceId: 'device-a',
    });
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-b',
        expectedDeviceId: 'device-a',
        confirm: async () => true,
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_WRONG_USER' });
  });

  test('rejects an execution command that broadens the approved roots', async () => {
    const controller = createLocalGrantController();
    const grantKeys = signedCommand({
      grantId: 'grant-root-fence',
      nonce: 'nonce-root-fence',
      roots: ['C:/workspace'],
    });
    await controller.requestLocalGrant({
      command: grantKeys.command,
      publicKey: grantKeys.publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    });

    const execution = signedCommand({
      grantId: 'grant-root-fence',
      nonce: 'execution-root-fence',
      roots: ['C:/other'],
    });
    await expect(
      controller.authorizeLocalCommand({
        command: execution.command,
        publicKey: execution.publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        now: new Date('2026-07-29T00:02:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_ROOT_ESCALATION' });
  });

  test('rejects an invalid signature before showing native confirmation', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-bad-signature',
      nonce: 'nonce-bad-signature',
    });
    let confirmations = 0;
    await expect(
      requestLocalGrant({
        command: { ...command, signature: 'A'.repeat(86) },
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => {
          confirmations += 1;
          return true;
        },
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_SIGNATURE_INVALID' });
    expect(confirmations).toBe(0);
  });

  test('rejects background-only commands even when their signature is valid', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-background',
      nonce: 'nonce-background',
      executionMode: 'background',
    });
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => true,
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_BACKGROUND_ONLY' });
  });

  test('persists visible grant state and appends issue/revoke audit records', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-local-grants-'));
    const store = new LocalGrantStore({
      storagePath: path.join(directory, 'grants.json'),
      auditPath: path.join(directory, 'audit.jsonl'),
    });
    const controller = createLocalGrantController({ store });
    const { command, publicKey } = signedCommand({
      grantId: 'grant-audited',
      nonce: 'nonce-audited',
    });
    await controller.requestLocalGrant({
      command,
      publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    });
    expect(controller.listLocalGrants()[0]?.approvedLocally).toBe(true);

    await controller.revokeLocalGrant({
      grantId: 'grant-audited',
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      reason: 'test revoke',
    });
    expect(controller.listLocalGrants()[0]?.revokedAt).toBeTruthy();
    const auditLines = readFileSync(path.join(directory, 'audit.jsonl'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    expect(auditLines.map((entry) => entry.action)).toEqual(['grant_issued', 'grant_revoked']);
  });

  test('stores local secrets through the OS keychain adapter', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-keychain-'));
    const values = new Map();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
      decryptString: (value) => Buffer.from(value).toString('utf8').slice('encrypted:'.length),
    };
    const keychain = createElectronKeychainStore({
      storagePath: path.join(directory, 'keychain.json'),
      safeStorage,
      values,
    });

    keychain.set('paired-device-private-key', 'secret-value');
    expect(keychain.get('paired-device-private-key')).toBe('secret-value');
    keychain.delete('paired-device-private-key');
    expect(keychain.get('paired-device-private-key')).toBeNull();
  });

  test('fails closed when the verifier clock input is invalid', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-invalid-clock',
      nonce: 'nonce-invalid-clock',
    });
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => true,
        now: 'not-a-date',
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_CLOCK_INVALID' });
  });

  test('does not surface malformed persisted grants as active local access', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-corrupt-grants-'));
    const storagePath = path.join(directory, 'grants.json');
    writeFileSync(
      storagePath,
      JSON.stringify([
        {
          grantId: 'corrupt',
          capability: 'full_access',
          roots: ['/'],
          approvedLocally: true,
        },
      ]),
    );
    const store = new LocalGrantStore({ storagePath });
    expect(store.list()).toEqual([]);
  });

  test('rejects a signed grant after its expiry without prompting the user', async () => {
    const { command, publicKey } = signedCommand({
      grantId: 'grant-expired',
      nonce: 'nonce-expired',
      expiresAt: '2026-07-29T00:02:00.000Z',
    });
    let confirmations = 0;
    await expect(
      requestLocalGrant({
        command,
        publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => {
          confirmations += 1;
          return true;
        },
        now: new Date('2026-07-29T00:03:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_EXPIRED' });
    expect(confirmations).toBe(0);
  });

  test('rejects Windows drive roots after parent traversal', () => {
    expect(() => normalizeRoot('C:/workspace/..')).toThrow(/filesystem root cannot be granted/i);
    expect(() => normalizeRoot('C:/')).toThrow(/filesystem root cannot be granted/i);
  });

  test('does not replay an execution nonce after the grant store is recreated', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-local-grants-replay-'));
    const storagePath = path.join(directory, 'grants.json');
    const auditPath = path.join(directory, 'audit.jsonl');
    const issuedAt = Date.now() + 60_000;
    const expiresAt = issuedAt + 30 * 60_000;
    const grantKeys = signedCommand({
      grantId: 'grant-restart-replay',
      nonce: 'grant-restart-replay',
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    const first = createLocalGrantController({
      store: new LocalGrantStore({ storagePath, auditPath }),
    });
    await first.requestLocalGrant({
      command: grantKeys.command,
      publicKey: grantKeys.publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date(issuedAt + 60_000),
    });

    const execution = signedCommand({
      grantId: 'grant-restart-replay',
      nonce: 'execution-restart-replay',
      issuedAt: new Date(issuedAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString(),
    });
    await first.authorizeLocalCommand({
      command: execution.command,
      publicKey: execution.publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      now: new Date(issuedAt + 2 * 60_000),
    });

    const afterRestart = createLocalGrantController({
      store: new LocalGrantStore({ storagePath, auditPath }),
    });
    await expect(
      afterRestart.authorizeLocalCommand({
        command: execution.command,
        publicKey: execution.publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        now: new Date(issuedAt + 2 * 60_000),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_REPLAYED' });
  });

  test('reloads append-only audit history when the grant store is recreated', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-local-grants-audit-'));
    const storagePath = path.join(directory, 'grants.json');
    const auditPath = path.join(directory, 'audit.jsonl');
    const keys = signedCommand({ grantId: 'grant-audit-reload', nonce: 'grant-audit-reload' });
    const controller = createLocalGrantController({
      store: new LocalGrantStore({ storagePath, auditPath }),
    });
    await controller.requestLocalGrant({
      command: keys.command,
      publicKey: keys.publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    });
    const restarted = new LocalGrantStore({ storagePath, auditPath });
    expect(restarted.auditRecords().map((entry) => entry.action)).toEqual(['grant_issued']);
  });

  test('does not leave a grant persisted when its audit record cannot be written', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'openopc-local-grants-audit-fail-'));
    const storagePath = path.join(directory, 'grants.json');
    const auditPath = directory;
    const keys = signedCommand({ grantId: 'grant-audit-fail', nonce: 'grant-audit-fail' });
    const controller = createLocalGrantController({
      store: new LocalGrantStore({ storagePath, auditPath }),
    });
    await expect(
      controller.requestLocalGrant({
        command: keys.command,
        publicKey: keys.publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        confirm: async () => true,
        now: new Date('2026-07-29T00:01:00.000Z'),
      }),
    ).rejects.toThrow();
    expect(new LocalGrantStore({ storagePath }).list()).toEqual([]);
  });

  test('revalidates resolved filesystem paths before authorizing execution', async () => {
    const resolveRoot = (root) => (root === 'C:/workspace/link' ? 'D:/outside' : root);
    const controller = createLocalGrantController({ resolveRoot });
    const grant = signedCommand({
      grantId: 'grant-resolved-root',
      nonce: 'grant-resolved-root',
      roots: ['C:/workspace'],
    });
    await controller.requestLocalGrant({
      command: grant.command,
      publicKey: grant.publicKey,
      expectedUserId: 'user-1',
      expectedDeviceId: 'device-1',
      confirm: async () => true,
      now: new Date('2026-07-29T00:01:00.000Z'),
    });
    const execution = signedCommand({
      grantId: 'grant-resolved-root',
      nonce: 'execution-resolved-root',
      roots: ['C:/workspace/link'],
    });
    await expect(
      controller.authorizeLocalCommand({
        command: execution.command,
        publicKey: execution.publicKey,
        expectedUserId: 'user-1',
        expectedDeviceId: 'device-1',
        now: new Date('2026-07-29T00:02:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'LOCAL_GRANT_ROOT_ESCALATION' });
  });
});
