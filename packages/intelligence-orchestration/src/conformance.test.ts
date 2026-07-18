import type { WorkflowRun } from '@kortix/intelligence-contracts';
import { runWorkflowPortConformance } from './conformance';
import type { WorkflowPort } from './contracts';

const RUN_ID = '21000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '22000000-0000-4000-a000-000000000001';
const PROJECT_ID = '23000000-0000-4000-a000-000000000001';
const ACTOR_ID = '24000000-0000-4000-a000-000000000001';
const HASH = `sha256:${'a'.repeat(64)}`;

runWorkflowPortConformance('fixture', {
  createPort() {
    let stored: WorkflowRun | null = null;
    return {
      async startRun({ run }: { run: WorkflowRun }) {
        if (stored) return { run: stored, created: false };
        stored = run;
        return { run, created: true };
      },
    } as unknown as WorkflowPort;
  },
  run() {
    return {
      protocol_version: 'intelligence.workflow.v1',
      run_id: RUN_ID,
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_type: 'agent',
      actor_id: ACTOR_ID,
      agent_name: 'content-planner',
      idempotency_key: 'workflow-conformance-run-0001',
      request_hash: HASH,
      status: 'draft',
      graph_version: 0,
      policy_snapshot_hash: null,
      evaluation_version: null,
      max_nodes: 128,
      max_dependencies: 256,
      max_approved_credits: 5,
      deadline_at: null,
      created_at: '2026-07-18T10:00:00.000Z',
      updated_at: '2026-07-18T10:00:00.000Z',
      terminal_at: null,
    };
  },
});
