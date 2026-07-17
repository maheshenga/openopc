import { describe, expect, mock, test } from 'bun:test';

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  KORTIX_MARKUP: 1.2,
  PLATFORM_FEE_MARKUP: 0.1,
  config: { API_KEY_SECRET: 'test-signing-secret' },
}));
mock.module('../shared/db', () => ({ db: {}, hasDatabase: false }));

const { buildStudioApiRuntime } = await import('./default-routes');

describe('Studio API runtime assembly', () => {
  test('keeps Studio disabled without adapter configuration', () => {
    expect(buildStudioApiRuntime({ STUDIO_ENABLED: 'false' })).toEqual({ enabled: false });
  });

  test('uses the same ephemeral storage policy as the worker runtime', () => {
    expect(
      buildStudioApiRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_FAKE_PROVIDER_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toMatchObject({ enabled: true, storageMode: 'memory', fakeProviderEnabled: true });

    expect(() =>
      buildStudioApiRuntime({
        STUDIO_ENABLED: 'true',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toThrow(/STUDIO_OPENAI_COMPATIBLE_ENABLED/);
  });
});
