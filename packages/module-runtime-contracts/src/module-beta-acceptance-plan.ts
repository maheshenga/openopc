import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { ModuleBetaTrustScenario } from './module-beta-acceptance';

export interface ModuleBetaAcceptancePlanV1 {
  schemaVersion: 1;
  registrationId: string;
  acceptanceRunId: string;
  scenario: ModuleBetaTrustScenario;
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
  issuedAt: string;
  expiresAt: string;
  controllerIdentity: string;
}

interface ModuleBetaAcceptancePlanEnvelopeV1 {
  hmacSha256: `sha256:${string}`;
  plan: ModuleBetaAcceptancePlanV1;
}

export interface VerifyModuleBetaAcceptancePlanOptions {
  key: Uint8Array;
  now: Date;
}

export interface ModuleBetaAcceptanceObjectKeyInput {
  accountId: string;
  artifactId: string;
  kind: 'plan' | 'consumption';
  prefix?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HMAC_SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONTROLLER_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const MAX_PLAN_LIFETIME_NANOSECONDS = 15n * 60n * 1_000_000_000n;
const CLOCK_SKEW_NANOSECONDS = 60n * 1_000_000_000n;
const MAX_ENVELOPE_BYTES = 16 * 1024;
const SCENARIOS = new Set<ModuleBetaTrustScenario>([
  'clean-wasi',
  'secret-leak',
  'vulnerable-lockfile',
  'invalid-signature',
  'stale-policy',
  'scanner-crash',
]);
const PLAN_KEYS = [
  'schemaVersion',
  'registrationId',
  'acceptanceRunId',
  'scenario',
  'accountId',
  'artifactId',
  'artifactDigest',
  'issuedAt',
  'expiresAt',
  'controllerIdentity',
] as const;

function assertKey(key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.byteLength < 32 || key.byteLength > 128) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID');
  }
}

function assertEnvelopeBytes(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  }
  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_TOO_LARGE');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function parseRfc3339Utc(value: unknown): bigint | null {
  if (typeof value !== 'string') return null;
  const match = RFC3339_UTC.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ''] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null;
  }

  const fractionNanoseconds = BigInt(fraction.padEnd(9, '0'));
  return BigInt(date.valueOf()) * NANOSECONDS_PER_MILLISECOND + fractionNanoseconds;
}

function assertPlan(value: unknown): asserts value is ModuleBetaAcceptancePlanV1 {
  const issuedAt = isRecord(value) ? parseRfc3339Utc(value.issuedAt) : null;
  const expiresAt = isRecord(value) ? parseRfc3339Utc(value.expiresAt) : null;
  if (
    !isRecord(value) ||
    !exactKeys(value, PLAN_KEYS) ||
    value.schemaVersion !== 1 ||
    typeof value.registrationId !== 'string' ||
    !UUID.test(value.registrationId) ||
    typeof value.accountId !== 'string' ||
    !UUID.test(value.accountId) ||
    typeof value.artifactId !== 'string' ||
    !UUID.test(value.artifactId) ||
    typeof value.acceptanceRunId !== 'string' ||
    !RUN_ID.test(value.acceptanceRunId) ||
    typeof value.scenario !== 'string' ||
    !SCENARIOS.has(value.scenario as ModuleBetaTrustScenario) ||
    typeof value.artifactDigest !== 'string' ||
    !DIGEST.test(value.artifactDigest) ||
    typeof value.controllerIdentity !== 'string' ||
    !CONTROLLER_IDENTITY.test(value.controllerIdentity) ||
    issuedAt === null ||
    expiresAt === null ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_PLAN_LIFETIME_NANOSECONDS
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(canonicalJson(value));
}

function hmacSha256(bytes: Uint8Array, key: Uint8Array): Buffer {
  return createHmac('sha256', key).update(bytes).digest();
}

function decodeEnvelope(bytes: Uint8Array): ModuleBetaAcceptancePlanEnvelopeV1 {
  let json: string;
  let value: unknown;
  try {
    json = decoder.decode(bytes);
    value = JSON.parse(json);
  } catch {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ['hmacSha256', 'plan']) ||
    typeof value.hmacSha256 !== 'string' ||
    !HMAC_SHA256.test(value.hmacSha256)
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  }
  assertPlan(value.plan);
  if (canonicalJson(value) !== json) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  }
  return value as unknown as ModuleBetaAcceptancePlanEnvelopeV1;
}

export function moduleBetaAcceptanceObjectKey(input: ModuleBetaAcceptanceObjectKeyInput): string {
  if (!isRecord(input)) {
    throw new Error('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');
  }
  const prefix = input.prefix ?? 'developer-trust/acceptance';
  if (
    typeof input.accountId !== 'string' ||
    !UUID.test(input.accountId) ||
    typeof input.artifactId !== 'string' ||
    !UUID.test(input.artifactId) ||
    (input.kind !== 'plan' && input.kind !== 'consumption') ||
    typeof prefix !== 'string' ||
    encoder.encode(prefix).byteLength > 256 ||
    !prefix.split('/').every((segment) => SAFE_PREFIX_SEGMENT.test(segment))
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');
  }
  const accountPartition = createHash('sha256')
    .update(`openopc-module-beta-acceptance\0${input.accountId}`, 'utf8')
    .digest('hex');
  const fileName = input.kind === 'plan' ? 'plan.v1.json' : 'consumption.v1.json';
  return `${prefix}/${accountPartition}/${input.artifactId}/${fileName}`;
}

export function encodeModuleBetaAcceptancePlan(
  plan: ModuleBetaAcceptancePlanV1,
  key: Uint8Array,
): Uint8Array {
  assertKey(key);
  assertPlan(plan);
  const planBytes = canonicalBytes(plan);
  const envelope: ModuleBetaAcceptancePlanEnvelopeV1 = {
    hmacSha256: `sha256:${hmacSha256(planBytes, key).toString('hex')}`,
    plan,
  };
  const bytes = canonicalBytes(envelope);
  assertEnvelopeBytes(bytes);
  return bytes;
}

export function verifyModuleBetaAcceptancePlan(
  bytes: Uint8Array,
  options: VerifyModuleBetaAcceptancePlanOptions,
): ModuleBetaAcceptancePlanV1 {
  const plan = authenticateModuleBetaAcceptancePlan(bytes, options.key);
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.valueOf())) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_NOW_INVALID');
  }
  const now = BigInt(options.now.valueOf()) * NANOSECONDS_PER_MILLISECOND;
  const issuedAt = parseRfc3339Utc(plan.issuedAt) as bigint;
  const expiresAt = parseRfc3339Utc(plan.expiresAt) as bigint;
  if (issuedAt > now + CLOCK_SKEW_NANOSECONDS) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_NOT_YET_VALID');
  }
  if (expiresAt < now - CLOCK_SKEW_NANOSECONDS) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_EXPIRED');
  }
  return plan;
}

export function authenticateModuleBetaAcceptancePlan(
  bytes: Uint8Array,
  key: Uint8Array,
): ModuleBetaAcceptancePlanV1 {
  assertKey(key);
  assertEnvelopeBytes(bytes);
  const envelope = decodeEnvelope(bytes);
  const expected = hmacSha256(canonicalBytes(envelope.plan), key);
  const actual = Buffer.from(envelope.hmacSha256.slice('sha256:'.length), 'hex');
  if (!timingSafeEqual(actual, expected)) {
    throw new Error('MODULE_BETA_ACCEPTANCE_PLAN_MAC_INVALID');
  }
  return structuredClone(envelope.plan);
}
