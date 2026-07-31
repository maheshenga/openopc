import {
  type PublicBetaSha256Digest,
  canonicalPublicBetaJson,
  computeCanonicalPublicBetaDigest,
} from './public-beta-canonical-json';

const PROFILE_ID = 'openopc-restricted-public-beta-v1' as const;
const PROFILE_KEYS = [
  'artifacts',
  'deferredGates',
  'id',
  'requiredGates',
  'schemaVersion',
] as const;
const ARTIFACTS = Object.freeze([
  'web',
  'admin',
  'api',
  'studio-worker',
  'developer-trust-worker',
  'wasi-runner',
  'desktop',
] as const);
const REQUIRED_GATES = Object.freeze([
  'G1',
  'G2',
  'G3',
  'G4',
  'G5',
  'G8',
  'G10',
  'G11',
  'G12',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B7',
  'B8',
  'B9',
  'B10',
] as const);
const DEFERRED_GATES = Object.freeze(['G6', 'G7', 'G9', 'B6'] as const);

export interface OpenOpcRestrictedPublicBetaProfileV1 {
  schemaVersion: 1;
  id: typeof PROFILE_ID;
  artifacts: typeof ARTIFACTS;
  requiredGates: typeof REQUIRED_GATES;
  deferredGates: typeof DEFERRED_GATES;
}

function invalidProfile(): never {
  throw new Error('OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_INVALID');
}

function exactTuple(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value);
  if (
    names.length !== expected.length + 1 ||
    names.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(name))
  ) {
    return false;
  }
  return expected.every((item, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    return descriptor?.enumerable === true && 'value' in descriptor && descriptor.value === item;
  });
}

function exactProfileRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const names = Object.getOwnPropertyNames(value).sort();
  if (names.length !== PROFILE_KEYS.length || names.some((name, index) => name !== PROFILE_KEYS[index])) {
    return false;
  }
  return names.every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE: OpenOpcRestrictedPublicBetaProfileV1 =
  Object.freeze({
    schemaVersion: 1,
    id: PROFILE_ID,
    artifacts: ARTIFACTS,
    requiredGates: REQUIRED_GATES,
    deferredGates: DEFERRED_GATES,
  });

export function parseOpenOpcRestrictedPublicBetaProfile(
  value: unknown,
): OpenOpcRestrictedPublicBetaProfileV1 {
  try {
    if (
      !exactProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      value.id !== PROFILE_ID ||
      !exactTuple(value.artifacts, ARTIFACTS) ||
      !exactTuple(value.requiredGates, REQUIRED_GATES) ||
      !exactTuple(value.deferredGates, DEFERRED_GATES)
    ) {
      invalidProfile();
    }
    return OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_INVALID'
    ) {
      throw error;
    }
    invalidProfile();
  }
}

export function computeOpenOpcRestrictedPublicBetaProfileDigest(
  profile: unknown,
): PublicBetaSha256Digest {
  const parsed = parseOpenOpcRestrictedPublicBetaProfile(profile);
  canonicalPublicBetaJson(parsed);
  return computeCanonicalPublicBetaDigest(parsed);
}

export const OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE_DIGEST =
  computeOpenOpcRestrictedPublicBetaProfileDigest(OPENOPC_RESTRICTED_PUBLIC_BETA_PROFILE);
