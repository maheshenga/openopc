import type { WorkflowService } from './service';

export type IntelligenceWorkflowRuntime =
  | { enabled: false }
  | { enabled: true; service: WorkflowService };

export function buildIntelligenceWorkflowRuntime(input: {
  env?: Record<string, string | undefined>;
  enabled?: boolean;
  createService: () => WorkflowService;
}): IntelligenceWorkflowRuntime {
  const enabled = input.enabled ?? input.env?.INTELLIGENCE_WORKFLOWS_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  return { enabled: true, service: input.createService() };
}
