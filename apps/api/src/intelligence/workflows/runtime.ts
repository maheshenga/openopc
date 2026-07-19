import type { WorkflowExecutorPort } from './agents';
import type { WorkflowTelemetry } from './metrics';
import type { PlannerPort } from './planner';
import type { ReviewerPort } from './reviewer';
import type { WorkflowScheduler } from './scheduler';
import type { WorkflowService } from './service';

export type WorkflowAgentRoles = {
  planner: PlannerPort;
  executor: WorkflowExecutorPort;
  reviewer: ReviewerPort;
};

export type WorkflowTemporalCoordinator = {
  start(): void;
  stop(): Promise<void>;
};

export type IntelligenceWorkflowRuntime =
  | { enabled: false }
  | {
      enabled: true;
      service: WorkflowService;
      agentRoles?: WorkflowAgentRoles;
      telemetry?: WorkflowTelemetry;
      start(): void;
      stop(): Promise<void>;
    };

let defaultIntelligenceWorkflowRuntime: IntelligenceWorkflowRuntime = { enabled: false };

export function buildIntelligenceWorkflowRuntime(input: {
  env?: Record<string, string | undefined>;
  enabled?: boolean;
  telemetry?: WorkflowTelemetry;
  createService: () => WorkflowService;
  createScheduler?: (
    service: WorkflowService,
    telemetry: WorkflowTelemetry | undefined,
  ) => WorkflowScheduler;
  createTemporalCoordinator?: (service: WorkflowService) => WorkflowTemporalCoordinator;
  createAgentRoles?: (service: WorkflowService) => WorkflowAgentRoles;
}): IntelligenceWorkflowRuntime {
  const enabled = input.enabled ?? input.env?.INTELLIGENCE_WORKFLOWS_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  const service = input.createService();
  const temporalEnabled = input.env?.INTELLIGENCE_TEMPORAL_ADAPTER_ENABLED === 'true';
  const temporalCoordinator = temporalEnabled
    ? input.createTemporalCoordinator?.(service)
    : undefined;
  if (temporalEnabled && !temporalCoordinator) {
    throw new Error('INTELLIGENCE_TEMPORAL_ADAPTER_UNAVAILABLE');
  }
  const scheduler = temporalCoordinator
    ? undefined
    : input.createScheduler?.(service, input.telemetry);
  const agentRoles = input.createAgentRoles?.(service);
  return {
    enabled: true,
    service,
    ...(agentRoles ? { agentRoles } : {}),
    ...(input.telemetry ? { telemetry: input.telemetry } : {}),
    start: () => temporalCoordinator?.start() ?? scheduler?.start(),
    stop: () => temporalCoordinator?.stop() ?? scheduler?.stop() ?? Promise.resolve(),
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
