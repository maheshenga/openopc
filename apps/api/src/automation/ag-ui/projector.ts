import {
  type AutomationEvent,
  AutomationEventSchema,
  OpenOpcAgUiCodeSchema,
  type OpenOpcAgUiEvent,
  OpenOpcAgUiEventSchema,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';

const UuidSchema = z.string().uuid();

export function projectAutomationEvent(event: AutomationEvent): OpenOpcAgUiEvent[] {
  const parsed = AutomationEventSchema.safeParse(event);
  if (!parsed.success) return [];
  const value = parsed.data;

  switch (value.type) {
    case 'job_queued':
      return safeEvents([{ type: 'RUN_STARTED', threadId: value.job_id, runId: value.job_id }]);
    case 'job_started':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: { stage: 'automation.running', run_id: value.job_id, status: 'running' },
        },
      ]);
    case 'step_started':
      return safeEvents([{ type: 'STEP_STARTED', stepName: stepName(value) }]);
    case 'step_completed': {
      const ids = assetIds(value.payload);
      return safeEvents([
        {
          type: 'TOOL_CALL_RESULT',
          toolCallId: stepId(value) ?? value.event_id,
          messageId: value.event_id,
          content: JSON.stringify({ asset_ids: ids }),
        },
        { type: 'STEP_FINISHED', stepName: stepName(value) },
      ]);
    }
    case 'approval_required':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: {
            stage: 'automation.approval.required',
            run_id: value.job_id,
            status: 'waiting_approval',
            approval: 'required',
          },
        },
      ]);
    case 'job_dispatched':
      return safeEvents([
        {
          type: 'STATE_SNAPSHOT',
          snapshot: { stage: 'automation.dispatched', run_id: value.job_id, status: 'running' },
        },
      ]);
    case 'job_succeeded': {
      const ids = assetIds(value.payload);
      return safeEvents([
        {
          type: 'RUN_FINISHED',
          threadId: value.job_id,
          runId: value.job_id,
          ...(ids.length > 0 ? { result: { asset_ids: ids } } : {}),
        },
      ]);
    }
    case 'job_failed':
      return safeEvents([
        {
          type: 'RUN_ERROR',
          message: 'Automation failed',
          code: publicCode(value.payload.error_code) ?? 'AUTOMATION_JOB_FAILED',
        },
      ]);
    case 'job_cancelled':
    case 'job_expired':
    case 'kill_switch_activated':
      return safeEvents([
        {
          type: 'RUN_ERROR',
          message:
            value.type === 'job_cancelled'
              ? 'Automation cancelled'
              : value.type === 'job_expired'
                ? 'Automation expired'
                : 'Automation stopped',
          code:
            value.type === 'job_cancelled'
              ? 'AUTOMATION_JOB_CANCELLED'
              : value.type === 'job_expired'
                ? 'AUTOMATION_JOB_EXPIRED'
                : 'AUTOMATION_KILLED',
        },
      ]);
    case 'heartbeat':
      return [];
  }
}

function stepId(event: AutomationEvent): string | null {
  const parsed = UuidSchema.safeParse(event.payload.step_id);
  return parsed.success ? parsed.data : null;
}

function stepName(event: AutomationEvent): string {
  return stepId(event) ?? `automation-step-${event.sequence}`;
}

function assetIds(payload: Record<string, unknown>): string[] {
  const parsed = UuidSchema.array().max(64).safeParse(payload.asset_ids);
  return parsed.success ? parsed.data : [];
}

function publicCode(value: unknown): string | undefined {
  const parsed = OpenOpcAgUiCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeEvents(events: unknown[]): OpenOpcAgUiEvent[] {
  const parsed = OpenOpcAgUiEventSchema.array().safeParse(events);
  return parsed.success ? parsed.data : [];
}
