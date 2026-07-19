import { describe, expect, test } from 'bun:test';
import {
  buildIntelligenceWorkflowRuntime,
  setDefaultIntelligenceWorkflowRuntime,
  startDefaultIntelligenceWorkflowRuntime,
  stopDefaultIntelligenceWorkflowRuntime,
} from './runtime';
import type { WorkflowService } from './service';

describe('intelligence workflow runtime', () => {
  test('does not construct workflow dependencies when the default-disabled flag is absent', () => {
    let serviceConstructions = 0;
    let schedulerConstructions = 0;
    const runtime = buildIntelligenceWorkflowRuntime({
      env: {},
      createService() {
        serviceConstructions += 1;
        return {} as WorkflowService;
      },
      createScheduler() {
        schedulerConstructions += 1;
        throw new Error('must not construct');
      },
    });

    expect(runtime).toEqual({ enabled: false });
    expect({ serviceConstructions, schedulerConstructions }).toEqual({
      serviceConstructions: 0,
      schedulerConstructions: 0,
    });
  });

  test('constructs one service only for the exact enabled flag', () => {
    let constructions = 0;
    const service = {} as WorkflowService;
    const runtime = buildIntelligenceWorkflowRuntime({
      env: { INTELLIGENCE_WORKFLOWS_ENABLED: 'true' },
      createService() {
        constructions += 1;
        return service;
      },
    });

    expect(runtime).toMatchObject({ enabled: true, service });
    if (!runtime.enabled) throw new Error('runtime must be enabled');
    expect(typeof runtime.start).toBe('function');
    expect(typeof runtime.stop).toBe('function');
    expect(constructions).toBe(1);
  });

  test('owns the injected scheduler lifecycle when enabled', async () => {
    const service = {} as WorkflowService;
    const calls: string[] = [];
    const runtime = buildIntelligenceWorkflowRuntime({
      enabled: true,
      createService: () => service,
      createScheduler(receivedService) {
        expect(receivedService).toBe(service);
        calls.push('construct');
        return {
          runOnce: async () => ({
            scopes: 0,
            claimed: 0,
            attached: 0,
            completed: 0,
            failed: 0,
            leaseLost: 0,
          }),
          start: () => {
            calls.push('start');
          },
          stop: async () => {
            calls.push('stop');
          },
        };
      },
    });

    if (!runtime.enabled) throw new Error('runtime must be enabled');
    runtime.start();
    await runtime.stop();
    expect(calls).toEqual(['construct', 'start', 'stop']);
  });

  test('delegates the process-level lifecycle to the registered enabled runtime', async () => {
    const calls: string[] = [];
    setDefaultIntelligenceWorkflowRuntime({
      enabled: true,
      service: {} as WorkflowService,
      start: () => {
        calls.push('start');
      },
      stop: async () => {
        calls.push('stop');
      },
    });

    startDefaultIntelligenceWorkflowRuntime();
    await stopDefaultIntelligenceWorkflowRuntime();
    setDefaultIntelligenceWorkflowRuntime({ enabled: false });

    expect(calls).toEqual(['start', 'stop']);
  });
});
