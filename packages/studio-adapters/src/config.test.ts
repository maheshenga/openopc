import { describe, expect, test } from 'bun:test';
import { parseStudioAdapterEnvironment } from './config';

const S3_BASE = {
  STUDIO_ENABLED: 'true',
  STUDIO_OBJECT_STORE_MODE: 's3',
  STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
  STUDIO_OBJECT_STORE_PREFIX: 'studio',
  STUDIO_S3_ENDPOINT: 'https://s3.example.test',
  STUDIO_S3_REGION: 'us-east-1',
  STUDIO_S3_FORCE_PATH_STYLE: 'false',
  STUDIO_S3_CREDENTIAL_MODE: 'default-chain',
  STUDIO_S3_SSE: 'AES256',
} as const;

describe('parseStudioAdapterEnvironment', () => {
  test('returns disabled before validating provider or storage fields', () => {
    expect(
      parseStudioAdapterEnvironment({
        STUDIO_ENABLED: 'false',
        STUDIO_S3_SECRET_ACCESS_KEY: 'must-not-appear',
        STUDIO_S3_ENDPOINT: 'not-a-url',
      }),
    ).toEqual({ enabled: false });
  });

  test('allows the fake provider with explicitly ephemeral memory storage', () => {
    expect(
      parseStudioAdapterEnvironment({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toEqual({
      enabled: true,
      fakeProviderEnabled: true,
      openAiCompatibleEnabled: false,
      storage: { mode: 'memory', namespace: 'studio-memory', ephemeral: true },
      privateProviderOrigins: [],
      allowInsecureLocalEndpoints: false,
    });
  });

  test('allows fake and production provider registrations with S3 storage', () => {
    const fake = parseStudioAdapterEnvironment({
      ...S3_BASE,
      STUDIO_FAKE_PROVIDER_ENABLED: 'true',
      STUDIO_S3_PUBLIC_ENDPOINT: 'https://assets.example.test',
      STUDIO_S3_EXPECTED_BUCKET_OWNER: '123456789012',
    });
    const production = parseStudioAdapterEnvironment({
      ...S3_BASE,
      STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
      STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST:
        'https://provider.internal.example, https://backup.internal.example:8443',
    });

    expect(fake).toMatchObject({
      enabled: true,
      fakeProviderEnabled: true,
      openAiCompatibleEnabled: false,
      storage: {
        mode: 's3',
        bucket: 'studio-private',
        prefix: 'studio',
        endpoint: new URL('https://s3.example.test'),
        publicEndpoint: new URL('https://assets.example.test'),
        region: 'us-east-1',
        forcePathStyle: false,
        expectedBucketOwner: '123456789012',
        credentialMode: 'default-chain',
        accessKeyId: null,
        secretAccessKey: null,
        sessionToken: null,
        sse: 'AES256',
        kmsKeyId: null,
      },
    });
    expect(production).toMatchObject({
      enabled: true,
      fakeProviderEnabled: false,
      openAiCompatibleEnabled: true,
      privateProviderOrigins: [
        'https://provider.internal.example',
        'https://backup.internal.example:8443',
      ],
    });
  });

  test('rejects production memory storage outside tests but permits an explicit test runtime', () => {
    const env = {
      STUDIO_ENABLED: 'true',
      STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 'memory',
      STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
    };

    expect(() => parseStudioAdapterEnvironment(env)).toThrow(
      'STUDIO_OPENAI_COMPATIBLE_ENABLED, STUDIO_OBJECT_STORE_MODE',
    );
    expect(parseStudioAdapterEnvironment(env, { test: true })).toMatchObject({
      enabled: true,
      openAiCompatibleEnabled: true,
      storage: { mode: 'memory' },
    });
  });

  test('requires both static S3 credential fields without leaking either value', () => {
    const secret = 'secret-value-must-not-leak';
    const access = 'access-value-must-not-leak';
    for (const env of [
      {
        ...S3_BASE,
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_ACCESS_KEY_ID: access,
      },
      {
        ...S3_BASE,
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
      },
    ]) {
      let message = '';
      try {
        parseStudioAdapterEnvironment(env);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('STUDIO_S3_');
      expect(message).not.toContain(secret);
      expect(message).not.toContain(access);
    }
  });

  test('requires a KMS key ID when aws:kms encryption is selected', () => {
    expect(() =>
      parseStudioAdapterEnvironment({
        ...S3_BASE,
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_S3_SSE: 'aws:kms',
      }),
    ).toThrow('STUDIO_S3_KMS_KEY_ID');
  });

  test('rejects insecure endpoints unless the explicit flag is authorized for tests', () => {
    const env = {
      ...S3_BASE,
      STUDIO_FAKE_PROVIDER_ENABLED: 'true',
      STUDIO_S3_ENDPOINT: 'http://127.0.0.1:9000',
      STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS: 'true',
    };

    expect(() => parseStudioAdapterEnvironment(env)).toThrow(
      'STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS, STUDIO_S3_ENDPOINT',
    );
    expect(parseStudioAdapterEnvironment(env, { test: true })).toMatchObject({
      enabled: true,
      allowInsecureLocalEndpoints: true,
      storage: { endpoint: new URL('http://127.0.0.1:9000') },
    });
  });

  test('rejects memory without explicit ephemeral consent and enabled mode without a provider', () => {
    expect(() =>
      parseStudioAdapterEnvironment({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
      }),
    ).toThrow('STUDIO_ALLOW_EPHEMERAL_STORAGE');
    expect(() => parseStudioAdapterEnvironment({ ...S3_BASE })).toThrow(
      'STUDIO_FAKE_PROVIDER_ENABLED, STUDIO_OPENAI_COMPATIBLE_ENABLED',
    );
  });

  test('reports only field names when raw environment values are malformed', () => {
    const secret = 'malformed-secret-value';
    let message = '';
    try {
      parseStudioAdapterEnvironment({
        ...S3_BASE,
        STUDIO_FAKE_PROVIDER_ENABLED: 'not-a-boolean',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('STUDIO_FAKE_PROVIDER_ENABLED');
    expect(message).not.toContain('not-a-boolean');
    expect(message).not.toContain(secret);
  });
});
