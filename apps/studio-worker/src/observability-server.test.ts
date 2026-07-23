import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_STUDIO_WORKER_OBSERVABILITY_PORT,
  createStudioWorkerObservabilityServer,
  parseStudioWorkerObservabilityEnvironment,
} from './observability-server';

describe('Studio worker observability server', () => {
  test('parses a bounded internal listener configuration', () => {
    expect(parseStudioWorkerObservabilityEnvironment({})).toEqual({
      hostname: '0.0.0.0',
      port: DEFAULT_STUDIO_WORKER_OBSERVABILITY_PORT,
    });
    expect(
      parseStudioWorkerObservabilityEnvironment({
        STUDIO_WORKER_OBSERVABILITY_HOST: '127.0.0.1',
        STUDIO_WORKER_OBSERVABILITY_PORT: '9191',
      }),
    ).toEqual({ hostname: '127.0.0.1', port: 9191 });
    expect(() =>
      parseStudioWorkerObservabilityEnvironment({
        STUDIO_WORKER_OBSERVABILITY_PORT: '0',
      }),
    ).toThrow('must be an integer from 1 through 65535');
    expect(() =>
      parseStudioWorkerObservabilityEnvironment({
        STUDIO_WORKER_OBSERVABILITY_HOST: 'http://public.example',
      }),
    ).toThrow('STUDIO_WORKER_OBSERVABILITY_HOST is invalid');
  });

  test('keeps liveness shallow and readiness dependency-aware without leaking errors', async () => {
    const observability = createStudioWorkerObservabilityServer();
    let readinessCalls = 0;
    observability.setReadinessProbe(async () => {
      readinessCalls += 1;
      throw new Error('https://storage.example/private?X-Amz-Signature=sensitive');
    });

    const live = await observability.handle(new Request('http://worker/health/live'));
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok', service: 'studio-worker' });
    expect(readinessCalls).toBe(0);

    const ready = await observability.handle(new Request('http://worker/health/ready'));
    expect(ready.status).toBe(503);
    expect(await ready.text()).toBe('{"status":"not_ready"}');
    expect(readinessCalls).toBe(1);
  });

  test('renders every bounded Studio series while readiness is unavailable', async () => {
    const observability = createStudioWorkerObservabilityServer();
    observability.setReadinessProbe(async () => {
      throw new Error('provider and storage are unreachable');
    });
    observability.telemetry.providerRequest({
      operation: 'poll',
      outcome: 'unknown',
      profile: 'openai-images-v1-generic',
    });
    observability.telemetry.storageReadiness({ role: 'worker', ready: false });

    expect((await observability.handle(new Request('http://worker/health/ready'))).status).toBe(
      503,
    );
    const metrics = await observability.handle(new Request('http://worker/metrics'));
    expect(metrics.status).toBe(200);
    const rendered = await metrics.text();
    for (const name of [
      'studio_provider_requests_total',
      'studio_provider_request_duration_seconds',
      'studio_unknown_outcomes_total',
      'studio_storage_operations_total',
      'studio_storage_operation_duration_seconds',
      'studio_storage_readiness',
      'studio_queue_oldest_age_seconds',
      'studio_reservation_oldest_age_seconds',
      'studio_orphan_staging_objects',
      'studio_estimate_violations_total',
      'studio_platform_loss_credits_total',
      'studio_recovery_decisions_total',
    ]) {
      expect(rendered).toContain(`# HELP ${name} `);
    }
    expect(rendered).toContain(
      'studio_provider_requests_total{operation="poll",outcome="unknown",profile="openai-images-v1-generic"} 1',
    );
    expect(rendered).toContain('studio_storage_readiness{role="worker"} 0');
    expect(rendered).not.toMatch(
      /account_id|project_id|job_id|object_key|https?:\/\/|X-Amz|credential|error_message/,
    );
  });

  test('binds and stops the dedicated HTTP listener', async () => {
    const observability = createStudioWorkerObservabilityServer({
      hostname: '127.0.0.1',
      port: 0,
    });
    const listener = observability.start();
    try {
      const response = await fetch(`http://${listener.hostname}:${listener.port}/health/live`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'ok', service: 'studio-worker' });
    } finally {
      await observability.stop();
    }
  });
});
