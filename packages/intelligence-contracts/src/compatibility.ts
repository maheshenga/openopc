import { z } from 'zod';

export const INTELLIGENCE_PROTOCOL_VERSION = 'intelligence.v1' as const;
export const WORKFLOW_PROTOCOL_VERSION = 'intelligence.workflow.v1' as const;
export const AUTOMATION_PROTOCOL_VERSION = 'automation.v1' as const;

export const ProtocolVersionSchema = z.literal(INTELLIGENCE_PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export const WorkflowProtocolVersionSchema = z.literal(WORKFLOW_PROTOCOL_VERSION);
export type WorkflowProtocolVersion = z.infer<typeof WorkflowProtocolVersionSchema>;
export const AutomationProtocolVersionSchema = z.literal(AUTOMATION_PROTOCOL_VERSION);
export type AutomationProtocolVersion = z.infer<typeof AutomationProtocolVersionSchema>;

export class UnsupportedIntelligenceProtocolError extends Error {
  readonly code = 'INTELLIGENCE_PROTOCOL_UNSUPPORTED' as const;

  constructor() {
    super('unsupported intelligence protocol version');
    this.name = 'UnsupportedIntelligenceProtocolError';
  }
}

export class UnsupportedAutomationProtocolError extends Error {
  readonly code = 'AUTOMATION_PROTOCOL_UNSUPPORTED' as const;

  constructor() {
    super('unsupported automation protocol version');
    this.name = 'UnsupportedAutomationProtocolError';
  }
}

export function assertSupportedProtocolVersion(value: unknown): ProtocolVersion {
  const parsed = ProtocolVersionSchema.safeParse(value);
  if (!parsed.success) throw new UnsupportedIntelligenceProtocolError();
  return parsed.data;
}

export function assertSupportedWorkflowProtocolVersion(value: unknown): WorkflowProtocolVersion {
  const parsed = WorkflowProtocolVersionSchema.safeParse(value);
  if (!parsed.success) throw new UnsupportedIntelligenceProtocolError();
  return parsed.data;
}

export function assertSupportedAutomationProtocolVersion(
  value: unknown,
): AutomationProtocolVersion {
  const parsed = AutomationProtocolVersionSchema.safeParse(value);
  if (!parsed.success) throw new UnsupportedAutomationProtocolError();
  return parsed.data;
}
