import { describe, expect, test } from 'bun:test';
import { parseStudioWorkerEnvironment, runStudioMaintenanceOnce } from './index';

describe('studio worker bootstrap loop', () => {
  test('captures maintenance failures so the worker loop can continue', async () => {
    const errors: unknown[] = [];

    const completed = await runStudioMaintenanceOnce({
      runOnce: async () => {
        throw new Error('maintenance database timeout');
      },
      logError: (message, details) => {
        errors.push({ message, details });
      },
    });

    expect(completed).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: '[studio-worker] maintenance failed',
    });
  });

  test('accepts an explicit production adapter enablement flag with the worker secret', () => {
    expect(
      parseStudioWorkerEnvironment({
        STUDIO_ENABLED: 'true',
        DATABASE_URL: 'postgres://studio-worker',
        API_KEY_SECRET: 'worker-master-secret',
        STUDIO_OPENAI_COMPATIBLE_ENABLED: 'true',
      }),
    ).toMatchObject({
      enabled: true,
      apiKeySecret: 'worker-master-secret',
      fakeProviderEnabled: false,
      openAiCompatibleEnabled: true,
    });
  });
});
