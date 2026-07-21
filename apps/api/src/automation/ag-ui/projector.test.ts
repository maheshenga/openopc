import { describe, expect, test } from 'bun:test';
import {
  type AutomationEvent,
  AutomationEventSchema,
  OpenOpcAgUiEventSchema,
} from '@kortix/intelligence-contracts';
import { projectAutomationEvent } from './projector';

const JOB_ID = '40000000-0000-4000-a000-000000000001';
const EVENT_ID = '60000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const ASSET_ID = '70000000-0000-4000-a000-000000000001';

function event(overrides: Partial<AutomationEvent> = {}): AutomationEvent {
  return AutomationEventSchema.parse({
    protocol_version: 'automation.v1',
    event_id: EVENT_ID,
    job_id: JOB_ID,
    sequence: 1,
    type: 'job_queued',
    status: 'queued',
    payload: {},
    trace_id: null,
    created_at: '2026-07-22T10:00:00.000Z',
    ...overrides,
  });
}

describe('automation AG-UI projector', () => {
  test('maps job, step, approval, and terminal lifecycle to the existing subset', () => {
    expect(projectAutomationEvent(event())).toEqual([
      { type: 'RUN_STARTED', threadId: JOB_ID, runId: JOB_ID },
    ]);
    expect(
      projectAutomationEvent(
        event({ type: 'step_started', status: 'running', payload: { step_id: STEP_ID } }),
      ),
    ).toEqual([{ type: 'STEP_STARTED', stepName: STEP_ID }]);
    expect(
      projectAutomationEvent(
        event({ type: 'approval_required', status: 'awaiting_approval', payload: {} }),
      ),
    ).toEqual([
      {
        type: 'STATE_SNAPSHOT',
        snapshot: {
          stage: 'automation.approval.required',
          run_id: JOB_ID,
          status: 'waiting_approval',
          approval: 'required',
        },
      },
    ]);
    expect(
      projectAutomationEvent(
        event({
          type: 'job_succeeded',
          status: 'succeeded',
          payload: { asset_ids: [ASSET_ID] },
        }),
      ),
    ).toEqual([
      { type: 'RUN_FINISHED', threadId: JOB_ID, runId: JOB_ID, result: { asset_ids: [ASSET_ID] } },
    ]);
    expect(
      projectAutomationEvent(
        event({
          type: 'job_failed',
          status: 'failed',
          payload: { error_code: 'AUTOMATION_PROVIDER_FAILED' },
        }),
      ),
    ).toEqual([
      { type: 'RUN_ERROR', message: 'Automation failed', code: 'AUTOMATION_PROVIDER_FAILED' },
    ]);
  });

  test('never projects args, credentials, signed URLs, screenshots, or internal errors', () => {
    const projected = projectAutomationEvent(
      event({
        type: 'step_completed',
        status: 'running',
        payload: {
          step_id: STEP_ID,
          asset_ids: [ASSET_ID],
          args: { prompt: 'private prompt' },
          credential_ref: 'credential-ref:00000000-0000-4000-8000-000000000123',
          worker_url: 'https://worker.example.test/run?token=private',
          screenshot: 'base64-private',
          internal_error: { stack: 'private stack' },
        },
      }),
    );
    const wire = JSON.stringify(projected);

    expect(OpenOpcAgUiEventSchema.array().parse(projected)).toEqual(projected);
    expect(wire).toContain(ASSET_ID);
    expect(wire).not.toMatch(
      /private prompt|credential-ref|worker\.example|base64-private|private stack/i,
    );
  });
});
