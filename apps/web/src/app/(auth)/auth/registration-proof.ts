export interface RegistrationPolicyVersions {
  terms: string;
  privacy: string;
  acceptableUse: string;
}

interface RegistrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const DEVICE_STORAGE_KEY = 'openopc.registration.device-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED_VERSIONS = new Set(['latest', 'current', 'draft', 'unpublished']);

function validVersion(value: string): boolean {
  return VERSION.test(value) && !RESERVED_VERSIONS.has(value.toLowerCase());
}

export function getOrCreateRegistrationDeviceId(
  storage: RegistrationStorage,
  randomUuid: () => string,
): string | null {
  try {
    const existing = storage.getItem(DEVICE_STORAGE_KEY);
    if (existing && UUID.test(existing)) return existing;
    const generated = randomUuid();
    if (!UUID.test(generated)) return null;
    storage.setItem(DEVICE_STORAGE_KEY, generated);
    return generated;
  } catch {
    return null;
  }
}

export function buildRegistrationProofFields(input: {
  challengeToken: string;
  deviceId: string;
  policyVersions: RegistrationPolicyVersions;
}):
  | {
      challengeToken: string;
      deviceId: string;
      policyTermsVersion: string;
      policyPrivacyVersion: string;
      policyAcceptableUseVersion: string;
    }
  | null {
  if (
    !input.challengeToken ||
    input.challengeToken.trim() !== input.challengeToken ||
    input.challengeToken.length > 4_096 ||
    !UUID.test(input.deviceId) ||
    !validVersion(input.policyVersions.terms) ||
    !validVersion(input.policyVersions.privacy) ||
    !validVersion(input.policyVersions.acceptableUse)
  ) {
    return null;
  }
  return {
    challengeToken: input.challengeToken,
    deviceId: input.deviceId,
    policyTermsVersion: input.policyVersions.terms,
    policyPrivacyVersion: input.policyVersions.privacy,
    policyAcceptableUseVersion: input.policyVersions.acceptableUse,
  };
}
