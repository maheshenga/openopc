import type { WorkflowExecutorPort } from './agents';
import type { PlannerPort } from './planner';
import type { ReviewerPort } from './reviewer';
import type { WorkflowScheduler } from './scheduler';
import type { WorkflowService } from './service';

export type WorkflowAgentRoles = {
  planner: PlannerPort;
  executor: WorkflowExecutorPort;
  reviewer: ReviewerPort;
};

export type IntelligenceWorkflowRuntime =
  | { enabled: false }
  | {
      enabled: true;
      service: WorkflowService;
      agentRoles?: WorkflowAgentRoles;
      start(): void;
      stop(): Promise<void>;
    };

let defaultIntelligenceWorkflowRuntime: IntelligenceWorkflowRuntime = { enabled: false };

export function buildIntelligenceWorkflowRuntime(input: {
  env?: Record<string, string | undefined>;
  enabled?: boolean;
  createService: () => WorkflowService;
  createScheduler?: (service: WorkflowService) => WorkflowScheduler;
  createAgentRoles?: (service: WorkflowService) => WorkflowAgentRoles;
}): IntelligenceWorkflowRuntime {
  const enabled = input.enabled ?? input.env?.INTELLIGENCE_WORKFLOWS_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  const service = input.createService();
  const scheduler = input.createScheduler?.(service);
  const agentRoles = input.createAgentRoles?.(service);
  return {
    enabled: true,
    service,
    ...(agentRoles ? { agentRoles } : {}),
    start: () => scheduler?.start(),
    stop: () => scheduler?.stop() ?? Promise.resolve(),
  };
}

export function setDefaultIntelligenceWorkflowRuntime(runtime: IntelligenceWorkflowRuntime): void {
  defaultIntelligenceWorkflowRuntime = runtime;
}

export function startDefaultIntelligenceWorkflowRuntime(): void {
  if (defaultIntelligenceWorkflowRuntime.enabled) {
    defaultIntelligenceWorkflowRuntime.start();
  }
}

export async function stopDefaultIntelligenceWorkflowRuntime(): Promise<void> {
  if (defaultIntelligenceWorkflowRuntime.enabled) {
    await defaultIntelligenceWorkflowRuntime.stop();
  }
}
