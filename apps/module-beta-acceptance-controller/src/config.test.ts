import { expect, test } from 'bun:test';

import { loadModuleBetaAcceptanceConfig } from './config';

const validEnvironment = {
  MODULE_BETA_ACCEPTANCE_ENABLED: 'true',
  MODULE_BETA_ACCEPTANCE_ENVIRONMENT: 'staging',
  MODULE_BETA_ACCEPTANCE_IDENTITY: `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`,
  MODULE_BETA_ACCEPTANCE_TOKEN_FILE: 'C:\\openopc-secrets\\acceptance-token',
  MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE: 'C:\\openopc-secrets\\fault-key',
  MODULE_BETA_ACCEPTANCE_DATABASE_URL_FILE: 'C:\\openopc-secrets\\database-url',
  MODULE_BETA_ACCEPTANCE_S3_ENDPOINT: 'https://minio.staging.openopc.internal',
  MODULE_BETA_ACCEPTANCE_S3_REGION: 'us-east-1',
  MODULE_BETA_ACCEPTANCE_S3_BUCKET: 'developer-artifacts',
  MODULE_BETA_ACCEPTANCE_S3_ACCESS_KEY_ID_FILE: 'C:\\openopc-secrets\\s3-access-key-id',
  MODULE_BETA_ACCEPTANCE_S3_SECRET_ACCESS_KEY_FILE: 'C:\\openopc-secrets\\s3-secret-access-key',
  MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE: 'true',
  MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION: 'AES256',
  MODULE_BETA_ACCEPTANCE_PLAN_TTL_SECONDS: '600',
  MODULE_BETA_ACCEPTANCE_PRESIGN_TTL_SECONDS: '300',
  MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS: '5000',
  MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON: JSON.stringify([
    'minio.staging.openopc.internal',
  ]),
  MODULE_BETA_ACCEPTANCE_PORT: '8081',
};

test('is disabled by default without reading staging secrets', () => {
  expect(loadModuleBetaAcceptanceConfig({})).toEqual({
    enabled: false,
    port: 8081,
  });
});

test('loads only an explicit staging acceptance composition', () => {
  const config = loadModuleBetaAcceptanceConfig(validEnvironment);
  expect(config).toMatchObject({
    enabled: true,
    environment: 'staging',
    controllerIdentity: validEnvironment.MODULE_BETA_ACCEPTANCE_IDENTITY,
    planTtlSeconds: 600,
    presignTtlSeconds: 300,
    retentionProbeGraceMs: 5_000,
    allowedPresignHosts: ['minio.staging.openopc.internal'],
    port: 8081,
    s3: {
      endpoint: 'https://minio.staging.openopc.internal',
      bucket: 'developer-artifacts',
      forcePathStyle: true,
      serverSideEncryption: 'AES256',
    },
  });
});

test('rejects production, partial enablement, plaintext secret values, and mutable identities', () => {
  for (const environment of [
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_ENVIRONMENT: 'production' },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_ENVIRONMENT: 'test' },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_TOKEN_FILE: undefined },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON: undefined },
    {
      ...validEnvironment,
      MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON: '["minio.staging.openopc.internal:444"]',
    },
    {
      ...validEnvironment,
      MODULE_BETA_ACCEPTANCE_TOKEN_FILE: '/run/secrets/token',
      MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE: 'plaintext-secret-value',
    },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_IDENTITY: 'module-beta-controller:latest' },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION: undefined },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION: 'aws:kms' },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS: '999' },
    { ...validEnvironment, MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS: '300001' },
  ]) {
    expect(() => loadModuleBetaAcceptanceConfig(environment)).toThrow(
      'MODULE_BETA_ACCEPTANCE_CONFIG_INVALID',
    );
  }
});
