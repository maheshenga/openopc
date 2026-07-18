import { describe, expect, test } from 'bun:test';
import {
  workflowApprovalFixture,
  workflowDependencyFixture,
  workflowEventFixture,
  workflowNodeFixture,
  workflowRunFixture,
} from './fixtures';

describe('workflow fixtures', () => {
  test('builds one deterministic internally-linked workflow fixture set', () => {
    const run = workflowRunFixture();
    const node = workflowNodeFixture();
    const dependency = workflowDependencyFixture();
    const approval = workflowApprovalFixture();
    const event = workflowEventFixture();

    expect(node.run_id).toBe(run.run_id);
    expect(dependency.run_id).toBe(run.run_id);
    expect(approval).toMatchObject({ run_id: run.run_id, node_id: node.node_id });
    expect(event).toMatchObject({ run_id: run.run_id, sequence: 1 });
    expect(workflowRunFixture({ status: 'running' }).status).toBe('running');
  });
});
