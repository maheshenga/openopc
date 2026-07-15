import { describe, expect, test } from 'bun:test';
import { assertStudioTransition, isStudioTransitionAllowed } from './state-machine';

describe('Studio job state machine', () => {
  test('allows queued jobs to run and rejects skipping directly to success', () => {
    expect(isStudioTransitionAllowed('queued', 'running')).toBe(true);
    expect(() => assertStudioTransition('queued', 'running')).not.toThrow();

    expect(isStudioTransitionAllowed('queued', 'succeeded')).toBe(false);
    expect(() => assertStudioTransition('queued', 'succeeded')).toThrow(
      'Invalid Studio job transition: queued -> succeeded',
    );
  });
});
