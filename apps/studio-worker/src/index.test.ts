import { describe, expect, test } from 'bun:test';
import {
  parseStudioWorkerEnvironment,
  runStudioMaintenanceOnce,
  runStudioWorkerTick,
  shutdownStudioWorker,
} from './index';

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

  test('checks storage readiness before every claim and skips claims while unavailable', async () => {
    let claims = 0;
    const unavailable = await runStudioWorkerTick({
      assertReady: async () => {
        throw new Error('storage unavailable');
      },
      claim: async () => {
        claims += 1;
      },
    });
    expect(unavailable).toBe(false);
    expect(claims).toBe(0);

    expect(
      await runStudioWorkerTick({
        assertReady: async () => {},
        claim: async () => {
          claims += 1;
        },
      }),
    ).toBe(true);
    expect(claims).toBe(1);
  });

  test('shuts down maintenance, database, and storage exactly once', async () => {
    const calls: string[] = [];
    await shutdownStudioWorker({
      releaseMaintenance: async () => calls.push('maintenance'),
      closeDatabase: async () => calls.push('database'),
      closeStorage: async () => calls.push('storage'),
    });
    expect(calls).toEqual(['maintenance', 'database', 'storage']);
  });
});
