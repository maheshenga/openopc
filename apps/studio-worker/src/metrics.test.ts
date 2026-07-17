import { describe, expect, test } from 'bun:test';
import {
  createStudioTelemetry,
  type StudioMetricEmission,
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
});
