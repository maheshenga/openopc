import { describe, expect, test } from 'bun:test';
import {
  WorkflowStateTransitionError,
  assertWorkflowNodeTransition,
  assertWorkflowRunTransition,
} from './state';

describe('workflow run state', () => {
  test('allows declared progress and keeps terminal states monotonic', () => {
    expect(assertWorkflowRunTransition('draft', 'running')).toBe('running');

    let thrown: unknown;
    try {
      assertWorkflowRunTransition('succeeded', 'running');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkflowStateTransitionError);
    expect(thrown).toMatchObject({ code: 'WORKFLOW_INVALID_STATE_TRANSITION' });
  });

  test('allows node execution progress and keeps terminal nodes monotonic', () => {
    expect(assertWorkflowNodeTransition('ready', 'running')).toBe('running');
    expect(assertWorkflowNodeTransition('waiting_approval', 'running')).toBe('running');
    expect(() => assertWorkflowNodeTransition('failed', 'ready')).toThrow(
      WorkflowStateTransitionError,
    );
  });
});
