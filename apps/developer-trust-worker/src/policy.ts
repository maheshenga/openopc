import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RegistryModuleVerificationProfile } from '@kortix/registry';

export type DeveloperTrustScannerName =
  | 'gitleaks'
  | 'syft'
  | 'osv-scanner'
  | 'semgrep'
  | 'license-policy';

export interface DeveloperTrustScannerPolicy {
  name: DeveloperTrustScannerName;
  executable: string;
  imageDigest: `sha256:${string}`;
  version: string;
  ruleDigest: `sha256:${string}`;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface SandboxProfilePolicy {
  profile: RegistryModuleVerificationProfile;
  profileDigest: `sha256:${string}`;
  imageDigest: `sha256:${string}`;
  network: 'none' | 'egress-proxy';
  timeoutMs: number;
  memoryBytes: number;
  cpuMillis: number;
  pidsLimit: number;
}

export interface DeveloperTrustPolicyInput {
  schema: 1;
  policyId: string;
  scanners: readonly DeveloperTrustScannerPolicy[];
  advisorySnapshot: string;
  sandboxProfiles: Readonly<Record<RegistryModuleVerificationProfile, SandboxProfilePolicy>>;
  blockingSeverities: readonly ['critical', 'high'];
}

export interface DeveloperTrustPolicyV1 extends DeveloperTrustPolicyInput {
  policyDigest: `sha256:${string}`;
  scannerSetDigest: `sha256:${string}`;
}

export class DeveloperTrustPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperTrustPolicyError';
  }
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_SCANNERS: readonly DeveloperTrustScannerName[] = [
  'gitleaks',
  'syft',
  'osv-scanner',
  'semgrep',
  'license-policy',
];
const REQUIRED_PROFILES: readonly RegistryModuleVerificationProfile[] = [
  'declarative',
  'agent-project',
  'sandboxed-web',
  'server-conformance',
  'desktop-package',
];

function fail(code: string): never {
  throw new DeveloperTrustPolicyError(code);
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && DIGEST.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DEVELOPER_TRUST_POLICY_INVALID_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  fail('DEVELOPER_TRUST_POLICY_INVALID_JSON');
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateScanner(scanner: DeveloperTrustScannerPolicy): void {
  if (!REQUIRED_SCANNERS.includes(scanner.name)) fail('DEVELOPER_TRUST_POLICY_SCANNER_INVALID');
  if (
    typeof scanner.executable !== 'string' ||
    !isAbsolute(scanner.executable) ||
    scanner.executable.includes('\0') ||
    /[\r\n]/.test(scanner.executable)
  ) {
    fail('DEVELOPER_TRUST_POLICY_EXECUTABLE_INVALID');
  }
  if (!isDigest(scanner.imageDigest) || !isDigest(scanner.ruleDigest)) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_DIGEST_INVALID');
  }
  if (
    typeof scanner.version !== 'string' ||
    scanner.version.length === 0 ||
    scanner.version.length > 128 ||
    /[\r\n]/.test(scanner.version)
  ) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_VERSION_INVALID');
  }
  if (!isPositiveInteger(scanner.timeoutMs) || scanner.timeoutMs > 3_600_000) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_TIMEOUT_INVALID');
  }
  if (!isPositiveInteger(scanner.maxOutputBytes) || scanner.maxOutputBytes > 16 * 1024 * 1024) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_OUTPUT_LIMIT_INVALID');
  }
}

function validateSandboxProfile(
  name: RegistryModuleVerificationProfile,
  profile: SandboxProfilePolicy,
): void {
  if (!profile || profile.profile !== name) fail('DEVELOPER_TRUST_POLICY_PROFILE_INVALID');
  if (!isDigest(profile.profileDigest) || !isDigest(profile.imageDigest)) {
    fail('DEVELOPER_TRUST_POLICY_PROFILE_DIGEST_INVALID');
  }
  if (profile.network !== 'none' && profile.network !== 'egress-proxy') {
    fail('DEVELOPER_TRUST_POLICY_PROFILE_NETWORK_INVALID');
  }
  for (const limit of [
    profile.timeoutMs,
    profile.memoryBytes,
    profile.cpuMillis,
    profile.pidsLimit,
  ]) {
    if (!isPositiveInteger(limit)) fail('DEVELOPER_TRUST_POLICY_PROFILE_LIMIT_INVALID');
  }
}

export function defineDeveloperTrustPolicy(
  input: DeveloperTrustPolicyInput,
): DeveloperTrustPolicyV1 {
  if (!input || input.schema !== 1) fail('DEVELOPER_TRUST_POLICY_SCHEMA_INVALID');
  if (
    typeof input.policyId !== 'string' ||
    input.policyId.length === 0 ||
    input.policyId.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input.policyId)
  ) {
    fail('DEVELOPER_TRUST_POLICY_ID_INVALID');
  }
  if (!Array.isArray(input.scanners) || input.scanners.length !== REQUIRED_SCANNERS.length) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_SET_INVALID');
  }
  const scannerNames = new Set(input.scanners.map((scanner) => scanner.name));
  if (
    scannerNames.size !== REQUIRED_SCANNERS.length ||
    REQUIRED_SCANNERS.some((name) => !scannerNames.has(name))
  ) {
    fail('DEVELOPER_TRUST_POLICY_SCANNER_SET_INVALID');
  }
  for (const scanner of input.scanners) validateScanner(scanner);

  if (
    typeof input.advisorySnapshot !== 'string' ||
    input.advisorySnapshot.length === 0 ||
    input.advisorySnapshot.length > 256 ||
    /[\r\n]/.test(input.advisorySnapshot)
  ) {
    fail('DEVELOPER_TRUST_POLICY_ADVISORY_SNAPSHOT_INVALID');
  }
  const profileNames = Object.keys(input.sandboxProfiles);
  if (
    profileNames.length !== REQUIRED_PROFILES.length ||
    REQUIRED_PROFILES.some((name) => !Object.hasOwn(input.sandboxProfiles, name))
  ) {
    fail('DEVELOPER_TRUST_POLICY_PROFILE_SET_INVALID');
  }
  for (const name of REQUIRED_PROFILES) validateSandboxProfile(name, input.sandboxProfiles[name]);
  if (
    input.blockingSeverities.length !== 2 ||
    input.blockingSeverities[0] !== 'critical' ||
    input.blockingSeverities[1] !== 'high'
  ) {
    fail('DEVELOPER_TRUST_POLICY_BLOCKING_SEVERITIES_INVALID');
  }

  const scannersByName = new Map(input.scanners.map((scanner) => [scanner.name, scanner]));
  const scanners = REQUIRED_SCANNERS.map((name) => {
    const scanner = scannersByName.get(name);
    if (!scanner) fail('DEVELOPER_TRUST_POLICY_SCANNER_SET_INVALID');
    return { ...scanner };
  });
  const sandboxProfiles = Object.fromEntries(
    REQUIRED_PROFILES.map((name) => [name, { ...input.sandboxProfiles[name] }]),
  ) as Record<RegistryModuleVerificationProfile, SandboxProfilePolicy>;
  const normalized: DeveloperTrustPolicyInput = {
    schema: 1,
    policyId: input.policyId,
    scanners,
    advisorySnapshot: input.advisorySnapshot,
    sandboxProfiles,
    blockingSeverities: ['critical', 'high'],
  };
  const scannerSetDigest = sha256(scanners);
  const policy: DeveloperTrustPolicyV1 = {
    ...normalized,
    policyDigest: sha256({ ...normalized, scannerSetDigest }),
    scannerSetDigest,
  };
  return deepFreeze(policy) as DeveloperTrustPolicyV1;
}

export function assertDeveloperTrustPolicyClaim(
  policy: DeveloperTrustPolicyV1,
  claim: {
    policyDigest: `sha256:${string}`;
    scannerSetDigest: `sha256:${string}`;
    sandboxProfileDigest: `sha256:${string}`;
    verificationProfile: RegistryModuleVerificationProfile;
  },
): void {
  if (claim.policyDigest !== policy.policyDigest) {
    fail('DEVELOPER_TRUST_POLICY_DIGEST_MISMATCH');
  }
  if (claim.scannerSetDigest !== policy.scannerSetDigest) {
    fail('DEVELOPER_TRUST_SCANNER_SET_DIGEST_MISMATCH');
  }
  const profile = policy.sandboxProfiles[claim.verificationProfile];
  if (!profile || claim.sandboxProfileDigest !== profile.profileDigest) {
    fail('DEVELOPER_TRUST_SANDBOX_PROFILE_DIGEST_MISMATCH');
  }
}
