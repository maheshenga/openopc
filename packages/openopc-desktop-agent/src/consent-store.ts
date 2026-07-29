import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { LocalPermission } from 'agent-tunnel';

export const FULL_ACCESS_CONSENT_MAX_AGE_MS = 60 * 60 * 1000;
export const DEFAULT_CONSENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const LOCAL_PERMIT_MAX_AGE_MS = 30 * 1000;

const CONSENT_SCHEMA_VERSION = 1;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ALLOWED_CAPABILITIES = new Set(['filesystem', 'shell', 'desktop']);

export interface NativeConfirmationRequest {
  tunnelId: string;
  permissionId: string;
  capability: string;
  scopeDigest: string;
  expiresAt: string | null;
}

export interface NativeConfirmationPort {
  confirm(request: NativeConfirmationRequest): Promise<boolean>;
}

export type ConsentKind = 'capability' | 'full_access';

export interface DesktopConsentGrant extends NativeConfirmationRequest {
  userId: string;
  deviceId: string;
  consentKind?: ConsentKind;
  bundleId?: string;
}

export interface DesktopConsentAuthorization {
  tunnelId: string;
  permission: LocalPermission | undefined;
  userId: string;
  deviceId: string;
  method: string;
  params: Record<string, unknown>;
}

export interface LocalPermit {
  permitId: string;
  consentGeneration: string;
  tunnelId: string;
  permissionId: string;
  capability: string;
  scopeDigest: string;
  userId: string;
  deviceId: string;
  method: string;
  paramsDigest: string;
  issuedAt: string;
  expiresAt: string;
}

export interface DesktopConsentStore {
  grant(input: DesktopConsentGrant): void;
  grantBundle(inputs: readonly DesktopConsentGrant[]): void;
  revoke(permissionId: string, reason: string): void;
  clear(reason: string): void;
  issuePermit(input: DesktopConsentAuthorization): LocalPermit;
  consumePermit(permit: LocalPermit, input: DesktopConsentAuthorization): Promise<void>;
  authorize(input: DesktopConsentAuthorization): Promise<void>;
}

export interface ConsentPersistencePort {
  readEncrypted(): string | null;
  writeEncrypted(value: string): void;
  clear(): void;
  readFailureMarker(): boolean;
  /**
   * Atomically establish a durable fail-closed state. Before returning, either
   * readFailureMarker() must be true or readEncrypted() must be null.
   */
  quarantine(): void;
  clearFailureMarker(): void;
}

export interface ConsentCipherPort {
  readonly kind: 'authenticated';
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

export interface ConsentAuditEvent {
  version: 1;
  at: string;
  action: 'grant' | 'authorize' | 'deny' | 'revoke' | 'clear';
  capability?: string;
  scopeDigest?: string;
  tunnelRef?: string;
  permissionRef?: string;
  userRef?: string;
  deviceRef?: string;
  reasonCode?: string;
}

export interface ConsentAuditPort {
  append(event: ConsentAuditEvent): void;
}

export interface DesktopConsentStoreOptions {
  now?: () => number;
  nonce?: () => string;
  generation?: () => string;
  persistence?: ConsentPersistencePort;
  cipher?: ConsentCipherPort;
  audit?: ConsentAuditPort;
  onFatalStorageFailure?: (reason: 'LOCAL_CONSENT_QUARANTINE_FAILED') => void;
}

/** A portable authenticated cipher for tests and non-Electron hosts. */
export function createAesGcmConsentCipher(key: Uint8Array): ConsentCipherPort {
  const secret = Buffer.from(key);
  if (secret.length !== 32) fail('LOCAL_CONSENT_ENCRYPTION_KEY_INVALID');
  return {
    kind: 'authenticated',
    encrypt(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `aead.v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
    },
    decrypt(encoded) {
      const parts = encoded.split('.');
      if (parts.length !== 5 || parts[0] !== 'aead' || parts[1] !== 'v1') {
        fail('LOCAL_CONSENT_STORAGE_CORRUPT');
      }
      try {
        const iv = Buffer.from(parts[2], 'base64url');
        const tag = Buffer.from(parts[3], 'base64url');
        const ciphertext = Buffer.from(parts[4], 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', secret, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        fail('LOCAL_CONSENT_STORAGE_CORRUPT');
      }
    },
  };
}

interface ConsentRecord {
  version: 1;
  key: string;
  consentGeneration: string;
  tunnelId: string;
  permissionId: string;
  capability: string;
  scopeDigest: string;
  userId: string;
  deviceId: string;
  permissionExpiresAt: string | null;
  issuedAt: string;
  localExpiresAt: string;
  consentKind: ConsentKind;
  bundleId: string | null;
  revokedAt: string | null;
}

interface ConsumedPermit {
  key: string;
  requestDigest: string;
  expiresAt: number;
}

interface IssuedPermit extends LocalPermit {
  key: string;
  requestDigest: string;
  expiresAtMs: number;
}

interface PersistedConsentState {
  version: 1;
  records: ConsentRecord[];
  consumedPermits: Array<{ nonce: string; key: string; requestDigest: string; expiresAt: string }>;
}

class DesktopConsentError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(`${code}: ${message}`);
    this.name = 'DesktopConsentError';
    this.code = code;
  }
}

export { DesktopConsentError };

function fail(code: string, message?: string): never {
  throw new DesktopConsentError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown, seen = new Set<object>(), depth = 0): string {
  if (depth > 32) fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope is too deeply nested');
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope contains a non-finite number');
    return JSON.stringify(value);
  }
  if (value === undefined) fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope contains undefined');
  if (typeof value !== 'object')
    fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope contains a non-JSON value');
  if (seen.has(value)) fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, seen, depth + 1)).join(',')}]`;
    }
    if (!isPlainObject(value))
      fail('LOCAL_CONSENT_SCOPE_INVALID', 'scope contains a non-plain object');
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen, depth + 1)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function redactedRef(value: string): string {
  return sha256(value).slice(0, 'sha256:'.length + 16);
}

function parseTimestamp(value: string | null, code: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'string') fail(code, 'timestamp must be a string or null');
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail(code, 'timestamp is invalid');
  return timestamp;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function nonEmpty(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail(code);
  return value;
}

function permissionCapability(method: string): string | null {
  if (method.startsWith('fs.')) return 'filesystem';
  if (method.startsWith('shell.')) return 'shell';
  if (method.startsWith('desktop.cua.')) return 'desktop';
  return null;
}

function permissionShape(permission: LocalPermission): void {
  nonEmpty(permission.permissionId, 'LOCAL_CONSENT_PERMISSION_INVALID');
  if (!ALLOWED_CAPABILITIES.has(permission.capability)) {
    fail('LOCAL_CONSENT_CAPABILITY_INVALID');
  }
  if (!isPlainObject(permission.scope)) fail('LOCAL_CONSENT_SCOPE_INVALID');
  if (permission.expiresAt !== undefined)
    parseTimestamp(permission.expiresAt, 'LOCAL_CONSENT_EXPIRY_INVALID');
  const policyVersion = permission.policyVersion ?? permission.policy_version;
  if (policyVersion !== undefined) nonEmpty(policyVersion, 'LOCAL_CONSENT_POLICY_INVALID');
}

/**
 * Hash only data supplied by the already-authenticated Agent permission path.
 * The version marker makes future canonicalization changes invalidate old
 * local confirmations instead of silently reusing them.
 */
export function canonicalPermissionScopeDigest(permission: LocalPermission): string {
  permissionShape(permission);
  const canonical = canonicalJson({
    schema: CONSENT_SCHEMA_VERSION,
    permissionId: permission.permissionId,
    capability: permission.capability,
    scope: permission.scope,
    expiresAt: permission.expiresAt ?? null,
    policyVersion: permission.policyVersion ?? permission.policy_version ?? null,
  });
  return sha256(canonical);
}

function consentKey(input: {
  tunnelId: string;
  permissionId: string;
  capability: string;
  userId: string;
  deviceId: string;
}): string {
  return canonicalJson([
    input.tunnelId,
    input.permissionId,
    input.capability,
    input.userId,
    input.deviceId,
  ]);
}

function paramsDigest(method: string, params: Record<string, unknown>): string {
  const { __permission: _permission, ...wireParams } = params;
  return sha256(canonicalJson({ schema: CONSENT_SCHEMA_VERSION, method, params: wireParams }));
}

function validateDigest(value: string): void {
  if (!DIGEST_RE.test(value)) fail('LOCAL_CONSENT_DIGEST_INVALID');
}

function validateStoredRecord(value: unknown): ConsentRecord {
  if (!isPlainObject(value) || value.version !== 1) fail('LOCAL_CONSENT_STORAGE_CORRUPT');
  const key = nonEmpty(value.key, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const consentGeneration = nonEmpty(value.consentGeneration, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const tunnelId = nonEmpty(value.tunnelId, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const permissionId = nonEmpty(value.permissionId, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const capability = nonEmpty(value.capability, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const scopeDigest = nonEmpty(value.scopeDigest, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const userId = nonEmpty(value.userId, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const deviceId = nonEmpty(value.deviceId, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const issuedAt = nonEmpty(value.issuedAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const localExpiresAt = nonEmpty(value.localExpiresAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  if (!ALLOWED_CAPABILITIES.has(capability)) fail('LOCAL_CONSENT_STORAGE_CORRUPT');
  validateDigest(scopeDigest);
  const permissionExpiresAt =
    value.permissionExpiresAt === null
      ? null
      : nonEmpty(value.permissionExpiresAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  parseTimestamp(permissionExpiresAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  parseTimestamp(issuedAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  parseTimestamp(localExpiresAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  if (value.consentKind !== 'capability' && value.consentKind !== 'full_access') {
    fail('LOCAL_CONSENT_STORAGE_CORRUPT');
  }
  const bundleId =
    value.bundleId === null ? null : nonEmpty(value.bundleId, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const revokedAt =
    value.revokedAt === null ? null : nonEmpty(value.revokedAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  if (revokedAt) parseTimestamp(revokedAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
  const record: ConsentRecord = {
    version: 1,
    key,
    consentGeneration,
    tunnelId,
    permissionId,
    capability,
    scopeDigest,
    userId,
    deviceId,
    permissionExpiresAt,
    issuedAt,
    localExpiresAt,
    consentKind: value.consentKind,
    bundleId,
    revokedAt,
  };
  if (key !== consentKey(record)) {
    fail('LOCAL_CONSENT_STORAGE_CORRUPT');
  }
  return record;
}

function safeAudit(
  audit: ConsentAuditPort | undefined,
  event: Omit<ConsentAuditEvent, 'version' | 'at'>,
  now: number,
  onFailure?: (code: string) => never,
): void {
  if (!audit) return;
  try {
    audit.append({ version: 1, at: iso(now), ...event });
  } catch {
    if (onFailure) onFailure('LOCAL_CONSENT_AUDIT_FAILED');
    fail('LOCAL_CONSENT_AUDIT_FAILED');
  }
}

function denyAuthorization(
  audit: ConsentAuditPort | undefined,
  input: DesktopConsentAuthorization,
  permission: LocalPermission,
  digest: string,
  reasonCode: string,
  now: number,
  record?: ConsentRecord,
  onFailure?: (code: string) => never,
): never {
  safeAudit(
    audit,
    {
      action: 'deny',
      capability: record?.capability ?? permission.capability,
      scopeDigest: record?.scopeDigest ?? digest,
      tunnelRef: redactedRef(input.tunnelId),
      permissionRef: redactedRef(permission.permissionId),
      userRef: redactedRef(input.userId),
      deviceRef: redactedRef(input.deviceId),
      reasonCode,
    },
    now,
    onFailure,
  );
  fail(reasonCode);
}

export function createDesktopConsentStore(
  options: DesktopConsentStoreOptions = {},
): DesktopConsentStore {
  const now = options.now ?? Date.now;
  const nonceFactory = options.nonce ?? randomUUID;
  const generationFactory = options.generation ?? randomUUID;
  if ((options.persistence && !options.cipher) || (!options.persistence && options.cipher)) {
    fail('LOCAL_CONSENT_ENCRYPTION_REQUIRED');
  }
  if (options.cipher && options.cipher.kind !== 'authenticated') {
    fail('LOCAL_CONSENT_ENCRYPTION_REQUIRED');
  }

  const records = new Map<string, ConsentRecord>();
  const issuedPermits = new Map<string, IssuedPermit>();
  const consumedPermits = new Map<string, ConsumedPermit>();
  const persistence = options.persistence;
  const cipher = options.cipher;
  let storageFailed = false;

  const enterStorageFailure = (code = 'LOCAL_CONSENT_PERSIST_FAILED'): never => {
    storageFailed = true;
    records.clear();
    issuedPermits.clear();
    consumedPermits.clear();
    if (persistence) {
      let quarantined = false;
      try {
        persistence.quarantine();
      } catch {
        // Verification below decides whether the durable fail-closed state exists.
      }
      try {
        quarantined = persistence.readFailureMarker() === true;
      } catch {
        // A missing marker can still be safe when quarantine deleted the payload.
      }
      if (!quarantined) {
        try {
          quarantined = persistence.readEncrypted() === null;
        } catch {
          // The caller must treat an unprovable quarantine as a fatal process state.
        }
      }
      if (!quarantined) {
        try {
          options.onFatalStorageFailure?.('LOCAL_CONSENT_QUARANTINE_FAILED');
        } catch {
          // A supervisor callback cannot make the local store available again.
        }
        fail('LOCAL_CONSENT_FATAL_STORAGE_FAILURE', code);
      }
    }
    fail(code);
  };

  const assertStorageAvailable = (): void => {
    if (storageFailed) fail('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
  };

  if (persistence) {
    let failureMarker: boolean | undefined;
    try {
      failureMarker = persistence.readFailureMarker();
    } catch {
      enterStorageFailure('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    }
    if (failureMarker !== false) {
      fail('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    }
  }

  const persist = (): void => {
    assertStorageAvailable();
    if (!persistence || !cipher) return;
    const state: PersistedConsentState = {
      version: 1,
      records: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)),
      consumedPermits: [...consumedPermits.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([nonce, permit]) => ({
          nonce,
          key: permit.key,
          requestDigest: permit.requestDigest,
          expiresAt: iso(permit.expiresAt),
        })),
    };
    const plaintext = canonicalJson(state);
    let encrypted = '';
    try {
      encrypted = cipher.encrypt(plaintext);
    } catch {
      enterStorageFailure('LOCAL_CONSENT_ENCRYPTION_FAILED');
    }
    if (typeof encrypted !== 'string' || encrypted.length === 0 || encrypted === plaintext) {
      enterStorageFailure('LOCAL_CONSENT_ENCRYPTION_REQUIRED');
    }
    try {
      persistence.writeEncrypted(encrypted);
    } catch {
      enterStorageFailure();
    }
  };

  const load = (): void => {
    if (!persistence || !cipher) return;
    let encrypted: string | null = null;
    try {
      encrypted = persistence.readEncrypted();
    } catch {
      enterStorageFailure('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    }
    if (encrypted === null) return;
    let parsed: unknown;
    try {
      const plaintext = cipher.decrypt(encrypted);
      parsed = JSON.parse(plaintext);
    } catch {
      fail('LOCAL_CONSENT_STORAGE_CORRUPT');
    }
    if (
      !isPlainObject(parsed) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.records) ||
      !Array.isArray(parsed.consumedPermits)
    ) {
      fail('LOCAL_CONSENT_STORAGE_CORRUPT');
    }
    for (const raw of parsed.records) {
      const record = validateStoredRecord(raw);
      records.set(record.key, record);
    }
    for (const raw of parsed.consumedPermits) {
      if (
        !isPlainObject(raw) ||
        typeof raw.nonce !== 'string' ||
        typeof raw.key !== 'string' ||
        typeof raw.requestDigest !== 'string' ||
        typeof raw.expiresAt !== 'string'
      ) {
        fail('LOCAL_CONSENT_STORAGE_CORRUPT');
      }
      validateDigest(raw.requestDigest);
      const expiresAt = parseTimestamp(raw.expiresAt, 'LOCAL_CONSENT_STORAGE_CORRUPT');
      if (expiresAt === null) fail('LOCAL_CONSENT_STORAGE_CORRUPT');
      consumedPermits.set(raw.nonce, { key: raw.key, requestDigest: raw.requestDigest, expiresAt });
    }
  };
  load();

  const prune = (timestamp: number): void => {
    for (const [permitId, permit] of issuedPermits) {
      if (permit.expiresAtMs <= timestamp) issuedPermits.delete(permitId);
    }
    for (const [nonce, permit] of consumedPermits) {
      if (permit.expiresAt <= timestamp) consumedPermits.delete(nonce);
    }
  };

  const invalidateIssuedPermits = (predicate: (permit: IssuedPermit) => boolean): void => {
    for (const [permitId, permit] of issuedPermits) {
      if (predicate(permit)) issuedPermits.delete(permitId);
    }
  };

  const resolveAuthorization = (
    input: DesktopConsentAuthorization,
    timestamp: number,
  ): {
    permission: LocalPermission;
    record: ConsentRecord;
    key: string;
    digest: string;
    requestDigest: string;
    localExpiry: number;
  } => {
    if (storageFailed) fail('LOCAL_CONSENT_STORAGE_UNAVAILABLE');
    prune(timestamp);
    nonEmpty(input.tunnelId, 'LOCAL_CONSENT_TUNNEL_INVALID');
    nonEmpty(input.userId, 'LOCAL_CONSENT_USER_INVALID');
    nonEmpty(input.deviceId, 'LOCAL_CONSENT_DEVICE_INVALID');
    nonEmpty(input.method, 'LOCAL_CONSENT_METHOD_INVALID');
    const permission = input.permission;
    if (!permission) fail('LOCAL_CONSENT_SERVER_PERMISSION_REQUIRED');
    permissionShape(permission);
    if (!input.params || !isPlainObject(input.params)) fail('LOCAL_CONSENT_PARAMS_INVALID');
    if (input.params.__permission !== permission) {
      fail('LOCAL_CONSENT_SERVER_PERMISSION_MISMATCH');
    }
    const methodCapability = permissionCapability(input.method);
    if (!methodCapability || methodCapability !== permission.capability) {
      fail('LOCAL_CONSENT_METHOD_CAPABILITY_MISMATCH');
    }
    const digest = canonicalPermissionScopeDigest(permission);
    const key = consentKey({
      tunnelId: input.tunnelId,
      permissionId: permission.permissionId,
      capability: permission.capability,
      userId: input.userId,
      deviceId: input.deviceId,
    });
    const record = records.get(key);
    if (!record) {
      const sameBindingFamily = [...records.values()].some(
        (candidate) =>
          candidate.permissionId === permission.permissionId ||
          (candidate.tunnelId === input.tunnelId &&
            candidate.userId === input.userId &&
            candidate.deviceId === input.deviceId &&
            candidate.capability === permission.capability),
      );
      if (sameBindingFamily) {
        denyAuthorization(
          options.audit,
          input,
          permission,
          digest,
          'LOCAL_CONSENT_MISMATCH',
          timestamp,
          undefined,
          enterStorageFailure,
        );
      }
      denyAuthorization(
        options.audit,
        input,
        permission,
        digest,
        'LOCAL_CONSENT_MISSING',
        timestamp,
        undefined,
        enterStorageFailure,
      );
    }
    if (!record) fail('LOCAL_CONSENT_MISSING');
    if (record.revokedAt) {
      denyAuthorization(
        options.audit,
        input,
        permission,
        digest,
        'LOCAL_CONSENT_REVOKED',
        timestamp,
        record,
        enterStorageFailure,
      );
    }
    if (
      record.tunnelId !== input.tunnelId ||
      record.permissionId !== permission.permissionId ||
      record.capability !== permission.capability ||
      record.userId !== input.userId ||
      record.deviceId !== input.deviceId ||
      record.scopeDigest !== digest ||
      record.permissionExpiresAt !== (permission.expiresAt ?? null)
    ) {
      denyAuthorization(
        options.audit,
        input,
        permission,
        digest,
        'LOCAL_CONSENT_MISMATCH',
        timestamp,
        record,
        enterStorageFailure,
      );
    }
    const localExpiry = Date.parse(record.localExpiresAt);
    if (!Number.isFinite(localExpiry) || localExpiry <= timestamp) {
      records.delete(key);
      persist();
      denyAuthorization(
        options.audit,
        input,
        permission,
        digest,
        'LOCAL_CONSENT_EXPIRED',
        timestamp,
        record,
        enterStorageFailure,
      );
    }
    return {
      permission,
      record,
      key,
      digest,
      requestDigest: paramsDigest(input.method, input.params),
      localExpiry,
    };
  };

  const issuePermit = (input: DesktopConsentAuthorization): LocalPermit => {
    const timestamp = now();
    const resolved = resolveAuthorization(input, timestamp);
    const permitId = nonEmpty(nonceFactory(), 'LOCAL_PERMIT_NONCE_INVALID');
    if (issuedPermits.has(permitId) || consumedPermits.has(permitId)) {
      denyAuthorization(
        options.audit,
        input,
        resolved.permission,
        resolved.digest,
        'LOCAL_PERMIT_REPLAYED',
        timestamp,
        resolved.record,
        enterStorageFailure,
      );
    }
    const expiresAtMs = Math.min(resolved.localExpiry, timestamp + LOCAL_PERMIT_MAX_AGE_MS);
    const permit: IssuedPermit = {
      permitId,
      consentGeneration: resolved.record.consentGeneration,
      tunnelId: input.tunnelId,
      permissionId: resolved.permission.permissionId,
      capability: resolved.permission.capability,
      scopeDigest: resolved.digest,
      userId: input.userId,
      deviceId: input.deviceId,
      method: input.method,
      paramsDigest: resolved.requestDigest,
      issuedAt: iso(timestamp),
      expiresAt: iso(expiresAtMs),
      key: resolved.key,
      requestDigest: resolved.requestDigest,
      expiresAtMs,
    };
    issuedPermits.set(permitId, permit);
    return Object.freeze({
      permitId: permit.permitId,
      consentGeneration: permit.consentGeneration,
      tunnelId: permit.tunnelId,
      permissionId: permit.permissionId,
      capability: permit.capability,
      scopeDigest: permit.scopeDigest,
      userId: permit.userId,
      deviceId: permit.deviceId,
      method: permit.method,
      paramsDigest: permit.paramsDigest,
      issuedAt: permit.issuedAt,
      expiresAt: permit.expiresAt,
    });
  };

  const consumePermit = async (
    permit: LocalPermit,
    input: DesktopConsentAuthorization,
  ): Promise<void> => {
    const timestamp = now();
    const resolved = resolveAuthorization(input, timestamp);
    const deny = (reasonCode: string): never =>
      denyAuthorization(
        options.audit,
        input,
        resolved.permission,
        resolved.digest,
        reasonCode,
        timestamp,
        resolved.record,
        enterStorageFailure,
      );
    const consumed = consumedPermits.get(permit.permitId);
    if (consumed && consumed.expiresAt > timestamp) deny('LOCAL_PERMIT_REPLAYED');
    const issued = issuedPermits.get(permit.permitId);
    if (!issued) deny('LOCAL_PERMIT_INVALID');
    if (!issued) fail('LOCAL_PERMIT_INVALID');
    if (issued.expiresAtMs <= timestamp) {
      issuedPermits.delete(permit.permitId);
      deny('LOCAL_PERMIT_EXPIRED');
    }
    if (
      issued.key !== resolved.key ||
      issued.requestDigest !== resolved.requestDigest ||
      issued.consentGeneration !== resolved.record.consentGeneration ||
      permit.consentGeneration !== issued.consentGeneration ||
      permit.tunnelId !== issued.tunnelId ||
      permit.permissionId !== issued.permissionId ||
      permit.capability !== issued.capability ||
      permit.scopeDigest !== issued.scopeDigest ||
      permit.userId !== issued.userId ||
      permit.deviceId !== issued.deviceId ||
      permit.method !== issued.method ||
      permit.paramsDigest !== issued.paramsDigest ||
      permit.issuedAt !== issued.issuedAt ||
      permit.expiresAt !== issued.expiresAt
    ) {
      deny('LOCAL_PERMIT_INVALID');
    }
    issuedPermits.delete(permit.permitId);
    consumedPermits.set(permit.permitId, {
      key: issued.key,
      requestDigest: issued.requestDigest,
      expiresAt: issued.expiresAtMs,
    });
    try {
      persist();
    } catch (error) {
      if (!storageFailed) {
        consumedPermits.delete(permit.permitId);
        issuedPermits.set(permit.permitId, issued);
      }
      throw error;
    }
    safeAudit(
      options.audit,
      {
        action: 'authorize',
        capability: resolved.record.capability,
        scopeDigest: resolved.record.scopeDigest,
        tunnelRef: redactedRef(resolved.record.tunnelId),
        permissionRef: redactedRef(resolved.record.permissionId),
        userRef: redactedRef(resolved.record.userId),
        deviceRef: redactedRef(resolved.record.deviceId),
        reasonCode: 'LOCAL_PERMIT_CONSUMED',
      },
      timestamp,
      enterStorageFailure,
    );
  };

  const authorize = async (input: DesktopConsentAuthorization): Promise<void> => {
    const permit = issuePermit(input);
    await consumePermit(permit, input);
  };

  const buildConsentRecord = (
    input: DesktopConsentGrant,
    allowBundle: boolean,
    timestamp: number,
    forcedLocalExpiry?: number,
  ): ConsentRecord => {
    nonEmpty(input.tunnelId, 'LOCAL_CONSENT_TUNNEL_INVALID');
    nonEmpty(input.permissionId, 'LOCAL_CONSENT_PERMISSION_INVALID');
    nonEmpty(input.userId, 'LOCAL_CONSENT_USER_INVALID');
    nonEmpty(input.deviceId, 'LOCAL_CONSENT_DEVICE_INVALID');
    if (!ALLOWED_CAPABILITIES.has(input.capability)) fail('LOCAL_CONSENT_CAPABILITY_INVALID');
    validateDigest(input.scopeDigest);
    const permissionExpiry = parseTimestamp(input.expiresAt, 'LOCAL_CONSENT_EXPIRY_INVALID');
    if (permissionExpiry !== null && permissionExpiry <= timestamp) {
      fail('LOCAL_CONSENT_EXPIRED');
    }
    const consentKind = input.consentKind ?? 'capability';
    if (consentKind === 'full_access' && !allowBundle) {
      fail('LOCAL_CONSENT_BUNDLE_REQUIRED');
    }
    if (consentKind === 'full_access' && !input.bundleId) {
      fail('LOCAL_CONSENT_BUNDLE_REQUIRED');
    }
    const maxAge =
      consentKind === 'full_access' ? FULL_ACCESS_CONSENT_MAX_AGE_MS : DEFAULT_CONSENT_MAX_AGE_MS;
    const localExpiry = Math.min(
      permissionExpiry ?? timestamp + maxAge,
      forcedLocalExpiry ?? timestamp + maxAge,
    );
    if (localExpiry <= timestamp) fail('LOCAL_CONSENT_EXPIRED');
    const key = consentKey(input);
    return {
      version: 1,
      key,
      consentGeneration: nonEmpty(generationFactory(), 'LOCAL_CONSENT_GENERATION_INVALID'),
      tunnelId: input.tunnelId,
      permissionId: input.permissionId,
      capability: input.capability,
      scopeDigest: input.scopeDigest,
      userId: input.userId,
      deviceId: input.deviceId,
      permissionExpiresAt: input.expiresAt,
      issuedAt: iso(timestamp),
      localExpiresAt: iso(localExpiry),
      consentKind,
      bundleId: input.bundleId ?? null,
      revokedAt: null,
    };
  };

  const grantRecord = (input: DesktopConsentGrant, allowBundle: boolean): ConsentRecord => {
    assertStorageAvailable();
    const timestamp = now();
    const record = buildConsentRecord(input, allowBundle, timestamp);
    const previous = records.get(record.key);
    invalidateIssuedPermits((permit) => permit.key === record.key);
    records.set(record.key, record);
    try {
      persist();
      safeAudit(
        options.audit,
        {
          action: 'grant',
          capability: record.capability,
          scopeDigest: record.scopeDigest,
          tunnelRef: redactedRef(record.tunnelId),
          permissionRef: redactedRef(record.permissionId),
          userRef: redactedRef(record.userId),
          deviceRef: redactedRef(record.deviceId),
          reasonCode: 'NATIVE_CONFIRMATION_ACCEPTED',
        },
        timestamp,
        enterStorageFailure,
      );
    } catch (error) {
      if (!storageFailed) {
        if (previous) records.set(record.key, previous);
        else records.delete(record.key);
        try {
          persist();
        } catch {
          // Keep the in-memory store fail-closed if rollback persistence fails.
        }
      }
      throw error;
    }
    return record;
  };

  return {
    grant(input) {
      grantRecord(input, false);
    },
    grantBundle(inputs) {
      assertStorageAvailable();
      if (inputs.length !== 3) fail('LOCAL_CONSENT_BUNDLE_INVALID');
      const expected = new Set(['filesystem', 'shell', 'desktop']);
      const first = inputs[0];
      if (!first || first.consentKind !== 'full_access' || !first.bundleId) {
        fail('LOCAL_CONSENT_BUNDLE_INVALID');
      }
      for (const input of inputs) {
        if (
          input.consentKind !== 'full_access' ||
          input.bundleId !== first.bundleId ||
          input.tunnelId !== first.tunnelId ||
          input.userId !== first.userId ||
          input.deviceId !== first.deviceId ||
          !expected.delete(input.capability)
        ) {
          fail('LOCAL_CONSENT_BUNDLE_INVALID');
        }
      }
      const timestamp = now();
      let bundleExpiry = timestamp + FULL_ACCESS_CONSENT_MAX_AGE_MS;
      for (const input of inputs) {
        const permissionExpiry = parseTimestamp(input.expiresAt, 'LOCAL_CONSENT_EXPIRY_INVALID');
        if (permissionExpiry !== null) bundleExpiry = Math.min(bundleExpiry, permissionExpiry);
      }
      const prepared = inputs.map((input) =>
        buildConsentRecord(input, true, timestamp, bundleExpiry),
      );
      const snapshots = new Map(records);
      try {
        for (const record of prepared) {
          invalidateIssuedPermits((permit) => permit.key === record.key);
          records.set(record.key, record);
        }
        persist();
        for (const record of prepared) {
          safeAudit(
            options.audit,
            {
              action: 'grant',
              capability: record.capability,
              scopeDigest: record.scopeDigest,
              tunnelRef: redactedRef(record.tunnelId),
              permissionRef: redactedRef(record.permissionId),
              userRef: redactedRef(record.userId),
              deviceRef: redactedRef(record.deviceId),
              reasonCode: 'NATIVE_CONFIRMATION_ACCEPTED',
            },
            timestamp,
            enterStorageFailure,
          );
        }
      } catch (error) {
        if (!storageFailed) {
          records.clear();
          for (const [key, record] of snapshots) records.set(key, record);
          try {
            persist();
          } catch {
            // The store is already fail-closed if persistence cannot be restored.
          }
        }
        throw error;
      }
    },
    issuePermit,
    consumePermit,
    revoke(permissionId, reason) {
      assertStorageAvailable();
      const timestamp = now();
      let changed = false;
      const revokedRecords: ConsentRecord[] = [];
      invalidateIssuedPermits((permit) => permit.permissionId === permissionId);
      for (const [key, record] of records) {
        if (record.permissionId !== permissionId) continue;
        const revoked = { ...record, revokedAt: iso(timestamp) };
        records.set(key, revoked);
        revokedRecords.push(revoked);
        changed = true;
      }
      if (changed) persist();
      for (const record of revokedRecords) {
        safeAudit(
          options.audit,
          {
            action: 'revoke',
            capability: record.capability,
            scopeDigest: record.scopeDigest,
            tunnelRef: redactedRef(record.tunnelId),
            permissionRef: redactedRef(record.permissionId),
            userRef: redactedRef(record.userId),
            deviceRef: redactedRef(record.deviceId),
            reasonCode: sha256(reason),
          },
          timestamp,
          enterStorageFailure,
        );
      }
    },
    clear(reason) {
      assertStorageAvailable();
      const timestamp = now();
      records.clear();
      issuedPermits.clear();
      consumedPermits.clear();
      if (persistence) {
        try {
          persistence.clear();
        } catch {
          enterStorageFailure();
        }
      }
      safeAudit(
        options.audit,
        { action: 'clear', reasonCode: sha256(reason) },
        timestamp,
        enterStorageFailure,
      );
    },
    authorize,
  };
}
