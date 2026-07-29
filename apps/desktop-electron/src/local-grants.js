const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } = require('node:crypto');

const CAPABILITIES = Object.freeze([
  'filesystem',
  'app_connector',
  'desktop_automation',
  'local_execution',
  'full_access',
]);
const CAPABILITY_SET = new Set(CAPABILITIES);
const FULL_ACCESS_MAX_AGE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const NATIVE_CONFIRMATION = Symbol('openopc-native-confirmation');

function createNativeConfirmation() {
  return Object.freeze({ [NATIVE_CONFIRMATION]: true });
}

function isNativeConfirmation(value) {
  return Boolean(value && value[NATIVE_CONFIRMATION] === true);
}

class LocalGrantError extends Error {
  constructor(code, message = code, details) {
    super(message);
    this.name = 'LocalGrantError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function createElectronKeychainStore(options = {}) {
  let safeStorage = options.safeStorage;
  if (!safeStorage) {
    try {
      safeStorage = require('electron').safeStorage;
    } catch {
      safeStorage = null;
    }
  }
  const storagePath = options.storagePath || null;
  const values = options.values || new Map();

  function assertAvailable() {
    if (
      !safeStorage ||
      typeof safeStorage.isEncryptionAvailable !== 'function' ||
      !safeStorage.isEncryptionAvailable()
    ) {
      throwGrant(
        'LOCAL_GRANT_KEYCHAIN_UNAVAILABLE',
        'The operating-system keychain is unavailable',
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
    if (!storagePath) return;
    fs.mkdirSync(path.dirname(storagePath), { recursive: true });
    const temporary = `${storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, storagePath);
  }

  function validateKey(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      throwGrant('LOCAL_GRANT_KEY_INVALID', 'The keychain key is invalid');
    }
  }

  return {
    get(key) {
      validateKey(key);
      assertAvailable();
      const encoded = values.has(key) ? values.get(key) : readDisk()[key];
      if (typeof encoded !== 'string') return null;
      try {
        return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        throwGrant('LOCAL_GRANT_KEYCHAIN_CORRUPT', 'The keychain entry could not be decrypted');
      }
    },
    set(key, value) {
      validateKey(key);
      assertAvailable();
      if (typeof value !== 'string' || value.length > 1_000_000) {
        throwGrant('LOCAL_GRANT_SECRET_INVALID', 'The keychain value is invalid');
      }
      const encrypted = safeStorage.encryptString(value).toString('base64');
      values.set(key, encrypted);
      const entries = readDisk();
      entries[key] = encrypted;
      writeDisk(entries);
    },
    delete(key) {
      validateKey(key);
      assertAvailable();
      values.delete(key);
      const entries = readDisk();
      delete entries[key];
      writeDisk(entries);
    },
  };
}

function throwGrant(code, message, details) {
  throw new LocalGrantError(code, message, details);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) output[key] = stableValue(value[key]);
    }
    return output;
  }
  return value;
}

function canonicalize(value) {
  return JSON.stringify(stableValue(value));
}

function withoutSignature(command) {
  if (!command || typeof command !== 'object') return command;
  const { signature: _signature, ...payload } = command;
  return payload;
}

function withoutDigestAndSignature(command) {
  if (!command || typeof command !== 'object') return command;
  const { signature: _signature, commandDigest: _commandDigest, ...payload } = command;
  return payload;
}

function canonicalizeGrantRequest(command) {
  return canonicalize(withoutDigestAndSignature(command));
}

function canonicalizeGrantCommand(command) {
  return canonicalize(withoutSignature(command));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/\//.test(value);
}

function normalizeRoot(value) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throwGrant('LOCAL_GRANT_ROOT_INVALID', 'A local grant root is invalid');
  }
  const raw = value.trim();
  if (/^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(raw)) {
    throwGrant('LOCAL_GRANT_ROOT_INVALID', 'Device namespace paths cannot be granted');
  }
  if (isWindowsPath(raw)) {
    const normalizedWindows = path.win32.normalize(raw.replace(/\//g, '\\'));
    if (!path.win32.isAbsolute(normalizedWindows)) {
      throwGrant('LOCAL_GRANT_ROOT_INVALID', 'Grant roots must be absolute paths');
    }
    const windowsRoot = path.win32.parse(normalizedWindows).root;
    if (!windowsRoot || normalizedWindows.toLowerCase() === windowsRoot.toLowerCase()) {
      throwGrant('LOCAL_GRANT_ROOT_TOO_BROAD', 'A filesystem root cannot be granted');
    }
    return normalizedWindows.replace(/[\\]+$/, '').replace(/\\/g, '/');
  }
  const normalized = path.posix.normalize(raw.replace(/\\/g, '/'));
  if (!path.posix.isAbsolute(normalized)) {
    throwGrant('LOCAL_GRANT_ROOT_INVALID', 'Grant roots must be absolute paths');
  }
  const result = normalized.replace(/\/+$/, '') || '/';
  if (result === '/') {
    throwGrant('LOCAL_GRANT_ROOT_TOO_BROAD', 'A filesystem root cannot be granted');
  }
  return result;
}

function rootKey(value) {
  return isWindowsPath(value) ? value.toLowerCase() : value;
}

function isWithinRoot(candidate, root) {
  const candidateKey = rootKey(normalizeRoot(candidate));
  const rootKeyValue = rootKey(normalizeRoot(root));
  return candidateKey === rootKeyValue || candidateKey.startsWith(`${rootKeyValue}/`);
}

function decodeSignature(value) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096) {
    throwGrant('LOCAL_GRANT_SIGNATURE_INVALID', 'The local command signature is invalid');
  }
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const bytes = Buffer.from(padded, 'base64');
    if (bytes.length === 0) throw new Error('empty signature');
    return bytes;
  } catch {
    throwGrant('LOCAL_GRANT_SIGNATURE_INVALID', 'The local command signature is invalid');
  }
}

function parseDate(value, code) {
  if (typeof value !== 'string') throwGrant(code, 'A grant timestamp is invalid');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throwGrant(code, 'A grant timestamp is invalid');
  return time;
}

function resolveNow(value, fallback) {
  const candidate = value === undefined ? fallback() : value;
  const date = candidate instanceof Date ? candidate : new Date(candidate);
  if (!Number.isFinite(date.getTime())) {
    throwGrant('LOCAL_GRANT_CLOCK_INVALID', 'The local verifier clock is invalid');
  }
  return date;
}

function validateId(value, code) {
  if (typeof value !== 'string' || !ID_RE.test(value))
    throwGrant(code, 'A grant identifier is invalid');
  return value;
}

function validateCommandShape(command, now) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throwGrant('LOCAL_GRANT_COMMAND_INVALID', 'The local grant command is invalid');
  }
  validateId(command.grantId, 'LOCAL_GRANT_ID_INVALID');
  validateId(command.userId, 'LOCAL_GRANT_USER_INVALID');
  validateId(command.deviceId, 'LOCAL_GRANT_DEVICE_INVALID');
  validateId(command.nonce, 'LOCAL_GRANT_NONCE_INVALID');
  if (!CAPABILITY_SET.has(command.capability)) {
    throwGrant('LOCAL_GRANT_CAPABILITY_INVALID', 'The requested capability is invalid');
  }
  if (!Array.isArray(command.roots) || command.roots.length === 0 || command.roots.length > 64) {
    throwGrant('LOCAL_GRANT_ROOT_INVALID', 'A grant must contain between one and 64 roots');
  }
  const roots = [...new Set(command.roots.map(normalizeRoot))].sort((a, b) =>
    rootKey(a).localeCompare(rootKey(b)),
  );
  const issuedAt = parseDate(command.issuedAt, 'LOCAL_GRANT_TIMESTAMP_INVALID');
  const expiresAt = parseDate(command.expiresAt, 'LOCAL_GRANT_TIMESTAMP_INVALID');
  if (expiresAt <= issuedAt)
    throwGrant('LOCAL_GRANT_TIMESTAMP_INVALID', 'Grant expiry must be after issuance');
  if (issuedAt > now + MAX_CLOCK_SKEW_MS) {
    throwGrant('LOCAL_GRANT_NOT_YET_VALID', 'The grant is issued too far in the future');
  }
  if (expiresAt <= now) throwGrant('LOCAL_GRANT_EXPIRED', 'The local grant has expired');
  const maxAge = command.capability === 'full_access' ? FULL_ACCESS_MAX_AGE_MS : DEFAULT_MAX_AGE_MS;
  if (expiresAt - issuedAt > maxAge) {
    throwGrant(
      command.capability === 'full_access'
        ? 'LOCAL_GRANT_FULL_ACCESS_TOO_LONG'
        : 'LOCAL_GRANT_EXPIRY_TOO_LONG',
      'The requested grant lifetime exceeds the local policy',
    );
  }
  if (command.executionMode !== 'foreground') {
    throwGrant('LOCAL_GRANT_BACKGROUND_ONLY', 'Local grants require a foreground user action');
  }
  if (!DIGEST_RE.test(command.commandDigest || '')) {
    throwGrant('LOCAL_GRANT_DIGEST_INVALID', 'The local command digest is invalid');
  }
  if (typeof command.signature !== 'string') {
    throwGrant('LOCAL_GRANT_SIGNATURE_INVALID', 'The local command signature is invalid');
  }
  return {
    ...command,
    roots,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

function isPersistedGrant(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    validateId(value.grantId, 'LOCAL_GRANT_ID_INVALID');
    validateId(value.userId, 'LOCAL_GRANT_USER_INVALID');
    validateId(value.deviceId, 'LOCAL_GRANT_DEVICE_INVALID');
    if (!CAPABILITY_SET.has(value.capability) || value.approvedLocally !== true) return false;
    if (!Array.isArray(value.roots) || value.roots.length === 0 || value.roots.length > 64)
      return false;
    const roots = [...new Set(value.roots.map(normalizeRoot))];
    if (roots.length !== value.roots.length) return false;
    const issuedAt = parseDate(value.issuedAt, 'LOCAL_GRANT_TIMESTAMP_INVALID');
    const expiresAt = parseDate(value.expiresAt, 'LOCAL_GRANT_TIMESTAMP_INVALID');
    if (expiresAt <= issuedAt) return false;
    const maxAge = value.capability === 'full_access' ? FULL_ACCESS_MAX_AGE_MS : DEFAULT_MAX_AGE_MS;
    if (expiresAt - issuedAt > maxAge || !DIGEST_RE.test(value.commandDigest || '')) return false;
    if (value.revokedAt !== null && value.revokedAt !== undefined) {
      parseDate(value.revokedAt, 'LOCAL_GRANT_TIMESTAMP_INVALID');
    }
    return true;
  } catch {
    return false;
  }
}

function verifySignedCommand(command, publicKey) {
  if (!publicKey) throwGrant('LOCAL_GRANT_DEVICE_KEY_REQUIRED', 'A paired device key is required');
  const expectedDigest = digest(canonicalizeGrantRequest(command));
  const expectedBytes = Buffer.from(expectedDigest);
  const receivedBytes = Buffer.from(command.commandDigest || '');
  if (
    expectedBytes.length !== receivedBytes.length ||
    !timingSafeEqual(expectedBytes, receivedBytes)
  ) {
    throwGrant('LOCAL_GRANT_DIGEST_MISMATCH', 'The signed command digest does not match');
  }
  let key;
  try {
    key = publicKey && publicKey.type === 'public' ? publicKey : createPublicKey(publicKey);
  } catch {
    throwGrant('LOCAL_GRANT_DEVICE_KEY_INVALID', 'The paired device key is invalid');
  }
  const valid = verify(
    null,
    Buffer.from(canonicalizeGrantCommand(command)),
    key,
    decodeSignature(command.signature),
  );
  if (!valid) throwGrant('LOCAL_GRANT_SIGNATURE_INVALID', 'The local command signature is invalid');
  return true;
}

class MemoryNonceStore {
  constructor() {
    this.entries = new Map();
  }

  consume(nonce, expiresAt, now) {
    for (const [key, expiry] of this.entries) {
      if (expiry <= now) this.entries.delete(key);
    }
    if (this.entries.has(nonce)) return false;
    this.entries.set(nonce, expiresAt);
    return true;
  }
}

class LocalGrantStore {
  constructor(options = {}) {
    this.storagePath = options.storagePath || null;
    this.auditPath = options.auditPath || null;
    this.grants = new Map();
    this.audit = [];
    this.nonceStore = options.nonceStore || null;
    this.nonces = this.nonceStore || new MemoryNonceStore();
    this.consumedNonces = new Map();
    this.load();
    this.loadAudit();
  }

  load() {
    if (!this.storagePath) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.storagePath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const grant of parsed) {
          if (isPersistedGrant(grant)) this.grants.set(grant.grantId, grant);
        }
        return;
      }
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return;
      if (Array.isArray(parsed.grants)) {
        for (const grant of parsed.grants) {
          if (isPersistedGrant(grant)) this.grants.set(grant.grantId, grant);
        }
      }
      if (Array.isArray(parsed.consumedNonces)) {
        for (const entry of parsed.consumedNonces) {
          if (
            entry &&
            typeof entry.key === 'string' &&
            entry.key.length <= 512 &&
            Number.isFinite(entry.expiresAt) &&
            entry.expiresAt > Date.now()
          ) {
            this.consumedNonces.set(entry.key, entry.expiresAt);
          }
        }
      }
    } catch {
      // Missing or corrupt local state fails closed by starting empty.
    }
  }

  loadAudit() {
    if (!this.auditPath) return;
    try {
      const contents = fs.readFileSync(this.auditPath, 'utf8');
      for (const line of contents.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (
            record &&
            typeof record === 'object' &&
            typeof record.auditId === 'string' &&
            typeof record.action === 'string' &&
            typeof record.recordedAt === 'string'
          ) {
            this.audit.push(Object.freeze(record));
          }
        } catch {
          // Ignore an incomplete/corrupt trailing audit line.
        }
      }
    } catch {
      // Missing audit history is equivalent to an empty history.
    }
  }

  stateValue(grants = this.grants, consumedNonces = this.consumedNonces) {
    return {
      version: 1,
      grants: [...grants.values()],
      consumedNonces: [...consumedNonces.entries()].map(([key, expiresAt]) => ({ key, expiresAt })),
    };
  }

  writeState(grants = this.grants, consumedNonces = this.consumedNonces) {
    if (!this.storagePath) return null;
    fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.stateValue(grants, consumedNonces))}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return temporary;
  }

  persist() {
    const temporary = this.writeState();
    if (!temporary) return;
    try {
      fs.renameSync(temporary, this.storagePath);
    } catch (error) {
      try {
        fs.rmSync(temporary, { force: true });
      } catch {
        // Best effort cleanup; the state remains unchanged in memory.
      }
      throw error;
    }
  }

  createAuditRecord(event) {
    return Object.freeze({
      auditId: randomUUID(),
      recordedAt: new Date().toISOString(),
      ...event,
    });
  }

  writeAuditRecord(record) {
    if (!this.auditPath) return;
    fs.mkdirSync(path.dirname(this.auditPath), { recursive: true });
    fs.appendFileSync(this.auditPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  appendAudit(event) {
    const record = this.createAuditRecord(event);
    this.writeAuditRecord(record);
    this.audit.push(record);
    return record;
  }

  commitMutation(grants, consumedNonces, auditEvent) {
    const record = auditEvent ? this.createAuditRecord(auditEvent) : null;
    const temporary = this.writeState(grants, consumedNonces);
    try {
      if (record) this.writeAuditRecord(record);
      if (temporary) fs.renameSync(temporary, this.storagePath);
    } catch (error) {
      if (temporary) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // Best effort cleanup; never expose a partially committed grant.
        }
      }
      throw error;
    }
    this.grants = grants;
    this.consumedNonces = consumedNonces;
    if (record) this.audit.push(record);
  }

  get(grantId) {
    return this.grants.get(grantId) || null;
  }

  put(grant) {
    if (!isPersistedGrant(grant)) {
      throwGrant('LOCAL_GRANT_STATE_INVALID', 'The local grant state is invalid');
    }
    if (this.grants.has(grant.grantId)) {
      throwGrant('LOCAL_GRANT_REPLAYED', 'The grant has already been issued');
    }
    const nextGrants = new Map(this.grants);
    nextGrants.set(grant.grantId, grant);
    this.commitMutation(nextGrants, new Map(this.consumedNonces), {
      action: 'grant_issued',
      grantId: grant.grantId,
      userId: grant.userId,
      deviceId: grant.deviceId,
    });
    return grant;
  }

  consumeNonce(nonce, expiresAt, now) {
    if (this.nonceStore) return this.nonceStore.consume(nonce, expiresAt, now);
    const nextNonces = new Map(this.consumedNonces);
    for (const [key, expiry] of nextNonces) {
      if (expiry <= now) nextNonces.delete(key);
    }
    if (nextNonces.has(nonce)) return false;
    nextNonces.set(nonce, expiresAt);
    this.commitMutation(new Map(this.grants), nextNonces, null);
    return true;
  }

  list() {
    return [...this.grants.values()].map((grant) => ({ ...grant, roots: [...grant.roots] }));
  }

  revoke(grantId, context = {}) {
    const current = this.grants.get(grantId);
    if (!current) throwGrant('LOCAL_GRANT_NOT_FOUND', 'The local grant was not found');
    if (current.revokedAt) return { ...current, roots: [...current.roots] };
    const revoked = { ...current, revokedAt: context.revokedAt || new Date().toISOString() };
    const nextGrants = new Map(this.grants);
    nextGrants.set(grantId, revoked);
    this.commitMutation(nextGrants, new Map(this.consumedNonces), {
      action: 'grant_revoked',
      grantId,
      userId: current.userId,
      deviceId: current.deviceId,
      reason: context.reason || 'user_revoked',
    });
    return { ...revoked, roots: [...revoked.roots] };
  }

  auditRecords() {
    return this.audit.map((record) => ({ ...record }));
  }
}

function cloneGrant(grant) {
  return grant ? { ...grant, roots: [...grant.roots] } : grant;
}

function resolveRoots(roots, resolver) {
  if (typeof resolver !== 'function') return roots;
  try {
    return [...new Set(roots.map((root) => normalizeRoot(resolver(root))))].sort((a, b) =>
      rootKey(a).localeCompare(rootKey(b)),
    );
  } catch (error) {
    if (error instanceof LocalGrantError) throw error;
    throwGrant('LOCAL_GRANT_ROOT_INVALID', 'A local grant root could not be resolved');
  }
}

function createLocalGrantController(options = {}) {
  const store = options.store || new LocalGrantStore(options);
  const nowFn = options.now || (() => new Date());

  async function issue(input = {}) {
    const command = input.command;
    if (typeof input.confirm !== 'function') {
      throwGrant(
        'LOCAL_GRANT_CONFIRMATION_REQUIRED',
        'A native confirmation is required before a local grant can be issued',
      );
    }
    const now = resolveNow(input.now, nowFn);
    const checked = validateCommandShape(command, now.getTime());
    if (input.expectedUserId && checked.userId !== input.expectedUserId) {
      throwGrant('LOCAL_GRANT_WRONG_USER', 'The command is bound to a different user');
    }
    if (input.expectedDeviceId && checked.deviceId !== input.expectedDeviceId) {
      throwGrant('LOCAL_GRANT_WRONG_DEVICE', 'The command is bound to a different device');
    }
    if (checked.capability === 'full_access' && !isNativeConfirmation(input.nativeConfirmation)) {
      throwGrant(
        'LOCAL_GRANT_NATIVE_CONFIRMATION_REQUIRED',
        'Full access requires confirmation from the Electron native surface',
      );
    }
    verifySignedCommand(checked, input.publicKey || options.publicKey);
    const resolvedRoots = resolveRoots(checked.roots, options.resolveRoot);
    if (!(await input.confirm(cloneGrant({ ...checked, roots: resolvedRoots })))) {
      throwGrant('LOCAL_GRANT_DENIED', 'The local grant was denied');
    }
    const expiresAtMs = Date.parse(checked.expiresAt);
    if (!store.consumeNonce(checked.nonce, expiresAtMs, now.getTime())) {
      throwGrant('LOCAL_GRANT_REPLAYED', 'The signed command nonce has already been consumed');
    }
    const grant = {
      grantId: checked.grantId,
      capability: checked.capability,
      roots: resolvedRoots,
      userId: checked.userId,
      deviceId: checked.deviceId,
      issuedAt: checked.issuedAt,
      expiresAt: checked.expiresAt,
      commandDigest: checked.commandDigest,
      approvedLocally: true,
      revokedAt: null,
    };
    return cloneGrant(store.put(grant));
  }

  async function authorize(input = {}) {
    const command = input.command;
    const now = resolveNow(input.now, nowFn);
    const checked = validateCommandShape(command, now.getTime());
    const grant = store.get(checked.grantId);
    if (!grant) throwGrant('LOCAL_GRANT_NOT_FOUND', 'The local grant was not found');
    if (grant.revokedAt) throwGrant('LOCAL_GRANT_REVOKED', 'The local grant has been revoked');
    if (
      checked.userId !== grant.userId ||
      (input.expectedUserId && checked.userId !== input.expectedUserId)
    ) {
      throwGrant('LOCAL_GRANT_WRONG_USER', 'The command is bound to a different user');
    }
    if (
      checked.deviceId !== grant.deviceId ||
      (input.expectedDeviceId && checked.deviceId !== input.expectedDeviceId)
    ) {
      throwGrant('LOCAL_GRANT_WRONG_DEVICE', 'The command is bound to a different device');
    }
    if (checked.capability !== grant.capability) {
      throwGrant(
        'LOCAL_GRANT_CAPABILITY_ESCALATION',
        'The command broadens the approved capability',
      );
    }
    if (Date.parse(checked.expiresAt) > Date.parse(grant.expiresAt)) {
      throwGrant('LOCAL_GRANT_EXPIRY_ESCALATION', 'The command broadens the approved expiry');
    }
    verifySignedCommand(checked, input.publicKey || options.publicKey);
    const resolvedRoots = resolveRoots(checked.roots, options.resolveRoot);
    for (const root of resolvedRoots) {
      if (!grant.roots.some((approvedRoot) => isWithinRoot(root, approvedRoot))) {
        throwGrant('LOCAL_GRANT_ROOT_ESCALATION', 'The command broadens the approved roots');
      }
    }
    const executionNonce = checked.executionNonce || checked.nonce;
    if (
      !store.consumeNonce(
        `execution:${executionNonce}`,
        Date.parse(checked.expiresAt),
        now.getTime(),
      )
    ) {
      throwGrant('LOCAL_GRANT_REPLAYED', 'The local command nonce has already been consumed');
    }
    store.appendAudit({
      action: 'command_authorized',
      grantId: grant.grantId,
      userId: grant.userId,
      deviceId: grant.deviceId,
    });
    return cloneGrant(grant);
  }

  async function revoke(input = {}) {
    if (typeof input.confirm !== 'function') {
      throwGrant(
        'LOCAL_GRANT_CONFIRMATION_REQUIRED',
        'A native confirmation is required to revoke a grant',
      );
    }
    const grant = store.get(input.grantId);
    if (!grant) throwGrant('LOCAL_GRANT_NOT_FOUND', 'The local grant was not found');
    if (input.expectedUserId && grant.userId !== input.expectedUserId) {
      throwGrant('LOCAL_GRANT_WRONG_USER', 'The grant belongs to a different user');
    }
    if (input.expectedDeviceId && grant.deviceId !== input.expectedDeviceId) {
      throwGrant('LOCAL_GRANT_WRONG_DEVICE', 'The grant belongs to a different device');
    }
    if (!(await input.confirm(cloneGrant(grant)))) {
      throwGrant('LOCAL_GRANT_DENIED', 'The local grant revocation was denied');
    }
    return cloneGrant(store.revoke(input.grantId, { reason: input.reason }));
  }

  return {
    requestLocalGrant: issue,
    listLocalGrants: () => store.list(),
    revokeLocalGrant: revoke,
    authorizeLocalCommand: authorize,
    getLocalGrantAudit: () => store.auditRecords(),
    store,
  };
}

const defaultController = createLocalGrantController();

function requestLocalGrant(input) {
  return defaultController.requestLocalGrant(input);
}

function listLocalGrants() {
  return defaultController.listLocalGrants();
}

function revokeLocalGrant(input) {
  return defaultController.revokeLocalGrant(input);
}

module.exports = {
  CAPABILITIES,
  FULL_ACCESS_MAX_AGE_MS,
  LocalGrantError,
  LocalGrantStore,
  authorizeLocalCommand: defaultController.authorizeLocalCommand,
  canonicalizeGrantCommand,
  canonicalizeGrantRequest,
  createNativeConfirmation,
  createElectronKeychainStore,
  createLocalGrantController,
  isWithinRoot,
  listLocalGrants,
  normalizeRoot,
  requestLocalGrant,
  revokeLocalGrant,
  verifySignedCommand,
};
