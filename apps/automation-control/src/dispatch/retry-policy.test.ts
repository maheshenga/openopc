import { describe, expect, test } from 'bun:test';
import type { AutomationStep } from '@kortix/intelligence-contracts';
import { decideAutomationRetry } from './retry-policy';

const STEP_ID = '50000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}` as const;

function step(action: string, risk: AutomationStep['risk']): AutomationStep {
  return {
    step_id: STEP_ID,
    sequence: 1,
    action,
    args: {},
    risk,
    action_hash: HASH,
  };
}

describe('automation retry policy', () => {
  test('automatically retries only allowlisted idempotent observation actions', () => {
    for (const current of [
      step('browser.read', 'observe'),
      step('browser.screenshot', 'observe'),
      step('browser.wait', 'observe'),
      step('desktop.read_screen', 'observe'),
      step('desktop.list_windows', 'observe'),
    ]) {
      expect(
        decideAutomationRetry({
          step: current,
          outcome: 'worker_lost',
          leaseRecoverable: true,
          deadlineAt: '2026-07-22T08:05:00.000Z',
          now: new Date('2026-07-22T08:00:00.000Z'),
        }),
      ).toEqual({ disposition: 'retry', nextStatus: 'retryable' });
    }
  });

  test('never automatically retries click, submit, payment, delete, send, or unknown actions', () => {
    for (const current of [
      step('browser.click', 'operate'),
      step('browser.submit', 'external_effect'),
      step('browser.payment', 'external_effect'),
      step('browser.delete', 'external_effect'),
      step('browser.send', 'external_effect'),
      step('desktop.mouse', 'operate'),
      step('desktop.submit', 'external_effect'),
      step('module.unknown', 'observe'),
    ]) {
      expect(
        decideAutomationRetry({
          step: current,
          outcome: 'unknown',
          leaseRecoverable: true,
          deadlineAt: '2026-07-22T08:05:00.000Z',
          now: new Date('2026-07-22T08:00:00.000Z'),
        }),
      ).toEqual({ disposition: 'manual_review', nextStatus: 'retryable' });
    }
  });

  test('expires instead of retrying after the signed deadline or when the lease cannot recover', () => {
    const input = {
      step: step('browser.read', 'observe'),
      outcome: 'worker_lost' as const,
      deadlineAt: '2026-07-22T08:00:00.000Z',
      now: new Date('2026-07-22T08:00:00.000Z'),
    };
    expect(decideAutomationRetry({ ...input, leaseRecoverable: true })).toEqual({
      disposition: 'expire',
      nextStatus: 'expired',
    });
    expect(
      decideAutomationRetry({
        ...input,
        deadlineAt: '2026-07-22T08:05:00.000Z',
        leaseRecoverable: false,
      }),
    ).toEqual({ disposition: 'manual_review', nextStatus: 'retryable' });
  });

  test('does not retry an observation action when the reported catalog risk is inconsistent', () => {
    expect(
      decideAutomationRetry({
        step: step('browser.read', 'operate'),
        outcome: 'worker_lost',
        leaseRecoverable: true,
        deadlineAt: '2026-07-22T08:05:00.000Z',
        now: new Date('2026-07-22T08:00:00.000Z'),
      }),
    ).toEqual({ disposition: 'manual_review', nextStatus: 'retryable' });
  });

  test('sends unknown outcomes to manual review even for allowlisted observations', () => {
    expect(
      decideAutomationRetry({
        step: step('browser.read', 'observe'),
        outcome: 'unknown',
        leaseRecoverable: true,
        deadlineAt: '2026-07-22T08:05:00.000Z',
        now: new Date('2026-07-22T08:00:00.000Z'),
      }),
    ).toEqual({ disposition: 'manual_review', nextStatus: 'retryable' });
  });
});
