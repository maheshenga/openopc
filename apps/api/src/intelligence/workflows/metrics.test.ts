import { describe, expect, test } from 'bun:test';
import { type WorkflowMetricEmission, createWorkflowTelemetry } from './metrics';

const TRACEPARENT = '00-11111111111111111111111111111111-2222222222222222-01';

describe('Intelligence workflow telemetry', () => {
  test('emits only bounded scheduler metrics and W3C-correlated GenAI trace attributes', () => {
    const emissions: WorkflowMetricEmission[] = [];
    const telemetry = createWorkflowTelemetry({
      counter: (emission) => emissions.push(emission),
      histogram: (emission) => emissions.push(emission),
      span: (emission) => emissions.push(emission),
    });

    telemetry.schedulerRun({
      outcome: 'succeeded',
      durationSeconds: 0.25,
      traceparent: TRACEPARENT,
      stats: {
        scopes: 1,
        claimed: 2,
        attached: 1,
        completed: 1,
        failed: 0,
        leaseLost: 1,
      },
    });

    expect(emissions).toEqual([
      {
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_runs_total',
        value: 1,
        labels: { outcome: 'succeeded' },
      },
      {
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_nodes_total',
        value: 2,
        labels: { outcome: 'claimed' },
      },
      {
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_nodes_total',
        value: 1,
        labels: { outcome: 'attached' },
      },
      {
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_nodes_total',
        value: 1,
        labels: { outcome: 'completed' },
      },
      {
        kind: 'counter',
        name: 'intelligence_workflow_scheduler_nodes_total',
        value: 1,
        labels: { outcome: 'lease_lost' },
      },
      {
        kind: 'histogram',
        name: 'intelligence_workflow_scheduler_run_duration_seconds',
        value: 0.25,
        labels: { outcome: 'succeeded' },
      },
      {
        kind: 'span',
        name: 'intelligence.workflow.scheduler.run',
        traceparent: TRACEPARENT,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.system': 'kortix',
          'gen_ai.tool.name': 'studio.image.generate',
          'kortix.workflow.outcome': 'succeeded',
        },
      },
    ]);

    const wire = JSON.stringify(emissions);
    expect(wire).not.toMatch(
      /account_id|project_id|tenant|prompt|response|object_ref|signed_url|provider_url|error_message/i,
    );
  });

  test('rejects invalid values before a sink can export them', () => {
    const telemetry = createWorkflowTelemetry({
      counter: () => {},
      histogram: () => {},
      span: () => {},
    });
    const stats = {
      scopes: 0,
      claimed: 0,
      attached: 0,
      completed: 0,
      failed: 0,
      leaseLost: 0,
    };

    expect(() =>
      telemetry.schedulerRun({
        outcome: 'failed',
        durationSeconds: -1,
        traceparent: TRACEPARENT,
        stats,
      }),
    ).toThrow('Invalid Intelligence workflow telemetry duration');
    expect(() =>
      telemetry.schedulerRun({
        outcome: 'failed',
        durationSeconds: 0,
        traceparent: 'private trace value',
        stats,
      }),
    ).toThrow('Invalid Intelligence workflow telemetry traceparent');
  });
});
