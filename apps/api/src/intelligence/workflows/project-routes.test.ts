import { describe, expect, test } from 'bun:test';
import type {
  IntelligenceWorkflowApprovalDecisionRequest,
  IntelligenceWorkflowAddDependencyRequest,
  IntelligenceWorkflowAppendNodeRequest,
  IntelligenceWorkflowSealRequest,
  IntelligenceWorkflowStartRequest,
} from '@kortix/api-contract';
import type { WorkflowApproval, WorkflowNode } from '@kortix/intelligence-contracts';
import { InMemoryStudioObjectStore } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { createMemoryWorkflowStore } from './memory-store';
import { createStudioWorkflowPayloadStore } from './payload-store';
import { createIntelligenceWorkflowProjectRoutes } from './project-routes';
import { createWorkflowService } from './service';

const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '64000000-0000-4000-a000-000000000002';
const USER_ID = '66000000-0000-4000-a000-000000000001';
const RUN_ID = '61000000-0000-4000-a000-000000000001';
const NODE_ID = '62000000-0000-4000-a000-000000000001';
const OTHER_NODE_ID = '62000000-0000-4000-a000-000000000002';
const THIRD_NODE_ID = '62000000-0000-4000-a000-000000000003';
const DEPENDENCY_ID = '65000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '67000000-0000-4000-a000-000000000001';
const IAM_TOKEN_ID = '68000000-0000-4000-a000-000000000001';
const CARD_HASH = 'b'.repeat(64);
const SHA256_HASH = `sha256:${'a'.repeat(64)}`;
const NOW = '2026-07-18T10:00:00.000Z';

const startRequest = (): IntelligenceWorkflowStartRequest => ({
  protocol_version: 'intelligence.workflow.v1',
  idempotency_key: 'workflow-route-run-0001',
  goal: 'Create a governed image workflow',
  context_asset_ids: [],
  policy_snapshot_hash: SHA256_HASH,
  evaluation_version: null,
  max_nodes: 16,
  max_dependencies: 32,
  max_approved_credits: 100,
  deadline_at: null,
});

const appendRequest = (
  nodeId = NODE_ID,
  nodeKey = 'render-primary',
  expectedGraphVersion = 0,
): IntelligenceWorkflowAppendNodeRequest => ({
  protocol_version: 'intelligence.workflow.v1',
  sender_card_hash: CARD_HASH,
  expected_graph_version: expectedGraphVersion,
  idempotency_key: `workflow-route-${nodeKey}-0001`,
  node: {
    node_id: nodeId,
    node_key: nodeKey,
    role: 'executor',
    kind: 'capability',
    agent_name: null,
    agent_card_hash: null,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    policy_snapshot_hash: SHA256_HASH,
    evaluation_version: null,
    deadline_at: null,
  },
  payload: { prompt: 'private input', asset_ids: [] },
});

type TestOptions = {
  actor?: 'user' | 'agent';
  trusted?: boolean;
  denyAction?: string;
  denyRunAfter?: number;
  projectMissing?: boolean;
};

function createApp(options: TestOptions = {}) {
  const actions: string[] = [];
  const trustCalls: Array<{ accountId: string; projectId: string; cardHash: string }> = [];
  const service = createWorkflowService({
    port: createMemoryWorkflowStore(),
    payloads: createStudioWorkflowPayloadStore(
      new InMemoryStudioObjectStore({ namespace: 'workflow-routes', ready: true }),
    ),
    now: () => NOW,
  });
  const routes = createIntelligenceWorkflowProjectRoutes({
    service,
    now: () => NOW,
    randomUUID: () => RUN_ID,
    loadProjectForUser: async (_context, projectId) =>
      options.projectMissing || (projectId !== PROJECT_ID && projectId !== OTHER_PROJECT_ID)
        ? null
        : { row: { accountId: ACCOUNT_ID, projectId }, userId: USER_ID },
    assertProjectCapability: async (_context, _userId, _accountId, _projectId, action) => {
      actions.push(action);
      const runActionCount = actions.filter(
        (candidate) => candidate === PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN,
      ).length;
      if (
        options.denyAction === action ||
        (action === PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN &&
          options.denyRunAfter !== undefined &&
          runActionCount > options.denyRunAfter)
      ) {
        throw new HTTPException(403, { message: 'Forbidden' });
      }
    },
    isAgentCardTrusted: async (input) => {
      trustCalls.push(input);
      return options.trusted ?? true;
    },
  });
  const app = new Hono();
  app.use('*', async (context, next) => {
    const writable = context as unknown as { set(key: string, value: unknown): void };
    writable.set('authType', 'pat');
    writable.set('iamTokenId', IAM_TOKEN_ID);
    writable.set('sessionId', 'workflow-session');
    writable.set('agentGrant', options.actor === 'agent' ? { agent: 'content-planner' } : null);
    await next();
  });
  app.route('/v1/projects', routes);
  app.onError((error, context) => {
    if (error instanceof HTTPException) {
      return context.json({ error: error.message }, error.status);
    }
    return context.json({ error: 'Internal error' }, 500);
  });
  return { app, actions, trustCalls, service };
}

async function post(app: Hono, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function start(app: Hono, projectId = PROJECT_ID) {
  return post(app, `/v1/projects/${projectId}/intelligence/workflows`, startRequest());
}

async function pauseForApproval(appState: ReturnType<typeof createApp>) {
  await start(appState.app);
  const request = appendRequest();
  const node: WorkflowNode = {
    protocol_version: 'intelligence.workflow.v1',
    node_id: request.node.node_id,
    run_id: RUN_ID,
    node_key: request.node.node_key,
    role: request.node.role,
    kind: request.node.kind,
    agent_name: request.node.agent_name,
    agent_card_hash: request.node.agent_card_hash,
    capability_id: request.node.capability_id,
    capability_version: request.node.capability_version,
    input_hash: SHA256_HASH,
    policy_snapshot_hash: request.node.policy_snapshot_hash,
    evaluation_version: request.node.evaluation_version,
    task_id: null,
    status: 'pending',
    attempt_count: 0,
    deadline_at: null,
    created_at: NOW,
    updated_at: NOW,
    terminal_at: null,
  };
  await appState.service.appendNodeWithPayload({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    expectedGraphVersion: 0,
    idempotencyKey: request.idempotency_key,
    node,
    payload: request.payload,
  });
  await appState.service.sealGraph({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    expectedGraphVersion: 1,
    updatedAt: NOW,
  });
  await appState.service.claimReadyNode({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    workerId: 'workflow-route-worker',
    now: NOW,
    leaseMs: 60_000,
  });
  const approval: WorkflowApproval = {
    protocol_version: 'intelligence.workflow.v1',
    approval_id: APPROVAL_ID,
    run_id: RUN_ID,
    node_id: NODE_ID,
    risk: 'high',
    reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
    action_summary: 'Approve image generation',
    status: 'pending',
    review_item_id: null,
    acting_user_id: null,
    decision: null,
    feedback_hash: null,
    requested_at: NOW,
    resolved_at: null,
  };
  await appState.service.pauseForApproval({
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    nodeId: NODE_ID,
    workerId: 'workflow-route-worker',
    approval,
  });
}

describe('intelligence workflow project routes', () => {
  test('starts one project-scoped run idempotently through the existing run IAM leaf', async () => {
    const { app, actions } = createApp();

    const created = await start(app);
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({
      protocol_version: 'intelligence.workflow.v1',
      created: true,
      run: { run_id: RUN_ID, project_id: PROJECT_ID, status: 'draft' },
    });
    expect(JSON.stringify(createdBody)).not.toMatch(/payload_ref|provider_url|credential/i);

    const replay = await start(app);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false, run: { run_id: RUN_ID } });
    expect(actions).toEqual([
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN,
    ]);
  });

  test('returns opaque 404 for a foreign project and uses read/cancel IAM leaves', async () => {
    const { app, actions } = createApp();
    await start(app);

    const foreign = await app.request(
      `/v1/projects/${OTHER_PROJECT_ID}/intelligence/workflows/${RUN_ID}`,
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Not found' });

    const own = await app.request(`/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}`);
    expect(own.status).toBe(200);
    const cancelled = await post(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/cancel`,
      {
        protocol_version: 'intelligence.workflow.v1',
        reason_code: 'WORKFLOW_CANCELLED_BY_USER',
      },
    );
    expect(cancelled.status).toBe(200);
    expect(actions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ);
    expect(actions).toContain(PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_CANCEL);
  });

  test('lets only a human with project.review.act resolve a scoped approval', async () => {
    const human = createApp();
    await pauseForApproval(human);
    const request: IntelligenceWorkflowApprovalDecisionRequest = {
      protocol_version: 'intelligence.workflow.v1',
      decision: 'approve',
      feedback_hash: SHA256_HASH,
    };

    const approved = await post(
      human.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/approvals/${APPROVAL_ID}/decision`,
      request,
    );
    expect(approved.status).toBe(200);
    const body = await approved.json();
    expect(body).toMatchObject({
      protocol_version: 'intelligence.workflow.v1',
      run: { run_id: RUN_ID },
      node: { node_id: NODE_ID, status: 'running' },
      approval: {
        approval_id: APPROVAL_ID,
        status: 'approved',
        acting_user_id: USER_ID,
        decision: 'approve',
        feedback_hash: SHA256_HASH,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/payload_ref|prompt|provider|credential/i);
    expect(human.actions).toContain(PROJECT_ACTIONS.PROJECT_REVIEW_ACT);

    const agent = createApp({ actor: 'agent' });
    await pauseForApproval(agent);
    const forbidden = await post(
      agent.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/approvals/${APPROVAL_ID}/decision`,
      request,
    );
    expect(forbidden.status).toBe(403);
  });

  test('returns opaque 404 for unknown workflow approval identifiers', async () => {
    const state = createApp();
    await pauseForApproval(state);
    const request: IntelligenceWorkflowApprovalDecisionRequest = {
      protocol_version: 'intelligence.workflow.v1',
      decision: 'reject',
      feedback_hash: null,
    };

    const missing = await post(
      state.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/approvals/67000000-0000-4000-a000-000000000099/decision`,
      request,
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not found' });
  });

  test('allows only a trusted granted Agent to mutate and seal the graph', async () => {
    const { app, actions, trustCalls } = createApp({ actor: 'agent' });
    await start(app);

    const first = await post(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(),
    );
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({
      created: true,
      graph_version: 1,
      node: { node_id: NODE_ID },
    });

    const second = await post(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(OTHER_NODE_ID, 'review-primary', 1),
    );
    expect(second.status).toBe(201);

    const dependency: IntelligenceWorkflowAddDependencyRequest = {
      protocol_version: 'intelligence.workflow.v1',
      sender_card_hash: CARD_HASH,
      expected_graph_version: 2,
      dependency_id: DEPENDENCY_ID,
      node_id: OTHER_NODE_ID,
      depends_on_node_id: NODE_ID,
      condition: 'on_success',
    };
    const added = await post(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/dependencies`,
      dependency,
    );
    expect(added.status).toBe(201);
    expect(await added.json()).toMatchObject({ graph_version: 3 });

    const seal: IntelligenceWorkflowSealRequest = {
      protocol_version: 'intelligence.workflow.v1',
      sender_card_hash: CARD_HASH,
      expected_graph_version: 3,
    };
    const sealed = await post(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/seal`,
      seal,
    );
    expect(sealed.status).toBe(200);
    expect(await sealed.json()).toMatchObject({ run: { status: 'running' } });
    expect(
      actions.filter((action) => action === PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN),
    ).toHaveLength(5);
    expect(trustCalls).toHaveLength(4);
  });

  test('fails closed on user graph writes, untrusted cards, stale versions, and oversized bodies', async () => {
    const user = createApp();
    await start(user.app);
    const userWrite = await post(
      user.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(),
    );
    expect(userWrite.status).toBe(403);
    expect(await userWrite.json()).toMatchObject({ code: 'INTELLIGENCE_WORKFLOW_UNTRUSTED' });

    const untrusted = createApp({ actor: 'agent', trusted: false });
    await start(untrusted.app);
    const untrustedWrite = await post(
      untrusted.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(),
    );
    expect(untrustedWrite.status).toBe(403);

    const deniedGrant = createApp({ actor: 'agent', denyRunAfter: 1 });
    await start(deniedGrant.app);
    const deniedWrite = await post(
      deniedGrant.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(),
    );
    expect(deniedWrite.status).toBe(403);
    expect(deniedGrant.trustCalls).toHaveLength(0);

    const stale = createApp({ actor: 'agent' });
    await start(stale.app);
    await post(
      stale.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(),
    );
    const conflict = await post(
      stale.app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest(THIRD_NODE_ID, 'render-stale', 0),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: 'Intelligence workflow conflict',
      code: 'INTELLIGENCE_WORKFLOW_CONFLICT',
    });

    const oversized = await stale.app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '1114113' },
        body: '{}',
      },
    );
    expect(oversized.status).toBe(413);
    expect(JSON.stringify(await oversized.json())).not.toMatch(/provider|payload|credential/i);
  });

  test('reads bounded monotonic events with a strict cursor', async () => {
    const { app } = createApp();
    await start(app);
    const events = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/events?cursor=0&limit=100`,
    );
    expect(events.status).toBe(200);
    const body = await events.json();
    expect(body).toMatchObject({ run_id: RUN_ID, next_cursor: null });
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/payload_ref|input_hash|provider|credential/i);

    const invalid = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/events?cursor=-1`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: 'INTELLIGENCE_WORKFLOW_VALIDATION_ERROR',
    });
  });

  test('enforces actual request bytes when content-length is understated', async () => {
    const { app } = createApp({ actor: 'agent' });
    await start(app);
    const oversized = appendRequest();
    oversized.payload = { value: 'x'.repeat(1024 * 1024 + 64 * 1024) };

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: JSON.stringify(oversized),
      },
    );

    expect(response.status).toBe(413);
  });
});
