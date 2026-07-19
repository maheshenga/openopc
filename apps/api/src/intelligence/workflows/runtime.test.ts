import { describe, expect, test } from 'bun:test';
import type { WorkflowTelemetry } from './metrics';
import {
  buildIntelligenceWorkflowRuntime,
  setDefaultIntelligenceWorkflowRuntime,
  startDefaultIntelligenceWorkflowRuntime,
  stopDefaultIntelligenceWorkflowRuntime,
} from './runtime';
import type { WorkflowAgentRoles } from './runtime';
import type { WorkflowService } from './service';

describe('intelligence workflow runtime', () => {
  test('does not construct workflow dependencies when the default-disabled flag is absent', () => {
    let serviceConstructions = 0;
    let schedulerConstructions = 0;
    let agentRoleConstructions = 0;
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
      createAgentRoles() {
        agentRoleConstructions += 1;
        throw new Error('must not construct');
      },
    });

    expect(runtime).toEqual({ enabled: false });
    expect({ serviceConstructions, schedulerConstructions, agentRoleConstructions }).toEqual({
      serviceConstructions: 0,
      schedulerConstructions: 0,
      agentRoleConstructions: 0,
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
    const telemetry = {} as WorkflowTelemetry;
    const calls: string[] = [];
    const runtime = buildIntelligenceWorkflowRuntime({
      enabled: true,
      telemetry,
      createService: () => service,
      createScheduler(receivedService, receivedTelemetry) {
        expect(receivedService).toBe(service);
        expect(receivedTelemetry).toBe(telemetry);
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
    expect(runtime.telemetry).toBe(telemetry);
    runtime.start();
    await runtime.stop();
    expect(calls).toEqual(['construct', 'start', 'stop']);
  });

  test('constructs the separately enabled Temporal coordinator instead of the default scheduler', async () => {
    const service = {} as WorkflowService;
    const calls: string[] = [];
    const runtime = buildIntelligenceWorkflowRuntime({
      env: {
        INTELLIGENCE_WORKFLOWS_ENABLED: 'true',
        INTELLIGENCE_TEMPORAL_ADAPTER_ENABLED: 'true',
      },
      createService: () => service,
      createScheduler() {
        calls.push('scheduler');
        throw new Error('default scheduler must not be constructed');
      },
      createTemporalCoordinator(receivedService) {
        expect(receivedService).toBe(service);
        calls.push('temporal');
        return {
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
    expect(calls).toEqual(['temporal', 'start', 'stop']);
  });

  test('constructs governed Agent role ports only inside the enabled runtime', () => {
    const service = {} as WorkflowService;
    const agentRoles = {
      planner: {} as WorkflowAgentRoles['planner'],
      executor: {} as WorkflowAgentRoles['executor'],
      reviewer: {} as WorkflowAgentRoles['reviewer'],
    };
    const calls: string[] = [];
    const runtime = buildIntelligenceWorkflowRuntime({
      enabled: true,
      createService: () => service,
      createAgentRoles(receivedService) {
        expect(receivedService).toBe(service);
        calls.push('roles');
        return agentRoles;
      },
    });

    if (!runtime.enabled) throw new Error('runtime must be enabled');
    expect(runtime.agentRoles).toBe(agentRoles);
    expect(calls).toEqual(['roles']);
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
