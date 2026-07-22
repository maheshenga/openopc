import type { AutomationJobStatus, AutomationStep } from '@kortix/intelligence-contracts';

const IDEMPOTENT_ACTION_RISKS: Readonly<Record<string, 'observe'>> = Object.freeze({
  'browser.read': 'observe',
  'browser.screenshot': 'observe',
  'browser.wait': 'observe',
  'desktop.read_screen': 'observe',
  'desktop.list_windows': 'observe',
});

export type AutomationRetryOutcome =
  | 'worker_lost'
  | 'lease_expired'
  | 'transport_error'
  | 'unknown';

export type AutomationRetryDecision = Readonly<{
  disposition: 'retry' | 'manual_review' | 'expire';
  nextStatus: Extract<AutomationJobStatus, 'retryable' | 'expired'>;
}>;

export function decideAutomationRetry(input: {
  step: AutomationStep;
  outcome: AutomationRetryOutcome;
  leaseRecoverable: boolean;
  deadlineAt: string;
  now: Date;
}): AutomationRetryDecision {
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= input.now.getTime()) {
    return { disposition: 'expire', nextStatus: 'expired' };
  }
  const expectedRisk = IDEMPOTENT_ACTION_RISKS[input.step.action];
  if (
    input.outcome !== 'unknown' &&
    input.leaseRecoverable &&
    expectedRisk !== undefined &&
    expectedRisk === input.step.risk
  ) {
    return { disposition: 'retry', nextStatus: 'retryable' };
  }
  return { disposition: 'manual_review', nextStatus: 'retryable' };
}
