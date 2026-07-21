import { describe, expect, test } from 'bun:test';
import { AutomationTransitionError, transitionAutomationJob } from './state-machine';

describe('automation job state machine', () => {
  test('moves an approved job through dispatch and successful execution', () => {
    let status = transitionAutomationJob('queued', { type: 'approval_required' });
    expect(status).toBe('awaiting_approval');

    status = transitionAutomationJob(status, { type: 'approval_granted' });
    expect(status).toBe('dispatched');

    status = transitionAutomationJob(status, { type: 'started' });
    expect(status).toBe('running');

    status = transitionAutomationJob(status, { type: 'succeeded' });
    expect(status).toBe('succeeded');
  });

  test('rejects attempts to restart a terminal job', () => {
    expect(() => transitionAutomationJob('succeeded', { type: 'started' })).toThrow(
      AutomationTransitionError,
    );
  });

  test('allows a running job to be cancelled', () => {
    expect(transitionAutomationJob('running', { type: 'cancelled' })).toBe('cancelled');
  });

  test('expires a running job when its fencing lease expires', () => {
    expect(transitionAutomationJob('running', { type: 'lease_expired' })).toBe('expired');
  });

  test('never retries a failure after a non-idempotent external effect committed', () => {
    expect(
      transitionAutomationJob('running', {
        type: 'failed',
        retryable: true,
        externalEffectCommitted: true,
      }),
    ).toBe('failed');
  });

  test('requeues a retryable failure only after retry is explicitly allowed', () => {
    const failed = transitionAutomationJob('running', {
      type: 'failed',
      retryable: true,
      externalEffectCommitted: false,
    });
    expect(failed).toBe('retryable');
    expect(transitionAutomationJob(failed, { type: 'retry_allowed' })).toBe('queued');
  });

  test('dispatches a queued job that does not require approval', () => {
    expect(transitionAutomationJob('queued', { type: 'dispatched' })).toBe('dispatched');
  });

  test('allows cancellation before a job is dispatched', () => {
    expect(transitionAutomationJob('queued', { type: 'cancelled' })).toBe('cancelled');
  });
});
