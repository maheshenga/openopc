import { describe, expect, test } from 'bun:test';
import type { AppendAutomationEventInput } from './event-store';
import {
  AutomationEventTransitionMismatchError,
  automationEventRequiresLease,
  resolveAutomationEventStatus,
} from './event-store';

const EVENT_INPUT: AppendAutomationEventInput = {
  accountId: '10000000-0000-4000-a000-000000000001',
  projectId: '20000000-0000-4000-a000-000000000001',
  jobId: '30000000-0000-4000-a000-000000000001',
  leaseOwner: 'browser-worker-1:40000000-0000-4000-a000-000000000001',
  killSwitchGeneration: 7,
  event: {
    protocol_version: 'automation.v1',
    type: 'approval_required',
    status: 'awaiting_approval',
    payload: {},
    trace_id: null,
  },
  transition: { type: 'execution_approval_required' },
  occurredAt: new Date('2026-07-22T10:00:00.000Z'),
};

describe('automation event store semantics', () => {
  test('requires the current lease for execution-time approval pause', () => {
    expect(resolveAutomationEventStatus('running', EVENT_INPUT)).toBe('awaiting_approval');
    expect(automationEventRequiresLease(EVENT_INPUT)).toBeTrue();
  });

  test('keeps pre-dispatch approval pause lease-free', () => {
    const input: AppendAutomationEventInput = {
      ...EVENT_INPUT,
      leaseOwner: null,
      transition: { type: 'approval_required' },
    };

    expect(resolveAutomationEventStatus('queued', input)).toBe('awaiting_approval');
    expect(automationEventRequiresLease(input)).toBeFalse();
  });

  test('rejects a public event that does not match execution-time approval', () => {
    const input: AppendAutomationEventInput = {
      ...EVENT_INPUT,
      event: {
        ...EVENT_INPUT.event,
        type: 'job_started',
        status: 'running',
      },
    };

    expect(() => resolveAutomationEventStatus('running', input)).toThrow(
      AutomationEventTransitionMismatchError,
    );
  });
});
