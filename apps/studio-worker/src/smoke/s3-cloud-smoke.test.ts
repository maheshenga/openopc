import { describe, expect, test } from 'bun:test';

import {
  loadS3CloudSmokeConfig,
  S3_CLOUD_SMOKE_PROFILES,
  selectS3CloudSmokeTarget,
  type S3CloudSmokeEnvironment,
  type S3CloudSmokeTarget,
} from './s3-cloud-smoke';

function baseEnv(overrides: Record<string, string> = {}): S3CloudSmokeEnvironment {
  return {
    STUDIO_OBJECT_STORE_MODE: 's3',
    STUDIO_S3_ENDPOINT: 'https://smoke.example.com',
    STUDIO_S3_REGION: 'cn-hangzhou',
    STUDIO_OBJECT_STORE_BUCKET: 'studio-smoke-bucket',
    STUDIO_OBJECT_STORE_PREFIX: 'studio',
    STUDIO_S3_FORCE_PATH_STYLE: 'true',
    STUDIO_S3_SSE: 'AES256',
    STUDIO_S3_ACCESS_KEY_ID: 'smoke-access',
    STUDIO_S3_SECRET_ACCESS_KEY: 'smoke-secret',
    STUDIO_S3_SMOKE_PREFIX: 'studio/studio-smoke/change-123',
    STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION: 'EXACT_PREFIX_ONLY',
    ...overrides,
  };
}

describe('selectS3CloudSmokeTarget', () => {
  test('returns null when no gate is armed', () => {
    expect(selectS3CloudSmokeTarget(baseEnv())).toBeNull();
  });

  test('selects the single armed gate', () => {
    expect(selectS3CloudSmokeTarget(baseEnv({ STUDIO_TENCENT_COS_SMOKE: 'true' }))).toBe(
      'tencent-cos',
    );
  });

  test('rejects multiple armed gates', () => {
    expect(() => selectS3CloudSmokeTarget(baseEnv({ STUDIO_TENCENT_COS_SMOKE: 'true', STUDIO_CLOUDFLARE_R2_SMOKE: 'true' }))).toThrow(
      'exactly one',
    );
  });

  test('rejects an explicit target that mismatches the gate', () => {
    expect(() =>
      selectS3CloudSmokeTarget(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SMOKE_TARGET: 'cloudflare-r2' })),
    ).toThrow('does not match');
  });
});

describe('loadS3CloudSmokeConfig', () => {
  test('loads the aliyun-oss profile with AES256', () => {
    const config = loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true' }), 'aliyun-oss');
    expect(config.forcePathStyle).toBe(true);
    expect(config.sse).toBe('AES256');
    expect(config.kmsKeyId).toBeUndefined();
    expect(config.expectedOwner).toBeUndefined();
    expect(config.profile.target).toBe('aliyun-oss');
  });

  test('aliyun-oss with aws:kms requires and carries the KMS key', () => {
    const config = loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SSE: 'aws:kms', STUDIO_S3_KMS_KEY_ID: 'kms-key-1' }), 'aliyun-oss');
    expect(config.sse).toBe('aws:kms');
    expect(config.kmsKeyId).toBe('kms-key-1');
  });

  test('rejects aws:kms without a KMS key and a KMS key without aws:kms', () => {
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SSE: 'aws:kms' }), 'aliyun-oss')).toThrow('KMS_KEY_ID');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_KMS_KEY_ID: 'kms-key-1' }), 'aliyun-oss')).toThrow('forbidden');
  });

  test('rejects path-style=false for aliyun-oss', () => {
    expect(() =>
      loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_FORCE_PATH_STYLE: 'false' }), 'aliyun-oss'),
    ).toThrow('requires STUDIO_S3_FORCE_PATH_STYLE=true');
  });

  test('tencent-cos accepts either addressing style and only none SSE', () => {
    const virtual = loadS3CloudSmokeConfig(baseEnv({ STUDIO_TENCENT_COS_SMOKE: 'true', STUDIO_S3_FORCE_PATH_STYLE: 'false', STUDIO_S3_SSE: 'none' }), 'tencent-cos');
    expect(virtual.forcePathStyle).toBe(false);
    expect(virtual.sse).toBe('none');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_TENCENT_COS_SMOKE: 'true', STUDIO_S3_SSE: 'AES256' }), 'tencent-cos')).toThrow('not valid');
  });

  test('cloudflare-r2 forbids path-style and SSE headers', () => {
    expect(() =>
      loadS3CloudSmokeConfig(baseEnv({ STUDIO_CLOUDFLARE_R2_SMOKE: 'true', STUDIO_S3_SSE: 'none' }), 'cloudflare-r2'),
    ).toThrow('forbids path-style');
    const config = loadS3CloudSmokeConfig(baseEnv({ STUDIO_CLOUDFLARE_R2_SMOKE: 'true', STUDIO_S3_FORCE_PATH_STYLE: 'false', STUDIO_S3_SSE: 'none' }), 'cloudflare-r2');
    expect(config.forcePathStyle).toBe(false);
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_CLOUDFLARE_R2_SMOKE: 'true', STUDIO_S3_FORCE_PATH_STYLE: 'false', STUDIO_S3_SSE: 'aws:kms' }), 'cloudflare-r2')).toThrow('not valid');
  });

  test('owner checks are only allowed on the aliyun-oss profile', () => {
    const owner = loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SMOKE_EXPECTED_BUCKET_OWNER_SUPPORTED: 'true', STUDIO_S3_EXPECTED_BUCKET_OWNER: '000000000000' }), 'aliyun-oss');
    expect(owner.expectedOwner).toBe('000000000000');
    expect(() =>
      loadS3CloudSmokeConfig(baseEnv({ STUDIO_TENCENT_COS_SMOKE: 'true', STUDIO_S3_SSE: 'none', STUDIO_S3_SMOKE_EXPECTED_BUCKET_OWNER_SUPPORTED: 'true', STUDIO_S3_EXPECTED_BUCKET_OWNER: '000000000000' }), 'tencent-cos'),
    ).toThrow('does not support');
  });

  test('enforces the exact dedicated prefix and cleanup confirmation', () => {
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SMOKE_PREFIX: 'other-prefix/smoke' }), 'aliyun-oss')).toThrow('dedicated');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SMOKE_PREFIX: 'studio/studio-smoke/../x' }), 'aliyun-oss')).toThrow('dedicated');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_SMOKE_CLEANUP_CONFIRMATION: 'YES' }), 'aliyun-oss')).toThrow('confirmation');
  });

  test('rejects non-HTTPS or credentialed endpoints and non-s3 mode', () => {
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_ENDPOINT: 'http://smoke.example.com' }), 'aliyun-oss')).toThrow('HTTPS');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_S3_ENDPOINT: 'https://user:pass@smoke.example.com' }), 'aliyun-oss')).toThrow('HTTPS');
    expect(() => loadS3CloudSmokeConfig(baseEnv({ STUDIO_ALIYUN_OSS_SMOKE: 'true', STUDIO_OBJECT_STORE_MODE: 'memory' }), 'aliyun-oss')).toThrow('must be s3');
  });

  test('every profile declares a unique gate environment', () => {
    const gates = Object.values(S3_CLOUD_SMOKE_PROFILES).map((profile) => profile.gateEnvironment);
    expect(new Set(gates).size).toBe(gates.length);
    const targets: S3CloudSmokeTarget[] = ['aliyun-oss', 'tencent-cos', 'cloudflare-r2'];
    expect(gates.length).toBe(targets.length);
  });
});
