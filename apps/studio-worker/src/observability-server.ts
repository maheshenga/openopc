import { type PrometheusRegistry, createPrometheusRegistry } from '../../api/src/lib/metrics';
import { type StudioTelemetry, type StudioTelemetrySinks, createStudioTelemetry } from './metrics';

export const DEFAULT_STUDIO_WORKER_OBSERVABILITY_PORT = 9090;

export type StudioWorkerObservabilityConfig = {
  hostname: string;
  port: number;
};

export type StudioWorkerReadinessProbe = () => Promise<void>;

export type StudioWorkerObservabilityServer = {
  readonly telemetry: StudioTelemetry;
  readonly registry: PrometheusRegistry;
  handle(request: Request): Promise<Response>;
  setReadinessProbe(probe: StudioWorkerReadinessProbe | null): void;
  start(): { hostname: string; port: number };
  stop(): Promise<void>;
};

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

export function parseStudioWorkerObservabilityEnvironment(
  env: Record<string, string | undefined> = process.env,
): StudioWorkerObservabilityConfig {
  const hostname = env.STUDIO_WORKER_OBSERVABILITY_HOST?.trim() || '0.0.0.0';
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(hostname)) {
    throw new Error('STUDIO_WORKER_OBSERVABILITY_HOST is invalid');
  }
  const rawPort = env.STUDIO_WORKER_OBSERVABILITY_PORT?.trim();
  const port = rawPort ? Number(rawPort) : DEFAULT_STUDIO_WORKER_OBSERVABILITY_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('STUDIO_WORKER_OBSERVABILITY_PORT must be an integer from 1 through 65535');
  }
  return { hostname, port };
}

export function createStudioWorkerObservabilityServer(
  options: {
    hostname?: string;
    port?: number;
    registry?: PrometheusRegistry;
  } = {},
): StudioWorkerObservabilityServer {
  const hostname = options.hostname ?? '0.0.0.0';
  const port = options.port ?? DEFAULT_STUDIO_WORKER_OBSERVABILITY_PORT;
  const registry = options.registry ?? createPrometheusRegistry();
  const telemetry = createStudioTelemetry(createPrometheusStudioTelemetrySink(registry));
  let readinessProbe: StudioWorkerReadinessProbe | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  const handle = async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET' } });
    }
    const path = new URL(request.url).pathname;
    if (path === '/health/live') {
      return Response.json({ status: 'ok', service: 'studio-worker' });
    }
    if (path === '/health/ready') {
      if (!readinessProbe) return Response.json({ status: 'not_ready' }, { status: 503 });
      try {
        await readinessProbe();
        return Response.json({ status: 'ready' });
      } catch {
        return Response.json({ status: 'not_ready' }, { status: 503 });
      }
    }
    if (path === '/metrics') {
      return new Response(`${registry.render()}\n`, {
        headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
      });
    }
    return new Response('not found\n', { status: 404 });
  };

  return {
    telemetry,
    registry,
    handle,
    setReadinessProbe(probe) {
      readinessProbe = probe;
    },
    start() {
      if (!server) server = Bun.serve({ hostname, port, fetch: handle });
      const boundPort = server.port;
      if (boundPort === undefined)
        throw new Error('Studio worker observability port is unavailable');
      return { hostname, port: boundPort };
    },
    async stop() {
      readinessProbe = null;
      const active = server;
      server = null;
      if (active) await Promise.resolve(active.stop(true));
    },
  };
}

function createPrometheusStudioTelemetrySink(registry: PrometheusRegistry): StudioTelemetrySinks {
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
      requireMetric(counters.get(emission.name), emission.name).inc(
        emission.labels,
        emission.value,
      );
    },
    gauge(emission) {
      requireMetric(gauges.get(emission.name), emission.name).set(emission.value, emission.labels);
    },
    histogram(emission) {
      requireMetric(histograms.get(emission.name), emission.name).observe(
        emission.value,
        emission.labels,
      );
    },
  };
}

function requireMetric<T>(metric: T | undefined, name: string): T {
  if (!metric) throw new Error(`Studio Prometheus metric is not registered: ${name}`);
  return metric;
}
