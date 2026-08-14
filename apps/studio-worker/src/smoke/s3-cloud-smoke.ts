/**
 * Multi-target S3-compatible cloud storage smoke policy.
 *
 * The Studio object store is a single endpoint-driven S3 driver. Which cloud a
 * deployment points it at changes three provider facts: whether path-style
 * addressing is required or forbidden, which server-side encryption modes are
 * valid, and whether ExpectedBucketOwner checks are supported. This module owns
 * that matrix plus the exact-prefix safety discipline, so each target smoke
 * runs with the same guarantees as the original Alibaba OSS smoke.
 */

export type S3CloudSmokeTarget = 'aliyun-oss' | 'tencent-cos' | 'cloudflare-r2';

export type S3CloudSmokeSse = 'none' | 'AES256' | 'aws:kms';

export interface S3CloudSmokeProfile {
  readonly target: S3CloudSmokeTarget;
  /** Environment gate that must be exactly 'true' to run this target. */
  readonly gateEnvironment: string;
  /**
   * Path-style addressing policy:
   * - 'required-true': the endpoint only supports path-style (Alibaba OSS).
   * - 'required-false': the endpoint rejects path-style (Cloudflare R2).
   * - 'any': both addressing styles are accepted (Tencent COS).
   */
  readonly forcePathStyle: 'required-true' | 'any' | 'required-false';
  readonly sseAllowed: readonly S3CloudSmokeSse[];
  readonly ownerCheckAllowed: boolean;
}

export const S3_CLOUD_SMOKE_PROFILES: Record<S3CloudSmokeTarget, S3CloudSmokeProfile> = {
  'aliyun-oss': {
    target: 'aliyun-oss',
    gateEnvironment: 'STUDIO_ALIYUN_OSS_SMOKE',
    forcePathStyle: 'required-true',
    sseAllowed: ['AES256', 'aws:kms'],
    ownerCheckAllowed: true,
  },
  'tencent-cos': {
    target: 'tencent-cos',
    gateEnvironment: 'STUDIO_TENCENT_COS_SMOKE',
    forcePathStyle: 'any',
    // COS SSE-COS is operator-verified per bucket; this smoke asserts plain
    // transfer integrity only and forbids AWS-style SSE header injection.
    sseAllowed: ['none'],
    ownerCheckAllowed: false,
  },
  'cloudflare-r2': {
    target: 'cloudflare-r2',
    gateEnvironment: 'STUDIO_CLOUDFLARE_R2_SMOKE',
    // R2 requires virtual-host style and encrypts at rest by default.
    forcePathStyle: 'required-false',
    sseAllowed: ['none'],
    ownerCheckAllowed: false,
  },
};

export type S3CloudSmokeEnvironment = Record<string, string | undefined>;

export interface S3CloudSmokeConfig {
  readonly endpoint: URL;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly forcePathStyle: boolean;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sse: S3CloudSmokeSse;
  readonly kmsKeyId: string | undefined;
  readonly expectedOwner: string | undefined;
  readonly expectedOwnerSupported: boolean;
  readonly profile: S3CloudSmokeProfile;
}

const SMOKE_PREFIX_RE = /^[a-z0-9][a-z0-9/_-]{2,120}$/i;

/** Returns the selected target, or null when no smoke gate is armed. */
export function selectS3CloudSmokeTarget(env: S3CloudSmokeEnvironment): S3CloudSmokeTarget | null {
  const armed = Object.values(S3_CLOUD_SMOKE_PROFILES)
    .filter((profile) => env[profile.gateEnvironment] === 'true')
    .map((profile) => profile.target);
  if (armed.length === 0) return null;
  if (armed.length > 1) {
    throw new Error('exactly one cloud smoke gate may be armed at a time');
  }
  const explicit = env.STUDIO_S3_SMOKE_TARGET?.trim();
  if (explicit && explicit !== armed[0]) {
    throw new Error('STUDIO_S3_SMOKE_TARGET does not match the armed gate');
  }
  return armed[0];
}

export function loadS3CloudSmokeConfig(
  env: S3CloudSmokeEnvironment,
  target: S3CloudSmokeTarget,
): S3CloudSmokeConfig {
  const profile = S3_CLOUD_SMOKE_PROFILES[target];
  const endpoint = new URL(requiredEnvironment(env, 'STUDIO_S3_ENDPOINT'));
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('STUDIO_S3_ENDPOINT must be a clean HTTPS origin');
  }
  if (requiredEnvironment(env, 'STUDIO_OBJECT_STORE_MODE') !== 's3') {
    throw new Error('STUDIO_OBJECT_STORE_MODE must be s3');
  }
  const forcePathStyleValue = requiredEnvironment(env, 'STUDIO_S3_FORCE_PATH_STYLE');
  if (forcePathStyleValue !== 'true' && forcePathStyleValue !== 'false') {
    throw new Error('STUDIO_S3_FORCE_PATH_STYLE must be true or false');
  }
  const forcePathStyle = forcePathStyleValue === 'true';
  if (profile.forcePathStyle === 'required-true' && !forcePathStyle) {
    throw new Error(profile.target + ' requires STUDIO_S3_FORCE_PATH_STYLE=true');
  }
  if (profile.forcePathStyle === 'required-false' && forcePathStyle) {
    throw new Error(profile.target + ' forbids path-style addressing');
  }
  const sseValue = requiredEnvironment(env, 'STUDIO_S3_SSE') as S3CloudSmokeSse;
  if (!profile.sseAllowed.includes(sseValue)) {
    throw new Error('STUDIO_S3_SSE=' + sseValue + ' is not valid for ' + profile.target);
  }
  const objectStorePrefix = requiredEnvironment(env, 'STUDIO_OBJECT_STORE_PREFIX').replace(
    /\/$/,
    '',
  );
  const prefix = requiredEnvironment(env, 'STUDIO_S3_SMOKE_PREFIX').replace(/\/$/, '');
  const expectedPrefix = objectStorePrefix + '/studio-smoke/';
  if (!prefix.startsWith(expectedPrefix) || !SMOKE_PREFIX_RE.test(prefix) || prefix.includes('..')) {
    throw new Error('STUDIO_S3_SMOKE_PREFIX must be an exact dedicated object-store prefix');
  }
  if (env.STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION !== 'EXACT_PREFIX_ONLY') {
    throw new Error('exact-prefix cleanup confirmation is required');
  }
  const expectedOwnerSupported = env.STUDIO_S3_SMOKE_EXPECTED_BUCKET_OWNER_SUPPORTED === 'true';
  if (expectedOwnerSupported && !profile.ownerCheckAllowed) {
    throw new Error(profile.target + ' does not support ExpectedBucketOwner checks');
  }
  const configuredExpectedOwner = env.STUDIO_S3_EXPECTED_BUCKET_OWNER?.trim();
  if (expectedOwnerSupported && !configuredExpectedOwner) {
    throw new Error('STUDIO_S3_EXPECTED_BUCKET_OWNER is required when owner checks are supported');
  }
  const kmsKeyId = env.STUDIO_S3_KMS_KEY_ID?.trim() || undefined;
  if (sseValue === 'aws:kms' && !kmsKeyId) {
    throw new Error('STUDIO_S3_KMS_KEY_ID is required for aws:kms');
  }
  if (sseValue !== 'aws:kms' && kmsKeyId) {
    throw new Error('STUDIO_S3_KMS_KEY_ID is forbidden unless STUDIO_S3_SSE is aws:kms');
  }
  return {
    endpoint,
    region: requiredEnvironment(env, 'STUDIO_S3_REGION'),
    bucket: requiredEnvironment(env, 'STUDIO_OBJECT_STORE_BUCKET'),
    prefix,
    forcePathStyle,
    accessKeyId: requiredEnvironment(env, 'STUDIO_S3_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironment(env, 'STUDIO_S3_SECRET_ACCESS_KEY'),
    sse: sseValue,
    kmsKeyId,
    expectedOwner: expectedOwnerSupported ? configuredExpectedOwner : undefined,
    expectedOwnerSupported,
    profile,
  };
}

function requiredEnvironment(env: S3CloudSmokeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + ' is required');
  return value;
}
