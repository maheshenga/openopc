import { describe, expect, test } from 'bun:test';
import { buildStudioWorkerRuntime } from './runtime';

describe('Studio worker runtime assembly', () => {
  test('leaves Studio disabled without requiring storage or provider configuration', () => {
    expect(buildStudioWorkerRuntime({ STUDIO_ENABLED: 'false' })).toEqual({ enabled: false });
  });

  test('allows explicitly ephemeral fake storage and rejects production memory with OpenAI', () => {
    expect(
      buildStudioWorkerRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toMatchObject({ enabled: true, storageMode: 'memory', fakeProviderEnabled: true });

    expect(() =>
      buildStudioWorkerRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toThrow(/STUDIO_OPENAI_COMPATIBLE_ENABLED/);
  });

  test('uses the shared S3 adapter configuration and redacts static credential failures', () => {
    const secret = 'worker-static-secret';
    expect(() =>
      buildStudioWorkerRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 's3',
        STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
        STUDIO_OBJECT_STORE_PREFIX: 'studio',
        STUDIO_S3_ENDPOINT: 'https://storage.example.test',
        STUDIO_S3_REGION: 'cn-hangzhou',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_ACCESS_KEY_ID: 'worker-access-key',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
        STUDIO_S3_SSE: 'aws:kms',
      }),
    ).toThrow(/STUDIO_S3_KMS_KEY_ID/);
    try {
      buildStudioWorkerRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 's3',
        STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
        STUDIO_OBJECT_STORE_PREFIX: 'studio',
        STUDIO_S3_ENDPOINT: 'https://storage.example.test',
        STUDIO_S3_REGION: 'cn-hangzhou',
        STUDIO_S3_CREDENTIAL_MODE: 'static',
        STUDIO_S3_ACCESS_KEY_ID: 'worker-access-key',
        STUDIO_S3_SECRET_ACCESS_KEY: secret,
        STUDIO_S3_SSE: 'aws:kms',
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  test('accepts fake and OpenAI-compatible S3 runtimes', () => {
    const s3 = {
      STUDIO_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 's3',
      STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
      STUDIO_OBJECT_STORE_PREFIX: 'studio',
      STUDIO_S3_ENDPOINT: 'https://storage.example.test',
      STUDIO_S3_REGION: 'cn-hangzhou',
      STUDIO_S3_CREDENTIAL_MODE: 'default-chain',
      STUDIO_S3_SSE: 'AES256',
    } as const;
    expect(buildStudioWorkerRuntime({ ...s3, STUDIO_FAKE_PROVIDER_ENABLED: 'true' })).toMatchObject({
      enabled: true,
      storageMode: 's3',
    });
    expect(
      buildStudioWorkerRuntime({ ...s3, STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true' }),
    ).toMatchObject({ enabled: true, storageMode: 's3', openAiCompatibleEnabled: true });
  });

  test('fails closed for incomplete static credentials', () => {
    const base = {
      STUDIO_ENABLED: 'true',
      STUDIO_FAKE_PROVIDER_ENABLED: 'true',
      STUDIO_OBJECT_STORE_MODE: 's3',
      STUDIO_OBJECT_STORE_BUCKET: 'studio-private',
      STUDIO_OBJECT_STORE_PREFIX: 'studio',
      STUDIO_S3_ENDPOINT: 'https://storage.example.test',
      STUDIO_S3_REGION: 'cn-hangzhou',
      STUDIO_S3_CREDENTIAL_MODE: 'static',
      STUDIO_S3_SSE: 'AES256',
    } as const;
    expect(() => buildStudioWorkerRuntime({ ...base, STUDIO_S3_ACCESS_KEY_ID: 'only-key' })).toThrow(
      /STUDIO_S3_SECRET_ACCESS_KEY/,
    );
  });
});
