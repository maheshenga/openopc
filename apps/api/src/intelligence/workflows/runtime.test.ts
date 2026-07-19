import { describe, expect, test } from 'bun:test';
import { buildIntelligenceWorkflowRuntime } from './runtime';
import type { WorkflowService } from './service';

describe('intelligence workflow runtime', () => {
  test('does not construct workflow dependencies when the default-disabled flag is absent', () => {
    let constructions = 0;
    const runtime = buildIntelligenceWorkflowRuntime({
      env: {},
      createService() {
        constructions += 1;
        return {} as WorkflowService;
      },
    });

    expect(runtime).toEqual({ enabled: false });
    expect(constructions).toBe(0);
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

    expect(runtime).toEqual({ enabled: true, service });
    expect(constructions).toBe(1);
  });
});
