const fs = require('node:fs');
const path = require('node:path');

const PROFILE_STORAGE_KEY = 'openopc.desktop-tunnel-profile.v1';
const PROFILE_ENVELOPE_VERSION = 1;
const FATAL_LATCH_VERSION = 1;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;

class TunnelProfileStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TunnelProfileStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TunnelProfileStoreError(code, message);
}

function normalizeOrigin(value, label = 'Tunnel profile') {
  if (typeof value !== 'string' || value.length > 2048) {
    fail('TUNNEL_PROFILE_ORIGIN_INVALID', `${label} origin is invalid`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('TUNNEL_PROFILE_ORIGIN_INVALID', `${label} origin is invalid`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password
  ) {
    fail('TUNNEL_PROFILE_ORIGIN_INVALID', `${label} origin is invalid`);
  }
  return parsed.origin;
}

function requiredId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    fail('TUNNEL_PROFILE_INVALID', `${label} is invalid`);
  }
  return value;
}

function optionalId(value, label) {
  if (value === undefined || value === null) return undefined;
  return requiredId(value, label);
}

function validateTunnelProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TUNNEL_PROFILE_INVALID', 'Tunnel profile is invalid');
  }
  const profile = {
    apiOrigin: normalizeOrigin(value.apiOrigin),
    tunnelId: requiredId(value.tunnelId, 'Tunnel id'),
    setupToken: value.setupToken,
    userId: requiredId(value.userId, 'User id'),
    deviceId: requiredId(value.deviceId, 'Device id'),
  };
  if (typeof profile.setupToken !== 'string' || !TOKEN_RE.test(profile.setupToken)) {
    fail('TUNNEL_PROFILE_INVALID', 'Setup token is invalid');
  }
  return Object.freeze({
    ...profile,
    accountId: requiredId(value.accountId, 'Account id'),
  });
}

function validateBinding(binding = {}) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    fail('TUNNEL_PROFILE_BINDING_INVALID', 'Tunnel profile binding is invalid');
  }
  if (
    binding.origin === undefined ||
    binding.userId === undefined ||
    binding.deviceId === undefined ||
    binding.accountId === undefined
  ) {
    fail(
      'TUNNEL_PROFILE_BINDING_REQUIRED',
      'Tunnel profile requires origin, user, device, and account binding',
    );
  }
  return {
    origin: normalizeOrigin(binding.origin, 'Configured app'),
    userId: requiredId(binding.userId, 'User id'),
    deviceId: requiredId(binding.deviceId, 'Device id'),
    accountId: requiredId(binding.accountId, 'Account id'),
  };
}

function createTunnelProfileStore(options = {}) {
  const safeStorage = options.safeStorage || null;
  const storagePath = options.storagePath || null;
  const storageKey = options.storageKey || PROFILE_STORAGE_KEY;
  const values = options.values || new Map();
  const writeDiskOverride = options.writeDisk;
  const fatalLatchPath =
    options.fatalLatchPath || (storagePath ? `${storagePath}.fatal` : null);
  const fatalLatchKey = `${storageKey}.fatal`;

  function secureStorageAvailable() {
    try {
      return Boolean(
        safeStorage &&
          typeof safeStorage.isEncryptionAvailable === 'function' &&
          typeof safeStorage.encryptString === 'function' &&
          typeof safeStorage.decryptString === 'function' &&
          safeStorage.isEncryptionAvailable(),
      );
    } catch {
      return false;
    }
  }

  function assertAvailable() {
    if (!secureStorageAvailable()) {
      fail(
        'TUNNEL_PROFILE_SECURE_STORAGE_UNAVAILABLE',
        'Secure credential storage is unavailable',
      );
    }
  }

  function readDisk() {
    if (!storagePath) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(storagePath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeDisk(entries) {
    if (typeof writeDiskOverride === 'function') {
      writeDiskOverride(entries);
      return;
    }
    if (!storagePath) return;
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    const temporary = `${storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(entries)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, storagePath);
  }

  function readEncoded() {
    if (values.has(storageKey)) return values.get(storageKey);
    return readDisk()[storageKey] ?? null;
  }

  function writeEncoded(encoded) {
    const entries = readDisk();
    entries[storageKey] = encoded;
    writeDisk(entries);
    values.set(storageKey, encoded);
  }

  function deleteEncoded() {
    const entries = readDisk();
    delete entries[storageKey];
    writeDisk(entries);
    values.delete(storageKey);
  }

  function validateFatalLatch(value) {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      value.version !== FATAL_LATCH_VERSION ||
      typeof value.reason !== 'string' ||
      !ID_RE.test(value.reason) ||
      typeof value.latchedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.latchedAt))
    ) {
      fail('TUNNEL_PROFILE_FATAL_LATCH_CORRUPT', 'Fatal latch marker is invalid');
    }
    return Object.freeze({ reason: value.reason, latchedAt: value.latchedAt });
  }

  function readFatalMarker() {
    const cached = values.get(fatalLatchKey);
    if (cached !== undefined) return validateFatalLatch(cached);
    if (!fatalLatchPath) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(fatalLatchPath, 'utf8'));
      const latch = validateFatalLatch(parsed);
      values.set(fatalLatchKey, { version: FATAL_LATCH_VERSION, ...latch });
      return latch;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof TunnelProfileStoreError) throw error;
      fail('TUNNEL_PROFILE_FATAL_LATCH_CORRUPT', 'Fatal latch marker could not be read');
    }
  }

  function writeFatalMarker(reason) {
    const marker = {
      version: FATAL_LATCH_VERSION,
      reason,
      latchedAt: new Date().toISOString(),
    };
    if (fatalLatchPath) {
      fs.mkdirSync(path.dirname(fatalLatchPath), { recursive: true });
      const temporary = `${fatalLatchPath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(marker)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.renameSync(temporary, fatalLatchPath);
    }
    values.set(fatalLatchKey, marker);
    return Object.freeze({ reason: marker.reason, latchedAt: marker.latchedAt });
  }

  function deleteFatalMarker() {
    if (fatalLatchPath) {
      try {
        fs.unlinkSync(fatalLatchPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    values.delete(fatalLatchKey);
  }

  function encryptEnvelope(envelope) {
    assertAvailable();
    try {
      return Buffer.from(safeStorage.encryptString(JSON.stringify(envelope))).toString('base64');
    } catch {
      fail('TUNNEL_PROFILE_ENCRYPT_FAILED', 'Tunnel credentials could not be encrypted');
    }
  }

  function decryptEnvelope(encoded) {
    assertAvailable();
    try {
      const plaintext = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      const parsed = JSON.parse(plaintext);
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        parsed.version !== PROFILE_ENVELOPE_VERSION
      ) {
        throw new Error('invalid envelope');
      }
      return parsed;
    } catch {
      fail('TUNNEL_PROFILE_CORRUPT', 'Tunnel credentials could not be decrypted');
    }
  }

  function readEnvelope() {
    const encoded = readEncoded();
    if (encoded === null || encoded === undefined) return null;
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > 2_000_000) {
      fail('TUNNEL_PROFILE_CORRUPT', 'Tunnel credentials are invalid');
    }
    return decryptEnvelope(encoded);
  }

  function save(profile) {
    const validated = validateTunnelProfile(profile);
    writeEncoded(
      encryptEnvelope({
        version: PROFILE_ENVELOPE_VERSION,
        profile: validated,
        fatalLatch: null,
      }),
    );
    return validated;
  }

  function load(binding = {}) {
    if (!secureStorageAvailable()) return null;
    const envelope = readEnvelope();
    if (!envelope?.profile) return null;
    const profile = validateTunnelProfile(envelope.profile);
    const expected = validateBinding(binding);
    if (
      (expected.origin !== undefined && profile.apiOrigin !== expected.origin) ||
      (expected.userId !== undefined && profile.userId !== expected.userId) ||
      (expected.deviceId !== undefined && profile.deviceId !== expected.deviceId) ||
      (expected.accountId !== undefined && profile.accountId !== expected.accountId)
    ) {
      return null;
    }
    return profile;
  }

  function setFatalLatch(reason) {
    if (typeof reason !== 'string' || !ID_RE.test(reason)) {
      fail('TUNNEL_PROFILE_FATAL_LATCH_INVALID', 'Fatal latch reason is invalid');
    }
    writeFatalMarker(reason);
    const envelope = readEnvelope();
    writeEncoded(
      encryptEnvelope({
        version: PROFILE_ENVELOPE_VERSION,
        profile: envelope?.profile ? validateTunnelProfile(envelope.profile) : null,
        fatalLatch: { reason, latchedAt: new Date().toISOString() },
      }),
    );
  }

  function getFatalLatch() {
    const marker = readFatalMarker();
    if (marker) return marker;
    if (!secureStorageAvailable()) return null;
    const latch = readEnvelope()?.fatalLatch;
    if (
      !latch ||
      typeof latch !== 'object' ||
      typeof latch.reason !== 'string' ||
      typeof latch.latchedAt !== 'string'
    ) {
      return null;
    }
    return Object.freeze({ reason: latch.reason, latchedAt: latch.latchedAt });
  }

  function clear() {
    deleteEncoded();
    deleteFatalMarker();
  }

  return Object.freeze({
    save,
    load,
    clear,
    delete: clear,
    forgetCredentials: clear,
    invalidate: clear,
    setFatalLatch,
    getFatalLatch,
    secureStorageAvailable,
    status: () => ({ mode: secureStorageAvailable() ? 'secure' : 'remote_only' }),
  });
}

module.exports = {
  PROFILE_ENVELOPE_VERSION,
  PROFILE_STORAGE_KEY,
  TunnelProfileStoreError,
  createTunnelProfileStore,
  normalizeOrigin,
  validateTunnelProfile,
};
