import { describe, expect, test } from 'bun:test';
import { WORKFLOW_PORT_METHODS } from './contracts';

describe('WorkflowPort contract', () => {
  test('keeps one stable command and read surface for every adapter', () => {
    expect(WORKFLOW_PORT_METHODS).toEqual([
      'startRun',
      'appendNode',
      'addDependency',
      'sealGraph',
      'claimReadyNode',
      'heartbeatNode',
      'attachTask',
      'completeNode',
      'failNode',
      'pauseForApproval',
      'resolveApproval',
      'resumeRun',
      'cancelRun',
      'getRun',
      'readEvents',
    ]);
  });
});
