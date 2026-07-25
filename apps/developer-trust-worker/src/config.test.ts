import { expect, test } from 'bun:test';

import { loadDeveloperTrustWorkerConfig } from './config';
import { policyInput } from './test-fixtures';

function enabledEnvironment(environment = 'staging'): Record<string, string> {
  const root = process.platform === 'win32' ? 'C:/openopc/secrets' : '/run/secrets';
  const bin =
    process.platform === 'win32' ? 'C:/openopc/bin/wasmtime.exe' : '/opt/openopc/bin/wasmtime';
  return {
    DEVELOPER_TRUST_ENABLED: 'true',
    DEVELOPER_TRUST_ENVIRONMENT: environment,
    DEVELOPER_TRUST_WORKER_ID: 'trust-worker-1',
    DEVELOPER_TRUST_LEASE_MS: '30000',
    DEVELOPER_TRUST_POLL_MS: '1000',
    DEVELOPER_TRUST_POLICY_JSON: JSON.stringify(policyInput()),
    DEVELOPER_TRUST_DATABASE_URL_FILE: `${root}/database-url`,
    DEVELOPER_TRUST_S3_ENDPOINT: 'http://minio:9000',
    DEVELOPER_TRUST_S3_REGION: 'us-east-1',
    DEVELOPER_TRUST_S3_BUCKET: 'developer-artifacts',
    DEVELOPER_TRUST_S3_ACCESS_KEY_ID_FILE: `${root}/s3-access-key-id`,
    DEVELOPER_TRUST_S3_SECRET_ACCESS_KEY_FILE: `${root}/s3-secret-access-key`,
    DEVELOPER_TRUST_S3_FORCE_PATH_STYLE: 'true',
    DEVELOPER_TRUST_WORKSPACE_ROOT: process.env.TEMP ?? '/tmp',
    DEVELOPER_TRUST_SEMGREP_RULES_FILE:
      process.platform === 'win32'
        ? 'C:/openopc/policies/semgrep.yml'
        : '/opt/openopc/policies/semgrep.yml',
    DEVELOPER_TRUST_ATTESTATION_PRIVATE_KEY_FILE: `${root}/attestation.pk8`,
    DEVELOPER_TRUST_ATTESTATION_PUBLIC_KEY_FILE: `${root}/attestation.spki`,
    DEVELOPER_TRUST_ATTESTATION_KEY_ID: 'openopc-attestation-staging-2026-07',
    DEVELOPER_TRUST_ATTESTATION_ISSUER: 'openopc-developer-trust-staging',
    DEVELOPER_TRUST_WASMTIME_EXECUTABLE: bin,
    DEVELOPER_TRUST_WASMTIME_DIGEST: `sha256:${'a'.repeat(64)}`,
    DEVELOPER_TRUST_WASMTIME_VERSION: 'wasmtime 47.0.2 (90fed3c6a 2026-07-21)',
    DEVELOPER_TRUST_OCI_CONTROL_ENDPOINT: 'http://runner:8090',
    DEVELOPER_TRUST_OCI_CONTROL_TOKEN_FILE: `${root}/oci-control-token`,
    DEVELOPER_TRUST_VERIFICATION_BROKER_URL: 'http://capability-broker:8091',
    DEVELOPER_TRUST_ALLOWED_LICENSES_JSON: '["Apache-2.0","MIT"]',
  };
}

test('enabled config is complete, secret-file based, and non-production only', () => {
  const config = loadDeveloperTrustWorkerConfig(enabledEnvironment());
  if (!config.enabled) throw new Error('expected enabled config');
  expect(config).toMatchObject({
    enabled: true,
    environment: 'staging',
    workerId: 'trust-worker-1',
    s3: { bucket: 'developer-artifacts', forcePathStyle: true },
    attestation: { keyId: 'openopc-attestation-staging-2026-07' },
    wasmtime: { expectedVersion: 'wasmtime 47.0.2 (90fed3c6a 2026-07-21)' },
    allowedLicenses: ['Apache-2.0', 'MIT'],
  });
  expect(config.s3).not.toHaveProperty('secretAccessKey');
  expect(config).not.toHaveProperty('databaseUrl');
  expect(() => loadDeveloperTrustWorkerConfig(enabledEnvironment('production'))).toThrow(
    'DEVELOPER_TRUST_CONFIG_INVALID',
  );
});
