import { describe, expect, test } from 'bun:test';
import * as orchestration from './index';

describe('orchestration package boundary', () => {
  test('keeps the Bun test conformance helper out of the production root entrypoint', () => {
    expect(orchestration).not.toHaveProperty('runWorkflowPortConformance');
    expect(orchestration).not.toHaveProperty('workflowRunFixture');
  });
});
