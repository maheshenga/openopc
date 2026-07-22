import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { type AutomationControlConfig, loadAutomationControlConfig } from './config';
import type { InternalAutomationEnv } from './internal-auth';
import { createAutomationControlApp } from './server';

const ENABLED_CONFIG: AutomationControlConfig = {
  enabled: true,
  desktopCoordinatorEnabled: false,
  port: 4011,
  automationApiUrl: 'https://api.example.test',
  databaseUrl: 'postgresql://automation:password@db.example.test/automation',
  redisUrl: 'redis://redis.example.test:6379',
  serviceId: 'automation-control-test',
  sharedSecret: 'test-shared-secret-that-is-at-least-32-bytes',
  leaseMs: 30_000,
  coordinatorPollMs: 1_000,
  coordinatorBatchSize: 4,
};

describe('automation control configuration', () => {
  test('defaults the service to disabled without requiring infrastructure credentials', () => {
    const config = loadAutomationControlConfig({});

    expect(config.enabled).toBeFalse();
    expect(config.desktopCoordinatorEnabled).toBeFalse();
    expect(config.automationApiUrl).toBe('http://localhost:8008');
    expect(config.port).toBeGreaterThan(0);
    expect(config.databaseUrl).toBe('');
    expect(config.redisUrl).toBe('');
    expect(config.sharedSecret).toBe('');
  });

  test('rejects an enabled service without all required infrastructure configuration', () => {
    expect(() =>
      loadAutomationControlConfig({
        AUTOMATION_CONTROL_ENABLED: 'true',
        DATABASE_URL: 'postgresql://db.example.test/automation',
        REDIS_URL: 'redis://redis.example.test:6379',
      }),
    ).toThrow();
  });

  test('does not allow the desktop coordinator while the control service is disabled', () => {
    expect(() =>
      loadAutomationControlConfig({
        AUTOMATION_DESKTOP_COORDINATOR_ENABLED: 'true',
      }),
    ).toThrow();
  });
});

describe('automation control health endpoints', () => {
  test('reports disabled and refuses readiness while the feature flag is off', async () => {
    const config = loadAutomationControlConfig({});
    const app = createAutomationControlApp({
      config,
      checkDatabase: async () => {
        throw new Error('disabled services must not probe PostgreSQL');
      },
      checkRedis: async () => {
        throw new Error('disabled services must not probe Redis');
      },
    });

    const health = await app.request('/health');
    const readiness = await app.request('/ready');

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      protocol_version: 'automation.v1',
      service_id: config.serviceId,
      enabled: false,
      status: 'disabled',
      dependencies: { database: 'skipped', redis: 'skipped' },
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toMatchObject({
      protocol_version: 'automation.v1',
      enabled: false,
      status: 'disabled',
    });
  });

  test('becomes ready only when PostgreSQL and Redis are both available', async () => {
    const healthy = createAutomationControlApp({
      config: ENABLED_CONFIG,
      checkDatabase: async () => true,
      checkRedis: async () => true,
    });
    const degraded = createAutomationControlApp({
      config: ENABLED_CONFIG,
      checkDatabase: async () => false,
      checkRedis: async () => true,
    });

    const healthyResponse = await healthy.request('/ready');
    const degradedResponse = await degraded.request('/ready');

    expect(healthyResponse.status).toBe(200);
    expect(await healthyResponse.json()).toMatchObject({
      status: 'ready',
      dependencies: { database: 'available', redis: 'available' },
    });
    expect(degradedResponse.status).toBe(503);
    expect(await degradedResponse.json()).toMatchObject({
      status: 'not_ready',
      dependencies: { database: 'unavailable', redis: 'available' },
    });
  });

  test('never returns URLs, credentials, or dependency exception details', async () => {
    const app = createAutomationControlApp({
      config: ENABLED_CONFIG,
      checkDatabase: async () => {
        throw new Error(`database failed: ${ENABLED_CONFIG.databaseUrl}`);
      },
      checkRedis: async () => {
        throw new Error(`redis failed: ${ENABLED_CONFIG.redisUrl}`);
      },
    });

    const response = await app.request('/health');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain(ENABLED_CONFIG.databaseUrl);
    expect(body).not.toContain(ENABLED_CONFIG.redisUrl);
    expect(body).not.toContain(ENABLED_CONFIG.sharedSecret);
    expect(JSON.parse(body)).toMatchObject({
      status: 'degraded',
      dependencies: { database: 'unavailable', redis: 'unavailable' },
    });
  });

  test('mounts internal automation routes only while the service is enabled', async () => {
    const routes = new Hono<InternalAutomationEnv>();
    routes.get('/v1/automation/jobs', (context) => context.json({ ok: true }));
    const enabled = createAutomationControlApp({
      config: ENABLED_CONFIG,
      checkDatabase: async () => true,
      checkRedis: async () => true,
      routes,
    });
    const disabled = createAutomationControlApp({
      config: { ...ENABLED_CONFIG, enabled: false },
      checkDatabase: async () => false,
      checkRedis: async () => false,
      routes,
    });

    expect((await enabled.request('/v1/automation/jobs')).status).toBe(200);
    expect((await disabled.request('/v1/automation/jobs')).status).toBe(404);
  });
});
