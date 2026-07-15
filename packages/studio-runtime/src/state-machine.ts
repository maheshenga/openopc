import type { StudioJobState } from '@kortix/api-contract';

const ALLOWED_TRANSITIONS: Record<StudioJobState, readonly StudioJobState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class StudioStateTransitionError extends Error {
  constructor(
    readonly from: StudioJobState,
    readonly to: StudioJobState,
  ) {
    super(`Invalid Studio job transition: ${from} -> ${to}`);
    this.name = 'StudioStateTransitionError';
  }
}

export function isStudioTransitionAllowed(
  from: StudioJobState,
  to: StudioJobState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertStudioTransition(from: StudioJobState, to: StudioJobState): void {
  if (!isStudioTransitionAllowed(from, to)) {
    throw new StudioStateTransitionError(from, to);
  }
}
