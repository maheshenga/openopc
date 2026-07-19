import { describe, expect, test } from 'bun:test';
import {
  IntelligenceWorkflowA2AMessageSendRequestSchema,
  IntelligenceWorkflowA2ATaskResponseSchema,
  type IntelligenceWorkflowStartRequest,
} from '@kortix/api-contract';
import type { WorkflowRun } from '@kortix/intelligence-contracts';
import {
  createA2AWorkflowAdapter,
  mapA2AWorkflowState,
  parseA2AWorkflowRequest,
} from './a2a';

const ACCOUNT_ID = '71000000-0000-4000-a000-000000000001';
const PROJECT_ID = '72000000-0000-4000-a000-000000000001';
const USER_ID = '73000000-0000-4000-a000-000000000001';
const RUN_ID = '74000000-0000-4000-a000-000000000001';
const PARENT_TASK_ID = '75000000-0000-4000-a000-000000000001';
const TOKEN_ID = '76000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const SHA256_HASH = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-07-19T10:00:00.000Z';

const request: IntelligenceWorkflowStartRequest = {
  protocol_version: 'intelligence.workflow.v1',
  idempotency_key: 'a2a-workflow-run-0001',
  goal: 'Create a governed image workflow',
  context_asset_ids: [],
  policy_snapshot_hash: SHA256_HASH,
  evaluation_version: null,
  max_nodes: 16,
  max_dependencies: 32,
  max_approved_credits: 100,
  deadline_at: null,
};

const run = (status: WorkflowRun['status'] = 'draft'): WorkflowRun => ({
  protocol_version: 'intelligence.workflow.v1',
  run_id: RUN_ID,
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  actor_type: 'agent',
  actor_id: USER_ID,
  agent_name: 'content-planner',
  idempotency_key: request.idempotency_key,
  request_hash: SHA256_HASH,
  status,
  graph_version: 3,
  policy_snapshot_hash: SHA256_HASH,
  evaluation_version: null,
  max_nodes: 16,
  max_dependencies: 32,
  max_approved_credits: 100,
  deadline_at: null,
  created_at: NOW,
  updated_at: NOW,
  terminal_at: ['succeeded', 'failed', 'cancelled'].includes(status) ? NOW : null,
});

const envelope = () => ({
  jsonrpc: '2.0' as const,
  id: 'workflow-message-1',
  method: 'message/send' as const,
  params: {
    sender_card_hash: CARD_HASH,
    task: { ...request, parent_task_id: PARENT_TASK_ID },
  },
});

const actor = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  actorUserId: USER_ID,
  actorType: 'agent' as const,
  actingTokenId: TOKEN_ID,
  agentName: 'content-planner',
};

describe('workflow A2A adapter', () => {
  test('parses a strict workflow message/send envelope without broadening the start request', () => {
    const body = envelope();
    expect(IntelligenceWorkflowA2AMessageSendRequestSchema.parse(body)).toEqual(body);
    expect(parseA2AWorkflowRequest(body)).toEqual({
      request,
      parentTaskId: PARENT_TASK_ID,
      senderCardHash: CARD_HASH,
    });
    expect(() =>
      parseA2AWorkflowRequest({
        ...body,
        params: {
          ...body.params,
          task: { ...body.params.task, provider_url: 'https://forbidden.example.test' },
        },
      }),
    ).toThrow('A2A_INVALID_REQUEST');
  });

  test('checks project Agent trust before starting and preserves parent/context IDs', async () => {
    const calls: unknown[] = [];
    const adapter = createA2AWorkflowAdapter({
      async isAgentCardTrusted(input) {
        calls.push({ trust: input });
        return true;
      },
      async start(input) {
        calls.push({ start: input });
        return { run: run(), created: true, parentTaskId: input.parentTaskId };
      },
      async get() {
        return null;
      },
    });

    const response = await adapter.start({ ...actor, body: envelope() });

    expect(IntelligenceWorkflowA2ATaskResponseSchema.parse(response)).toEqual(response);
    expect(response).toEqual({
      id: RUN_ID,
      contextId: RUN_ID,
      status: { state: 'submitted', timestamp: NOW },
      metadata: { parent_task_id: PARENT_TASK_ID, graph_version: 3 },
    });
    expect(calls[0]).toEqual({
      trust: {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        agentName: 'content-planner',
        actingTokenId: TOKEN_ID,
        senderCardHash: CARD_HASH,
      },
    });
    expect(calls[1]).toMatchObject({
      start: { request, parentTaskId: PARENT_TASK_ID, senderCardHash: CARD_HASH },
    });
    expect(JSON.stringify(response)).not.toMatch(/prompt|payload_ref|provider|credential|raw_response/i);
  });

  test('fails closed on non-Agent and untrusted senders before workflow side effects', async () => {
    let starts = 0;
    const adapter = createA2AWorkflowAdapter({
      async isAgentCardTrusted() {
        return false;
      },
      async start() {
        starts += 1;
        return { run: run(), created: true, parentTaskId: PARENT_TASK_ID };
      },
      async get() {
        return null;
      },
    });

    await expect(adapter.start({ ...actor, actorType: 'user', body: envelope() })).rejects.toThrow(
      'A2A_AGENT_UNTRUSTED',
    );
    await expect(adapter.start({ ...actor, body: envelope() })).rejects.toThrow(
      'A2A_AGENT_UNTRUSTED',
    );
    expect(starts).toBe(0);
  });

  test('rejects a workflow result outside the requested project scope', async () => {
    const adapter = createA2AWorkflowAdapter({
      async isAgentCardTrusted() {
        return true;
      },
      async start(input) {
        return {
          run: { ...run(), project_id: '72000000-0000-4000-a000-000000000099' },
          created: true,
          parentTaskId: input.parentTaskId,
        };
      },
      async get() {
        return null;
      },
    });

    await expect(adapter.start({ ...actor, body: envelope() })).rejects.toThrow(
      'A2A_INVALID_REQUEST',
    );
  });

  test('replays the same workflow idempotently without starting it twice', async () => {
    let existing = false;
    let starts = 0;
    const adapter = createA2AWorkflowAdapter({
      async isAgentCardTrusted() {
        return true;
      },
      async replay() {
        return existing ? { run: run('running'), created: false, parentTaskId: PARENT_TASK_ID } : null;
      },
      async start(input) {
        existing = true;
        starts += 1;
        return { run: run(), created: true, parentTaskId: input.parentTaskId };
      },
      async get() {
        return null;
      },
    });

    const first = await adapter.start({ ...actor, body: envelope() });
    const replay = await adapter.start({ ...actor, body: envelope() });

    expect(starts).toBe(1);
    expect(first.status.state).toBe('submitted');
    expect(replay).toMatchObject({
      id: RUN_ID,
      contextId: RUN_ID,
      status: { state: 'working' },
      metadata: { parent_task_id: PARENT_TASK_ID },
    });
  });

  test('maps every workflow terminal and approval status to stable A2A states', async () => {
    const cases: Array<[WorkflowRun['status'], ReturnType<typeof mapA2AWorkflowState>]> = [
      ['draft', 'submitted'],
      ['running', 'working'],
      ['waiting_approval', 'input-required'],
      ['succeeded', 'completed'],
      ['failed', 'failed'],
      ['cancelled', 'canceled'],
    ];
    for (const [workflowStatus, expected] of cases) {
      expect(mapA2AWorkflowState(workflowStatus)).toBe(expected);
      const adapter = createA2AWorkflowAdapter({
        async isAgentCardTrusted() {
          return true;
        },
        async start() {
          throw new Error('not used');
        },
        async get() {
          return { run: run(workflowStatus), parentTaskId: PARENT_TASK_ID };
        },
      });
      const response = await adapter.status({ ...actor, runId: RUN_ID, senderCardHash: CARD_HASH });
      expect(response).toMatchObject({
        id: RUN_ID,
        contextId: RUN_ID,
        status: { state: expected },
      });
    }
  });
});
