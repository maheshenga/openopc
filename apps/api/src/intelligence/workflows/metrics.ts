import type { WorkflowSchedulerStats } from './scheduler';

export type WorkflowSchedulerOutcome = 'succeeded' | 'not_ready' | 'failed';
export type WorkflowSchedulerNodeOutcome =
  | 'claimed'
  | 'attached'
  | 'completed'
  | 'failed'
  | 'lease_lost';

type CounterEmission =
  | {
      kind: 'counter';
      name: 'intelligence_workflow_scheduler_runs_total';
      value: number;
      labels: { outcome: WorkflowSchedulerOutcome };
    }
  | {
      kind: 'counter';
      name: 'intelligence_workflow_scheduler_nodes_total';
      value: number;
      labels: { outcome: WorkflowSchedulerNodeOutcome };
    };

type HistogramEmission = {
  kind: 'histogram';
  name: 'intelligence_workflow_scheduler_run_duration_seconds';
  value: number;
  labels: { outcome: WorkflowSchedulerOutcome };
};

type SpanEmission = {
  kind: 'span';
  name: 'intelligence.workflow.scheduler.run';
  traceparent: string;
  attributes: {
    'gen_ai.operation.name': 'execute_tool';
    'gen_ai.system': 'kortix';
    'gen_ai.tool.name': 'studio.image.generate';
    'kortix.workflow.outcome': WorkflowSchedulerOutcome;
  };
};

export type WorkflowMetricEmission = CounterEmission | HistogramEmission | SpanEmission;

export type WorkflowTelemetrySinks = {
  counter(emission: CounterEmission): void;
  histogram(emission: HistogramEmission): void;
  span(emission: SpanEmission): void;
};

export type WorkflowSchedulerTelemetryRecord = {
  outcome: WorkflowSchedulerOutcome;
  durationSeconds: number;
  traceparent: string | null;
  stats: WorkflowSchedulerStats;
};

export type WorkflowTelemetry = {
  schedulerRun(record: WorkflowSchedulerTelemetryRecord): void;
};

const W3C_TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-(?:00|01)$/;

export function createWorkflowTelemetry(sinks: WorkflowTelemetrySinks): WorkflowTelemetry {
  return {
    schedulerRun(record) {
      assertRecord(record);
      sinks.counter({
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_runs_total',
        value: 1,
        labels: { outcome: record.outcome },
      });
      emitNodeCount(sinks, 'claimed', record.stats.claimed);
      emitNodeCount(sinks, 'attached', record.stats.attached);
      emitNodeCount(sinks, 'completed', record.stats.completed);
      emitNodeCount(sinks, 'failed', record.stats.failed);
      emitNodeCount(sinks, 'lease_lost', record.stats.leaseLost);
      sinks.histogram({
        kind: 'histogram',
        name: 'intelligence_workflow_scheduler_run_duration_seconds',
        value: record.durationSeconds,
        labels: { outcome: record.outcome },
      });
      if (record.traceparent) {
        sinks.span({
          kind: 'span',
          name: 'intelligence.workflow.scheduler.run',
          traceparent: record.traceparent,
          attributes: {
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.system': 'kortix',
            'gen_ai.tool.name': 'studio.image.generate',
            'kortix.workflow.outcome': record.outcome,
          },
        });
      }
    },
  };
}

function emitNodeCount(
  sinks: Pick<WorkflowTelemetrySinks, 'counter'>,
  outcome: WorkflowSchedulerNodeOutcome,
  value: number,
): void {
  if (value === 0) return;
  sinks.counter({
    kind: 'counter',
    name: 'intelligence_workflow_scheduler_nodes_total',
    value,
    labels: { outcome },
  });
}

function assertRecord(record: WorkflowSchedulerTelemetryRecord): void {
  if (!['succeeded', 'not_ready', 'failed'].includes(record.outcome)) {
    throw new TypeError('Invalid Intelligence workflow telemetry outcome');
  }
  if (!Number.isFinite(record.durationSeconds) || record.durationSeconds < 0) {
    throw new RangeError('Invalid Intelligence workflow telemetry duration');
  }
  if (record.traceparent !== null && !W3C_TRACEPARENT.test(record.traceparent)) {
    throw new TypeError('Invalid Intelligence workflow telemetry traceparent');
  }
  for (const value of Object.values(record.stats)) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      throw new RangeError('Invalid Intelligence workflow telemetry stats');
    }
  }
}
