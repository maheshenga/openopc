import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

export interface PublicRegistrationInput {
  email: string;
  challengeToken: string;
  deviceId: string;
  clientIp: string;
  action: 'signup' | 'magic-link';
  policyVersions: {
    terms: string;
    privacy: string;
    acceptableUse: string;
  };
}

export type PublicRegistrationDecision =
  | { allowed: true; decisionToken: string; expiresAt: string }
  | {
      allowed: false;
      code:
        | 'REGISTRATION_DENIED'
        | 'REGISTRATION_DEPENDENCY_UNAVAILABLE'
        | 'REGISTRATION_RATE_LIMITED';
    };

export type PublicRegistrationRateDimensionKind = 'ip' | 'device' | 'email' | 'account' | 'action';

export interface PublicRegistrationRateDimension {
  kind: PublicRegistrationRateDimensionKind;
  keyHash: `sha256:${string}`;
  limit: number;
  windowSeconds: number;
}

export interface PublicRegistrationStoredDecision {
  jtiHash: `sha256:${string}`;
  emailDigest: `sha256:${string}`;
  deviceDigest: `sha256:${string}`;
  accountDigest?: `sha256:${string}`;
  action: PublicRegistrationInput['action'];
  policyVersions: PublicRegistrationInput['policyVersions'];
  issuedAt: string;
  expiresAt: string;
}

export interface PublicRegistrationDependencies {
  hmacKey: Uint8Array;
  allowedChallengeHostnames: readonly string[];
  now(): Date;
  randomBytes?(size: number): Uint8Array;
  verifyChallenge(input: {
    token: string;
    action: PublicRegistrationInput['action'];
    clientIp: string;
  }): Promise<{ valid: boolean; action: string; hostname: string }>;
  canSignUp(normalizedEmail: string): Promise<{ allowed: boolean; accountId?: string }>;
  consumeRateLimit(input: {
    dimensions: readonly PublicRegistrationRateDimension[];
    persistDecision: boolean;
    decision: PublicRegistrationStoredDecision;
  }): Promise<{ allowed: boolean }>;
  consumeDecision(input: {
    jtiHash: `sha256:${string}`;
    now: Date;
  }): Promise<boolean>;
  completeDecision(input: {
    jtiHash: `sha256:${string}`;
    now: Date;
    accountId: string;
    userId: string;
    decision: PublicRegistrationStoredDecision;
  }): Promise<boolean>;
}

export type ConsumedPublicRegistrationDecision =
  | { valid: true; decision: PublicRegistrationStoredDecision }
  | {
      valid: false;
      code: 'REGISTRATION_DENIED' | 'REGISTRATION_DEPENDENCY_UNAVAILABLE';
    };

const DECISION_LIFETIME_MS = 5 * 60 * 1_000;
const MAX_TOKEN_BYTES = 8_192;
const POLICY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_POLICY_VERSIONS = new Set(['latest', 'current', 'draft', 'unpublished']);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RATE_POLICIES: Readonly<
  Record<PublicRegistrationRateDimensionKind, { limit: number; windowSeconds: number }>
> = Object.freeze({
  ip: { limit: 30, windowSeconds: 300 },
  device: { limit: 10, windowSeconds: 300 },
  email: { limit: 5, windowSeconds: 300 },
  account: { limit: 10, windowSeconds: 300 },
  action: { limit: 100, windowSeconds: 300 },
});

interface SignedDecisionPayload extends PublicRegistrationStoredDecision {
  version: 1;
  jti: string;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function keyedDigest(key: Uint8Array, kind: string, value: string): `sha256:${string}` {
  return `sha256:${createHmac('sha256', key).update(`${kind}\0${value}`).digest('hex')}`;
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim() === value &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximum &&
    !/[\0\r\n]/.test(value)
  );
}

function validPolicies(value: unknown): value is PublicRegistrationInput['policyVersions'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'acceptableUse,privacy,terms') return false;
  return [record.terms, record.privacy, record.acceptableUse].every(
    (version) =>
      typeof version === 'string' &&
      POLICY_VERSION.test(version) &&
      !RESERVED_POLICY_VERSIONS.has(version.toLowerCase()),
  );
}

function normalizeInput(input: PublicRegistrationInput): PublicRegistrationInput | null {
  if (typeof input !== 'object' || input === null) return null;
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (
    !EMAIL.test(email) ||
    Buffer.byteLength(email, 'utf8') > 254 ||
    !boundedText(input.challengeToken, 4_096) ||
    !boundedText(input.deviceId, 255) ||
    typeof input.clientIp !== 'string' ||
    isIP(input.clientIp.trim()) === 0 ||
    !['signup', 'magic-link'].includes(input.action) ||
    !validPolicies(input.policyVersions)
  ) {
    return null;
  }
  return {
    email,
    challengeToken: input.challengeToken,
    deviceId: input.deviceId,
    clientIp: input.clientIp.trim(),
    action: input.action,
    policyVersions: { ...input.policyVersions },
  };
}

function signPayload(payload: SignedDecisionPayload, key: Uint8Array): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function parseSignedPayload(token: string, key: Uint8Array): SignedDecisionPayload | null {
  if (!boundedText(token, MAX_TOKEN_BYTES)) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const allowedKeys = [
    'version',
    'jti',
    'jtiHash',
    'emailDigest',
    'deviceDigest',
    'accountDigest',
    'action',
    'policyVersions',
    'issuedAt',
    'expiresAt',
  ];
  if (Object.keys(payload).some((keyName) => !allowedKeys.includes(keyName))) return null;
  if (
    payload.version !== 1 ||
    !boundedText(payload.jti, 128) ||
    payload.jtiHash !== digest(payload.jti) ||
    typeof payload.emailDigest !== 'string' ||
    !DIGEST.test(payload.emailDigest) ||
    typeof payload.deviceDigest !== 'string' ||
    !DIGEST.test(payload.deviceDigest) ||
    (payload.accountDigest !== undefined &&
      (typeof payload.accountDigest !== 'string' || !DIGEST.test(payload.accountDigest))) ||
    !['signup', 'magic-link'].includes(String(payload.action)) ||
    !validPolicies(payload.policyVersions) ||
    typeof payload.issuedAt !== 'string' ||
    typeof payload.expiresAt !== 'string'
  ) {
    return null;
  }
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt - issuedAt !== DECISION_LIFETIME_MS
  ) {
    return null;
  }
  return payload as unknown as SignedDecisionPayload;
}

function rateDimension(
  kind: PublicRegistrationRateDimensionKind,
  keyHash: `sha256:${string}`,
): PublicRegistrationRateDimension {
  return { kind, keyHash, ...RATE_POLICIES[kind] };
}

export function createPublicRegistrationService(deps: PublicRegistrationDependencies) {
  if (!(deps.hmacKey instanceof Uint8Array) || deps.hmacKey.byteLength < 32) {
    throw new Error('PUBLIC_REGISTRATION_HMAC_KEY_INVALID');
  }
  const allowedHostnames = new Set(
    deps.allowedChallengeHostnames.map((hostname) => hostname.trim().toLowerCase()).filter(Boolean),
  );
  if (allowedHostnames.size === 0) throw new Error('PUBLIC_REGISTRATION_HOSTNAMES_INVALID');

  return Object.freeze({
    async preflight(input: PublicRegistrationInput): Promise<PublicRegistrationDecision> {
      const normalized = normalizeInput(input);
      if (!normalized) return { allowed: false, code: 'REGISTRATION_DENIED' };

      let challenge: Awaited<ReturnType<PublicRegistrationDependencies['verifyChallenge']>>;
      try {
        challenge = await deps.verifyChallenge({
          token: normalized.challengeToken,
          action: normalized.action,
          clientIp: normalized.clientIp,
        });
      } catch {
        return { allowed: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      if (
        !challenge.valid ||
        challenge.action !== normalized.action ||
        !allowedHostnames.has(challenge.hostname.trim().toLowerCase())
      ) {
        return { allowed: false, code: 'REGISTRATION_DENIED' };
      }

      let access: Awaited<ReturnType<PublicRegistrationDependencies['canSignUp']>>;
      try {
        access = await deps.canSignUp(normalized.email);
      } catch {
        return { allowed: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      const now = deps.now();
      if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
        return { allowed: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      const jti = Buffer.from((deps.randomBytes ?? nodeRandomBytes)(32)).toString('base64url');
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.valueOf() + DECISION_LIFETIME_MS).toISOString();
      const decision: PublicRegistrationStoredDecision = {
        jtiHash: digest(jti),
        emailDigest: keyedDigest(deps.hmacKey, 'email', normalized.email),
        deviceDigest: keyedDigest(deps.hmacKey, 'device', normalized.deviceId),
        ...(access.accountId
          ? { accountDigest: keyedDigest(deps.hmacKey, 'account', access.accountId) }
          : {}),
        action: normalized.action,
        policyVersions: { ...normalized.policyVersions },
        issuedAt,
        expiresAt,
      };
      const dimensions = [
        rateDimension('ip', keyedDigest(deps.hmacKey, 'ip', normalized.clientIp)),
        rateDimension('device', decision.deviceDigest),
        rateDimension('email', decision.emailDigest),
        ...(decision.accountDigest ? [rateDimension('account', decision.accountDigest)] : []),
        rateDimension('action', keyedDigest(deps.hmacKey, 'action', normalized.action)),
      ];

      let rateResult: { allowed: boolean };
      try {
        rateResult = await deps.consumeRateLimit({
          dimensions,
          persistDecision: access.allowed,
          decision,
        });
      } catch {
        return { allowed: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      if (!rateResult.allowed) return { allowed: false, code: 'REGISTRATION_RATE_LIMITED' };
      if (!access.allowed) return { allowed: false, code: 'REGISTRATION_DENIED' };

      return {
        allowed: true,
        decisionToken: signPayload({ version: 1, jti, ...decision }, deps.hmacKey),
        expiresAt,
      };
    },

    async consumeDecisionToken(token: string): Promise<ConsumedPublicRegistrationDecision> {
      const payload = parseSignedPayload(token, deps.hmacKey);
      const now = deps.now();
      if (
        !payload ||
        !(now instanceof Date) ||
        !Number.isFinite(now.valueOf()) ||
        Date.parse(payload.issuedAt) > now.valueOf() ||
        Date.parse(payload.expiresAt) <= now.valueOf()
      ) {
        return { valid: false, code: 'REGISTRATION_DENIED' };
      }
      let consumed: boolean;
      try {
        consumed = await deps.consumeDecision({ jtiHash: payload.jtiHash, now });
      } catch {
        return { valid: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      if (!consumed) return { valid: false, code: 'REGISTRATION_DENIED' };
      const { jti: _jti, version: _version, ...decision } = payload;
      return { valid: true, decision };
    },

    async completeRegistrationDecision(
      token: string,
      subject: { accountId: string; userId: string },
    ): Promise<ConsumedPublicRegistrationDecision> {
      const payload = parseSignedPayload(token, deps.hmacKey);
      const now = deps.now();
      if (
        !payload ||
        !UUID.test(subject.accountId) ||
        !UUID.test(subject.userId) ||
        !(now instanceof Date) ||
        !Number.isFinite(now.valueOf()) ||
        Date.parse(payload.issuedAt) > now.valueOf() ||
        Date.parse(payload.expiresAt) <= now.valueOf()
      ) {
        return { valid: false, code: 'REGISTRATION_DENIED' };
      }
      const { jti: _jti, version: _version, ...decision } = payload;
      let completed: boolean;
      try {
        completed = await deps.completeDecision({
          jtiHash: payload.jtiHash,
          now,
          accountId: subject.accountId,
          userId: subject.userId,
          decision,
        });
      } catch {
        return { valid: false, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' };
      }
      if (!completed) return { valid: false, code: 'REGISTRATION_DENIED' };
      return { valid: true, decision };
    },
  });
}
