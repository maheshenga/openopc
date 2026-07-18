import { expect, test } from 'bun:test';
import type { Database } from '@kortix/db';
import { WORKFLOW_PORT_METHODS } from '@kortix/intelligence-orchestration';
import { createPostgresWorkflowStore } from './postgres-store';

test('constructs the complete WorkflowPort without opening a connection', () => {
  const store = createPostgresWorkflowStore({} as Database);

  expect(Object.keys(store).sort()).toEqual([...WORKFLOW_PORT_METHODS].sort());
  for (const method of WORKFLOW_PORT_METHODS) {
    expect(store[method]).toBeInstanceOf(Function);
  }
});
