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

describe('Studio API telemetry', () => {
  test('classifies reservation age at the warning, escalation, and hold-cap thresholds', () => {
    const { telemetry, emissions } = recordingTelemetry();

    expect(telemetry.reservationOldestAge({ state: 'active', seconds: 86_399 })).toBe('normal');
    expect(telemetry.reservationOldestAge({ state: 'active', seconds: 86_400 })).toBe('warning');
    expect(telemetry.reservationOldestAge({ state: 'active', seconds: 7 * 86_400 })).toBe('critical');
    expect(telemetry.reservationOldestAge({ state: 'active', seconds: 30 * 86_400 })).toBe('critical');

    expect(emissions.map(({ labels }) => labels)).toEqual([
      { state: 'active' },
      { state: 'active' },
      { state: 'active' },
      { state: 'active' },
    ]);
  });

  test('records all recovery decisions and platform loss without sensitive labels', () => {
    const { telemetry, emissions } = recordingTelemetry();

    telemetry.recoveryDecision({ decision: 'confirm_succeeded', outcome: 'applied' });
    telemetry.recoveryDecision({ decision: 'confirm_not_created', outcome: 'applied' });
    telemetry.recoveryDecision({ decision: 'keep_unknown', outcome: 'replayed' });
    telemetry.platformLoss({ profile: 'fake', credits: 2.75 });

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'studio_recovery_decisions_total',
        value: 1,
        labels: { decision: 'confirm_succeeded', outcome: 'applied' },
      },
      {
        kind: 'counter',
        name: 'studio_recovery_decisions_total',
        value: 1,
        labels: { decision: 'confirm_not_created', outcome: 'applied' },
      },
      {
        kind: 'counter',
        name: 'studio_recovery_decisions_total',
        value: 1,
        labels: { decision: 'keep_unknown', outcome: 'replayed' },
      },
      {
        kind: 'counter',
        name: 'studio_platform_loss_credits_total',
        value: 2.75,
        labels: { profile: 'fake' },
      },
    ]);

    const forbidden = new Set([
      'account',
      'account_id',
      'project',
      'project_id',
      'job',
      'job_id',
      'object_key',
      'url',
      'model',
      'credential',
      'error_message',
    ]);
    for (const emission of emissions) {
      expect(Object.keys(emission.labels).some((label) => forbidden.has(label))).toBe(false);
    }
  });
});
