import { describe, expect, test } from 'bun:test';
import { StudioProviderCallError } from '@kortix/studio-runtime';
import {
  type StudioMetricEmission,
  createStudioTelemetry,
  instrumentStudioProviderAdapter,
} from './metrics';

function recordingTelemetry() {
  const emissions: StudioMetricEmission[] = [];
  return {
    emissions,
    telemetry: createStudioTelemetry({
      counter: (emission) => emissions.push(emission),
      gauge: (emission) => emissions.push(emission),
      histogram: (emission) => emissions.push(emission),
    }),
  };
}

describe('Studio worker telemetry', () => {
  test('emits every required low-cardinality Studio series with exact labels', () => {
    const { telemetry, emissions } = recordingTelemetry();

    telemetry.providerRequest({
      operation: 'submit',
      outcome: 'succeeded',
      profile: 'openai-images-v1-generic',
    });
    telemetry.providerRequestDuration({
      operation: 'submit',
      profile: 'openai-images-v1-generic',
      seconds: 1.25,
    });
    telemetry.unknownOutcome({ phase: 'reconciling', profile: 'openai-images-v1-generic' });
    telemetry.storageOperation({ operation: 'put', outcome: 'succeeded' });
    telemetry.storageOperationDuration({ operation: 'put', seconds: 0.25 });
    telemetry.storageReadiness({ role: 'worker', ready: true });
    telemetry.queueOldestAge(42);
    expect(telemetry.reservationOldestAge({ state: 'active', seconds: 3_600 })).toBe('normal');
    telemetry.orphanStagingObjects(2);
    telemetry.estimateViolation({ profile: 'openai-images-v1-generic' });
    telemetry.platformLoss({ profile: 'openai-images-v1-generic', credits: 1.5 });
    telemetry.recoveryDecision({ decision: 'keep_unknown', outcome: 'applied' });

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: {
          operation: 'submit',
          outcome: 'succeeded',
          profile: 'openai-images-v1-generic',
        },
      },
      {
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: 1.25,
        labels: { operation: 'submit', profile: 'openai-images-v1-generic' },
      },
      {
        kind: 'counter',
        name: 'studio_unknown_outcomes_total',
        value: 1,
        labels: { phase: 'reconciling', profile: 'openai-images-v1-generic' },
      },
      {
        kind: 'counter',
        name: 'studio_storage_operations_total',
        value: 1,
        labels: { operation: 'put', outcome: 'succeeded' },
      },
      {
        kind: 'histogram',
        name: 'studio_storage_operation_duration_seconds',
        value: 0.25,
        labels: { operation: 'put' },
      },
      {
        kind: 'gauge',
        name: 'studio_storage_readiness',
        value: 1,
        labels: { role: 'worker' },
      },
      {
        kind: 'gauge',
        name: 'studio_queue_oldest_age_seconds',
        value: 42,
        labels: {},
      },
      {
        kind: 'gauge',
        name: 'studio_reservation_oldest_age_seconds',
        value: 3_600,
        labels: { state: 'active' },
      },
      {
        kind: 'gauge',
        name: 'studio_orphan_staging_objects',
        value: 2,
        labels: {},
      },
      {
        kind: 'counter',
        name: 'studio_estimate_violations_total',
        value: 1,
        labels: { profile: 'openai-images-v1-generic' },
      },
      {
        kind: 'counter',
        name: 'studio_platform_loss_credits_total',
        value: 1.5,
        labels: { profile: 'openai-images-v1-generic' },
      },
      {
        kind: 'counter',
        name: 'studio_recovery_decisions_total',
        value: 1,
        labels: { decision: 'keep_unknown', outcome: 'applied' },
      },
    ]);
  });

  test('records a successful provider request through the invocation adapter', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async (context) => ({
          kind: 'completed' as const,
          provider: 'fake',
          submission_key: context.submissionKey,
          result: { assets: [], usage: {} },
        }),
        poll: async () => ({ status: 'succeeded' as const }),
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        const values = [1_000, 1_250];
        return () => values.shift() ?? 1_250;
      })(),
    );

    await adapter.submit(
      { correlationId: 'job-a', submissionKey: 'submission-a' },
      {
        capability: 'image.generate',
        image: {
          prompt: 'test',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      },
    );

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: { operation: 'submit', outcome: 'succeeded', profile: 'fake' },
      },
      {
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: 0.25,
        labels: { operation: 'submit', profile: 'fake' },
      },
    ]);
  });

  test('records an unknown reconciliation without leaking diagnostic labels', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async () => {
          throw new Error('unused');
        },
        reconcile: async () => {
          throw new StudioProviderCallError('unknown_outcome', 'sensitive provider detail');
        },
        poll: async () => ({ status: 'succeeded' as const }),
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        const values = [2_000, 2_500];
        return () => values.shift() ?? 2_500;
      })(),
    );

    await expect(
      adapter.reconcile?.(
        { correlationId: 'job-a', submissionKey: 'submission-a' },
        'submission-a',
      ),
    ).rejects.toMatchObject({ classification: 'unknown_outcome' });
    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: { operation: 'reconcile', outcome: 'unknown', profile: 'fake' },
      },
      {
        kind: 'counter',
        name: 'studio_unknown_outcomes_total',
        value: 1,
        labels: { phase: 'reconciling', profile: 'fake' },
      },
      {
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: 0.5,
        labels: { operation: 'reconcile', profile: 'fake' },
      },
    ]);
    expect(JSON.stringify(emissions)).not.toContain('sensitive provider detail');
  });

  test('records a returned unknown poll status as an unknown outcome', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async () => {
          throw new Error('unused');
        },
        poll: async () => ({ status: 'unknown' as const }),
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        const values = [3_000, 3_100];
        return () => values.shift() ?? 3_100;
      })(),
    );

    await adapter.poll(
      { correlationId: 'job-a', submissionKey: 'submission-a' },
      { provider: 'fake', id: 'handle-a', submission_key: 'submission-a' },
    );

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: { operation: 'poll', outcome: 'unknown', profile: 'fake' },
      },
      {
        kind: 'counter',
        name: 'studio_unknown_outcomes_total',
        value: 1,
        labels: { phase: 'polling', profile: 'fake' },
      },
      {
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: 0.1,
        labels: { operation: 'poll', profile: 'fake' },
      },
    ]);
  });

  test('records a returned unknown reconciliation as an unknown outcome', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async () => {
          throw new Error('unused');
        },
        reconcile: async () => 'unknown' as const,
        poll: async () => ({ status: 'succeeded' as const }),
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        const values = [4_000, 4_100];
        return () => values.shift() ?? 4_100;
      })(),
    );

    await adapter.reconcile?.(
      { correlationId: 'job-a', submissionKey: 'submission-a' },
      'submission-a',
    );

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: { operation: 'reconcile', outcome: 'unknown', profile: 'fake' },
      },
      {
        kind: 'counter',
        name: 'studio_unknown_outcomes_total',
        value: 1,
        labels: { phase: 'reconciling', profile: 'fake' },
      },
      {
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: 0.1,
        labels: { operation: 'reconcile', profile: 'fake' },
      },
    ]);
  });

  test('records and rethrows ordinary failures for every instrumented operation', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const failures = {
      submit: new Error('submit failed'),
      poll: new Error('poll failed'),
      reconcile: new Error('reconcile failed'),
    };
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async () => {
          throw failures.submit;
        },
        poll: async () => {
          throw failures.poll;
        },
        reconcile: async () => {
          throw failures.reconcile;
        },
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        let now = 5_000;
        return () => {
          const value = now;
          now += 100;
          return value;
        };
      })(),
    );
    const context = { correlationId: 'job-a', submissionKey: 'submission-a' };
    const handle = { provider: 'fake', id: 'handle-a', submission_key: 'submission-a' };

    await expect(
      adapter.submit(context, {
        capability: 'image.generate',
        image: {
          prompt: 'test',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      }),
    ).rejects.toBe(failures.submit);
    await expect(adapter.poll(context, handle)).rejects.toBe(failures.poll);
    await expect(adapter.reconcile?.(context, 'submission-a')).rejects.toBe(failures.reconcile);

    expect(emissions).toEqual(
      (['submit', 'poll', 'reconcile'] as const).flatMap((operation) => [
        {
          kind: 'counter',
          name: 'studio_provider_requests_total',
          value: 1,
          labels: { operation, outcome: 'failed', profile: 'fake' },
        },
        {
          kind: 'histogram',
          name: 'studio_provider_request_duration_seconds',
          value: 0.1,
          labels: { operation, profile: 'fake' },
        },
      ]),
    );
  });

  test('records thrown unknown outcomes for submit and poll without diagnostic labels', async () => {
    const { telemetry, emissions } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(
      {
        id: 'fake',
        submit: async () => {
          throw new StudioProviderCallError('unknown_outcome', 'sensitive submit detail');
        },
        poll: async () => {
          throw new StudioProviderCallError('unknown_outcome', 'sensitive poll detail');
        },
        cancel: async () => {},
        fetchResult: async () => ({ assets: [], usage: {} }),
      },
      'fake',
      telemetry,
      (() => {
        let now = 6_000;
        return () => {
          const value = now;
          now += 100;
          return value;
        };
      })(),
    );
    const context = { correlationId: 'job-a', submissionKey: 'submission-a' };

    await expect(
      adapter.submit(context, {
        capability: 'image.generate',
        image: {
          prompt: 'test',
          reference_asset_ids: [],
          aspect_ratio: '1:1',
          quality: 'standard',
          output_count: 1,
        },
      }),
    ).rejects.toMatchObject({ classification: 'unknown_outcome' });
    await expect(
      adapter.poll(context, {
        provider: 'fake',
        id: 'handle-a',
        submission_key: 'submission-a',
      }),
    ).rejects.toMatchObject({ classification: 'unknown_outcome' });

    expect(emissions).toEqual(
      (
        [
          ['submit', 'submitting'],
          ['poll', 'polling'],
        ] as const
      ).flatMap(([operation, phase]) => [
        {
          kind: 'counter',
          name: 'studio_provider_requests_total',
          value: 1,
          labels: { operation, outcome: 'unknown', profile: 'fake' },
        },
        {
          kind: 'counter',
          name: 'studio_unknown_outcomes_total',
          value: 1,
          labels: { phase, profile: 'fake' },
        },
        {
          kind: 'histogram',
          name: 'studio_provider_request_duration_seconds',
          value: 0.1,
          labels: { operation, profile: 'fake' },
        },
      ]),
    );
    expect(JSON.stringify(emissions)).not.toContain('sensitive');
  });

  test('preserves prototype-backed adapter methods and their receiver', async () => {
    class PrototypeAdapter {
      readonly id = 'fake';
      #cancelled = false;

      async submit(context: { submissionKey: string }) {
        return {
          kind: 'completed' as const,
          provider: 'fake',
          submission_key: context.submissionKey,
          result: { assets: [], usage: {} },
        };
      }

      async poll() {
        return { status: 'succeeded' as const };
      }

      async cancel() {
        this.#cancelled = true;
      }

      async reconcile() {
        return this.#cancelled ? ('not-found' as const) : ('unknown' as const);
      }

      async fetchResult() {
        if (!this.#cancelled) throw new Error('cancel receiver was lost');
        return { assets: [], usage: {} };
      }
    }

    const source = new PrototypeAdapter();
    const { telemetry } = recordingTelemetry();
    const adapter = instrumentStudioProviderAdapter(source, 'fake', telemetry);
    const context = { correlationId: 'job-a', submissionKey: 'submission-a' };
    const handle = { provider: 'fake', id: 'handle-a', submission_key: 'submission-a' };

    expect(adapter.id).toBe(source.id);
    await adapter.cancel(context, handle);
    await expect(adapter.fetchResult(context, handle)).resolves.toEqual({ assets: [], usage: {} });
    await expect(adapter.reconcile?.(context, 'submission-a')).resolves.toBe('not-found');
  });
});
