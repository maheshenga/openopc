import type { AutomationJobStatus } from '@kortix/intelligence-contracts';

export type AutomationTransitionEvent =
  | { type: 'approval_required' }
  | { type: 'approval_granted' }
  | { type: 'dispatched' }
  | { type: 'started' }
  | { type: 'succeeded' }
  | { type: 'failed'; retryable: boolean; externalEffectCommitted: boolean }
  | { type: 'cancelled' }
  | { type: 'lease_expired' }
  | { type: 'retry_allowed' };

const CANCELLABLE_STATUSES: ReadonlySet<AutomationJobStatus> = new Set([
  'queued',
  'awaiting_approval',
  'dispatched',
  'running',
  'retryable',
]);

export class AutomationTransitionError extends Error {
  readonly code = 'AUTOMATION_INVALID_TRANSITION' as const;

  constructor(
    readonly current: AutomationJobStatus,
    readonly event: AutomationTransitionEvent,
  ) {
    super(`Cannot apply ${event.type} to automation job in ${current}`);
    this.name = 'AutomationTransitionError';
  }
}

export function transitionAutomationJob(
  current: AutomationJobStatus,
  event: AutomationTransitionEvent,
): AutomationJobStatus {
  if (current === 'queued' && event.type === 'approval_required') return 'awaiting_approval';
  if (current === 'queued' && event.type === 'dispatched') return 'dispatched';
  if (current === 'awaiting_approval' && event.type === 'approval_granted') return 'dispatched';
  if (current === 'dispatched' && event.type === 'started') return 'running';
  if (current === 'running' && event.type === 'succeeded') return 'succeeded';
  if (event.type === 'cancelled' && CANCELLABLE_STATUSES.has(current)) return 'cancelled';
  if (current === 'running' && event.type === 'lease_expired') return 'expired';
  if (current === 'running' && event.type === 'failed') {
    return event.retryable && !event.externalEffectCommitted ? 'retryable' : 'failed';
  }
  if (current === 'retryable' && event.type === 'retry_allowed') return 'queued';

  throw new AutomationTransitionError(current, event);
}
