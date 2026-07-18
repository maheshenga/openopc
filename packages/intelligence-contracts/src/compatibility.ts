import { z } from 'zod';

export const INTELLIGENCE_PROTOCOL_VERSION = 'intelligence.v1' as const;
export const WORKFLOW_PROTOCOL_VERSION = 'intelligence.workflow.v1' as const;

export const ProtocolVersionSchema = z.literal(INTELLIGENCE_PROTOCOL_VERSION);
export type ProtocolVersion = z.infer<typeof ProtocolVersionSchema>;
export const WorkflowProtocolVersionSchema = z.literal(WORKFLOW_PROTOCOL_VERSION);
export type WorkflowProtocolVersion = z.infer<typeof WorkflowProtocolVersionSchema>;

export class UnsupportedIntelligenceProtocolError extends Error {
  readonly code = 'INTELLIGENCE_PROTOCOL_UNSUPPORTED' as const;

  constructor() {
    super('unsupported intelligence protocol version');
    this.name = 'UnsupportedIntelligenceProtocolError';
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
