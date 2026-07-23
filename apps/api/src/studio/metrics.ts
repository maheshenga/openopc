import type { StudioObjectStore } from '@kortix/studio-runtime';
import { type PrometheusRegistry, applicationPrometheusRegistry } from '../lib/metrics';

export const STUDIO_TELEMETRY_PROFILES = ['fake', 'openai-images-v1-generic'] as const;

export type StudioTelemetryProfile = (typeof STUDIO_TELEMETRY_PROFILES)[number];
export type StudioProviderOperation = 'submit' | 'poll' | 'reconcile';
export type StudioProviderOutcome = 'succeeded' | 'failed' | 'unknown';
export type StudioUnknownOutcomePhase = 'submitting' | 'polling' | 'reconciling';
export type StudioStorageOperation =
  | 'put'
  | 'get'
  | 'head'
  | 'delete'
  | 'presign_upload'
  | 'presign_download';
export type StudioStorageOutcome = 'succeeded' | 'failed';
export type StudioReservationState = 'active' | 'settled' | 'released';
export type StudioRecoveryDecision = 'confirm_succeeded' | 'confirm_not_created' | 'keep_unknown';
export type StudioRecoveryOutcome = 'applied' | 'replayed' | 'rejected';
export type StudioReservationAgeSeverity = 'normal' | 'warning' | 'critical';

type CounterEmission =
  | {
      kind: 'counter';
      name: 'studio_provider_requests_total';
      value: number;
      labels: {
        operation: StudioProviderOperation;
        outcome: StudioProviderOutcome;
        profile: StudioTelemetryProfile;
      };
    }
  | {
      kind: 'counter';
      name: 'studio_unknown_outcomes_total';
      value: number;
      labels: { phase: StudioUnknownOutcomePhase; profile: StudioTelemetryProfile };
    }
  | {
      kind: 'counter';
      name: 'studio_storage_operations_total';
      value: number;
      labels: { operation: StudioStorageOperation; outcome: StudioStorageOutcome };
    }
  | {
      kind: 'counter';
      name: 'studio_estimate_violations_total';
      value: number;
      labels: { profile: StudioTelemetryProfile };
    }
  | {
      kind: 'counter';
      name: 'studio_platform_loss_credits_total';
      value: number;
      labels: { profile: StudioTelemetryProfile };
    }
  | {
      kind: 'counter';
      name: 'studio_recovery_decisions_total';
      value: number;
      labels: { decision: StudioRecoveryDecision; outcome: StudioRecoveryOutcome };
    };

type GaugeEmission =
  | {
      kind: 'gauge';
      name: 'studio_storage_readiness';
      value: number;
      labels: { role: 'api' | 'worker' };
    }
  | {
      kind: 'gauge';
      name: 'studio_queue_oldest_age_seconds';
      value: number;
      labels: Record<string, never>;
    }
  | {
      kind: 'gauge';
      name: 'studio_reservation_oldest_age_seconds';
      value: number;
      labels: { state: StudioReservationState };
    }
  | {
      kind: 'gauge';
      name: 'studio_orphan_staging_objects';
      value: number;
      labels: Record<string, never>;
    };

type HistogramEmission =
  | {
      kind: 'histogram';
      name: 'studio_provider_request_duration_seconds';
      value: number;
      labels: { operation: StudioProviderOperation; profile: StudioTelemetryProfile };
    }
  | {
      kind: 'histogram';
      name: 'studio_storage_operation_duration_seconds';
      value: number;
      labels: { operation: StudioStorageOperation };
    };

export type StudioMetricEmission = CounterEmission | GaugeEmission | HistogramEmission;

export type StudioTelemetrySinks = {
  counter(emission: CounterEmission): void;
  gauge(emission: GaugeEmission): void;
  histogram(emission: HistogramEmission): void;
};

export type StudioTelemetry = {
  providerRequest(input: {
    operation: StudioProviderOperation;
    outcome: StudioProviderOutcome;
    profile: StudioTelemetryProfile;
  }): void;
  providerRequestDuration(input: {
    operation: StudioProviderOperation;
    profile: StudioTelemetryProfile;
    seconds: number;
  }): void;
  unknownOutcome(input: {
    phase: StudioUnknownOutcomePhase;
    profile: StudioTelemetryProfile;
  }): void;
  storageOperation(input: {
    operation: StudioStorageOperation;
    outcome: StudioStorageOutcome;
  }): void;
  storageOperationDuration(input: { operation: StudioStorageOperation; seconds: number }): void;
  storageReadiness(input: { role: 'api' | 'worker'; ready: boolean }): void;
  queueOldestAge(seconds: number): void;
  reservationOldestAge(input: {
    state: StudioReservationState;
    seconds: number;
  }): StudioReservationAgeSeverity;
  orphanStagingObjects(count: number): void;
  estimateViolation(input: { profile: StudioTelemetryProfile }): void;
  platformLoss(input: { profile: StudioTelemetryProfile; credits: number }): void;
  recoveryDecision(input: {
    decision: StudioRecoveryDecision;
    outcome: StudioRecoveryOutcome;
  }): void;
};

export type InMemoryStudioTelemetrySink = StudioTelemetrySinks & {
  emissions: StudioMetricEmission[];
};

const PROVIDER_OPERATIONS = ['submit', 'poll', 'reconcile'] as const;
const PROVIDER_OUTCOMES = ['succeeded', 'failed', 'unknown'] as const;
const UNKNOWN_OUTCOME_PHASES = ['submitting', 'polling', 'reconciling'] as const;
const STORAGE_OPERATIONS = [
  'put',
  'get',
  'head',
  'delete',
  'presign_upload',
  'presign_download',
] as const;
const STORAGE_OUTCOMES = ['succeeded', 'failed'] as const;
const RESERVATION_STATES = ['active', 'settled', 'released'] as const;
const RECOVERY_DECISIONS = ['confirm_succeeded', 'confirm_not_created', 'keep_unknown'] as const;
const RECOVERY_OUTCOMES = ['applied', 'replayed', 'rejected'] as const;
const STORAGE_ROLES = ['api', 'worker'] as const;
const RESERVATION_WARNING_SECONDS = 24 * 60 * 60;
const RESERVATION_CRITICAL_SECONDS = 7 * 24 * 60 * 60;
const RESERVATION_HOLD_CAP_SECONDS = 30 * 24 * 60 * 60;

const COUNTER_DEFINITIONS = [
  [
    'studio_provider_requests_total',
    'Studio provider requests by operation, outcome, and profile.',
  ],
  ['studio_unknown_outcomes_total', 'Studio provider outcomes requiring explicit reconciliation.'],
  ['studio_storage_operations_total', 'Studio object storage operations by operation and outcome.'],
  [
    'studio_estimate_violations_total',
    'Studio jobs whose settled usage exceeded the accepted estimate.',
  ],
  ['studio_platform_loss_credits_total', 'Studio credits absorbed as platform loss.'],
  ['studio_recovery_decisions_total', 'Studio recovery decisions by bounded decision and outcome.'],
] as const;

const GAUGE_DEFINITIONS = [
  ['studio_storage_readiness', 'Studio object storage readiness by runtime role.'],
  ['studio_queue_oldest_age_seconds', 'Age in seconds of the oldest queued Studio job.'],
  [
    'studio_reservation_oldest_age_seconds',
    'Age in seconds of the oldest Studio reservation by state.',
  ],
  ['studio_orphan_staging_objects', 'Number of orphan Studio staging objects awaiting cleanup.'],
] as const;

const HISTOGRAM_DEFINITIONS = [
  [
    'studio_provider_request_duration_seconds',
    'Studio provider request latency by operation and profile.',
  ],
  [
    'studio_storage_operation_duration_seconds',
    'Studio object storage operation latency by operation.',
  ],
] as const;

function assertAllowed(value: unknown, allowed: readonly string[], field: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new TypeError(`Invalid Studio telemetry ${field}`);
  }
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`Invalid Studio telemetry ${field}`);
  }
}

function reservationSeverity(seconds: number): StudioReservationAgeSeverity {
  if (seconds >= RESERVATION_HOLD_CAP_SECONDS) return 'critical';
  if (seconds >= RESERVATION_CRITICAL_SECONDS) return 'critical';
  if (seconds >= RESERVATION_WARNING_SECONDS) return 'warning';
  return 'normal';
}

export function createInMemoryStudioTelemetrySink(): InMemoryStudioTelemetrySink {
  const emissions: StudioMetricEmission[] = [];
  return {
    emissions,
    counter: (emission) => emissions.push(emission),
    gauge: (emission) => emissions.push(emission),
    histogram: (emission) => emissions.push(emission),
  };
}

export function createPrometheusStudioTelemetrySink(
  registry: PrometheusRegistry = applicationPrometheusRegistry,
): StudioTelemetrySinks {
  const counters = new Map(
    COUNTER_DEFINITIONS.map(([name, help]) => [name, registry.registerCounter(name, help)]),
  );
  const gauges = new Map(
    GAUGE_DEFINITIONS.map(([name, help]) => [name, registry.registerGauge(name, help)]),
  );
  const histograms = new Map(
    HISTOGRAM_DEFINITIONS.map(([name, help]) => [name, registry.registerHistogram(name, help)]),
  );
  return {
    counter(emission) {
      requirePrometheusMetric(counters.get(emission.name), emission.name).inc(
        emission.labels,
        emission.value,
      );
    },
    gauge(emission) {
      requirePrometheusMetric(gauges.get(emission.name), emission.name).set(
        emission.value,
        emission.labels,
      );
    },
    histogram(emission) {
      requirePrometheusMetric(histograms.get(emission.name), emission.name).observe(
        emission.value,
        emission.labels,
      );
    },
  };
}

export function createStudioTelemetry(sinks: StudioTelemetrySinks): StudioTelemetry {
  return {
    providerRequest({ operation, outcome, profile }) {
      assertAllowed(operation, PROVIDER_OPERATIONS, 'provider operation');
      assertAllowed(outcome, PROVIDER_OUTCOMES, 'provider outcome');
      assertAllowed(profile, STUDIO_TELEMETRY_PROFILES, 'profile');
      sinks.counter({
        kind: 'counter',
        name: 'studio_provider_requests_total',
        value: 1,
        labels: { operation, outcome, profile },
      });
    },
    providerRequestDuration({ operation, profile, seconds }) {
      assertAllowed(operation, PROVIDER_OPERATIONS, 'provider operation');
      assertAllowed(profile, STUDIO_TELEMETRY_PROFILES, 'profile');
      assertNonNegative(seconds, 'provider request duration');
      sinks.histogram({
        kind: 'histogram',
        name: 'studio_provider_request_duration_seconds',
        value: seconds,
        labels: { operation, profile },
      });
    },
    unknownOutcome({ phase, profile }) {
      assertAllowed(phase, UNKNOWN_OUTCOME_PHASES, 'unknown-outcome phase');
      assertAllowed(profile, STUDIO_TELEMETRY_PROFILES, 'profile');
      sinks.counter({
        kind: 'counter',
        name: 'studio_unknown_outcomes_total',
        value: 1,
        labels: { phase, profile },
      });
    },
    storageOperation({ operation, outcome }) {
      assertAllowed(operation, STORAGE_OPERATIONS, 'storage operation');
      assertAllowed(outcome, STORAGE_OUTCOMES, 'storage outcome');
      sinks.counter({
        kind: 'counter',
        name: 'studio_storage_operations_total',
        value: 1,
        labels: { operation, outcome },
      });
    },
    storageOperationDuration({ operation, seconds }) {
      assertAllowed(operation, STORAGE_OPERATIONS, 'storage operation');
      assertNonNegative(seconds, 'storage operation duration');
      sinks.histogram({
        kind: 'histogram',
        name: 'studio_storage_operation_duration_seconds',
        value: seconds,
        labels: { operation },
      });
    },
    storageReadiness({ role, ready }) {
      assertAllowed(role, STORAGE_ROLES, 'storage role');
      sinks.gauge({
        kind: 'gauge',
        name: 'studio_storage_readiness',
        value: ready ? 1 : 0,
        labels: { role },
      });
    },
    queueOldestAge(seconds) {
      assertNonNegative(seconds, 'queue oldest age');
      sinks.gauge({
        kind: 'gauge',
        name: 'studio_queue_oldest_age_seconds',
        value: seconds,
        labels: {},
      });
    },
    reservationOldestAge({ state, seconds }) {
      assertAllowed(state, RESERVATION_STATES, 'reservation state');
      assertNonNegative(seconds, 'reservation oldest age');
      sinks.gauge({
        kind: 'gauge',
        name: 'studio_reservation_oldest_age_seconds',
        value: seconds,
        labels: { state },
      });
      return reservationSeverity(seconds);
    },
    orphanStagingObjects(count) {
      assertNonNegative(count, 'orphan staging object count');
      sinks.gauge({
        kind: 'gauge',
        name: 'studio_orphan_staging_objects',
        value: count,
        labels: {},
      });
    },
    estimateViolation({ profile }) {
      assertAllowed(profile, STUDIO_TELEMETRY_PROFILES, 'profile');
      sinks.counter({
        kind: 'counter',
        name: 'studio_estimate_violations_total',
        value: 1,
        labels: { profile },
      });
    },
    platformLoss({ profile, credits }) {
      assertAllowed(profile, STUDIO_TELEMETRY_PROFILES, 'profile');
      assertNonNegative(credits, 'platform loss credits');
      sinks.counter({
        kind: 'counter',
        name: 'studio_platform_loss_credits_total',
        value: credits,
        labels: { profile },
      });
    },
    recoveryDecision({ decision, outcome }) {
      assertAllowed(decision, RECOVERY_DECISIONS, 'recovery decision');
      assertAllowed(outcome, RECOVERY_OUTCOMES, 'recovery outcome');
      sinks.counter({
        kind: 'counter',
        name: 'studio_recovery_decisions_total',
        value: 1,
        labels: { decision, outcome },
      });
    },
  };
}

export const applicationStudioTelemetry = createStudioTelemetry(
  createPrometheusStudioTelemetrySink(),
);

function requirePrometheusMetric<T>(metric: T | undefined, name: string): T {
  if (!metric) throw new Error(`Studio Prometheus metric is not registered: ${name}`);
  return metric;
}

/**
 * Decorates storage calls at the API composition boundary without exposing
 * object keys, signed URLs, or provider diagnostics in telemetry.
 */
export function instrumentStudioObjectStore(
  store: StudioObjectStore,
  role: 'api' | 'worker',
  telemetry: StudioTelemetry,
  nowMilliseconds: () => number = performance.now.bind(performance),
): StudioObjectStore {
  const emit = (callback: () => void): void => {
    try {
      callback();
    } catch {
      // Telemetry must never change API behavior.
    }
  };
  const observe = async <T>(
    operation: StudioStorageOperation,
    call: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = nowMilliseconds();
    try {
      const result = await call();
      emit(() => telemetry.storageOperation({ operation, outcome: 'succeeded' }));
      return result;
    } catch (error) {
      emit(() => telemetry.storageOperation({ operation, outcome: 'failed' }));
      throw error;
    } finally {
      emit(() =>
        telemetry.storageOperationDuration({
          operation,
          seconds: Math.max(0, nowMilliseconds() - startedAt) / 1_000,
        }),
      );
    }
  };

  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'assertReady') {
        return async () => {
          try {
            await target.assertReady();
            emit(() => telemetry.storageReadiness({ role, ready: true }));
          } catch (error) {
            emit(() => telemetry.storageReadiness({ role, ready: false }));
            throw error;
          }
        };
      }
      if (property === 'putObject') {
        return (input: Parameters<StudioObjectStore['putObject']>[0]) =>
          observe('put', () => target.putObject(input));
      }
      if (property === 'headObject') {
        return (input: Parameters<StudioObjectStore['headObject']>[0]) =>
          observe('head', () => target.headObject(input));
      }
      if (property === 'getObject') {
        return (input: Parameters<StudioObjectStore['getObject']>[0]) =>
          observe('get', () => target.getObject(input));
      }
      if (property === 'deleteObject') {
        return (input: Parameters<StudioObjectStore['deleteObject']>[0]) =>
          observe('delete', () => target.deleteObject(input));
      }
      if (property === 'createSignedUploadUrl') {
        return (input: Parameters<StudioObjectStore['createSignedUploadUrl']>[0]) =>
          observe('presign_upload', () => target.createSignedUploadUrl(input));
      }
      if (property === 'createSignedDownloadUrl') {
        return (input: Parameters<StudioObjectStore['createSignedDownloadUrl']>[0]) =>
          observe('presign_download', () => target.createSignedDownloadUrl(input));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
