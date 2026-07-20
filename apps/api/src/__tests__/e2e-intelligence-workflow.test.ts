import { describe, expect, test } from 'bun:test';
import type {
  IntelligenceCreateTaskRequest,
  IntelligenceWorkflowAppendNodeRequest,
  IntelligenceWorkflowStartRequest,
  StudioJobEvent,
} from '@kortix/api-contract';
import type {
  CapabilityDescriptor,
  WorkflowApproval,
  WorkflowNode,
  WorkflowPlannerProposal,
  WorkflowReviewerVerdict,
  WorkflowRun,
} from '@kortix/intelligence-contracts';
import {
  type IntelligenceRouteCandidate,
  type IntelligenceRoutePolicySnapshot,
  type IntelligenceRouteRequest,
  canonicalWorkflowHash,
} from '@kortix/intelligence-orchestration';
import { InMemoryStudioObjectStore, createFakeStudioProvider } from '@kortix/studio-runtime';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createMemoryIntelligenceRouteDecisionStore } from '../intelligence/routing/decision-store';
import {
  IntelligenceTaskService,
  createInMemoryIntelligenceTaskStore,
  createStudioJobBridge,
} from '../intelligence/task-service';
import { createA2AWorkflowAdapter } from '../intelligence/workflows/a2a';
import { createMemoryWorkflowStore } from '../intelligence/workflows/memory-store';
import {
  type WorkflowMetricEmission,
  createWorkflowTelemetry,
} from '../intelligence/workflows/metrics';
import { createMemoryWorkflowPayloadRepository } from '../intelligence/workflows/payload-repository';
import { createStudioWorkflowPayloadStore } from '../intelligence/workflows/payload-store';
import { createWorkflowPlanner } from '../intelligence/workflows/planner';
import { createIntelligenceWorkflowProjectRoutes } from '../intelligence/workflows/project-routes';
import {
  type WorkflowReviewProjectionInput,
  type WorkflowReviewProjectionRecord,
  createWorkflowReviewAdapter,
  workflowReviewItemId,
} from '../intelligence/workflows/review-adapter';
import { createWorkflowReviewer } from '../intelligence/workflows/reviewer';
import { createWorkflowScheduler } from '../intelligence/workflows/scheduler';
import { createWorkflowService } from '../intelligence/workflows/service';
import { createWorkflowImageTaskBridge } from '../intelligence/workflows/task-bridge';
import { createMemoryStudioRepository } from '../studio/repositories/memory';

const ACCOUNT_ID = '71000000-0000-4000-a000-000000000001';
const PROJECT_ID = '72000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '72000000-0000-4000-a000-000000000002';
const RUN_ID = '73000000-0000-4000-a000-000000000001';
const REVOKED_RUN_ID = '73000000-0000-4000-a000-000000000002';
const NODE_ID = '74000000-0000-4000-a000-000000000001';
const REVOKED_NODE_ID = '74000000-0000-4000-a000-000000000002';
const PLANNER_ID = '75000000-0000-4000-a000-000000000001';
const HUMAN_ID = '75000000-0000-4000-a000-000000000002';
const APPROVAL_ID = '76000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '77000000-0000-4000-a000-000000000001';
const TASK_ID = '78000000-0000-4000-a000-000000000001';
const ASSET_ID = '79000000-0000-4000-a000-000000000001';
const PLANNER_HASH = 'a'.repeat(64);
const EXECUTOR_HASH = 'b'.repeat(64);
const REVIEWER_HASH = 'c'.repeat(64);
const POLICY_HASH = `sha256:${'d'.repeat(64)}`;
const EVALUATION_VERSION = 'image-golden-2026-07-19';
const PRIVATE_GOAL = 'PRIVATE_WORKFLOW_ACCEPTANCE_GOAL';
const PRIVATE_PROMPT = 'PRIVATE_WORKFLOW_ACCEPTANCE_PROMPT';
const PRIVATE_PROVIDER_BODY = 'PRIVATE_WORKFLOW_PROVIDER_BODY';
const PRIVATE_SIGNED_URL = 'https://private.example.test/output.png?signature=PRIVATE_SIGNATURE';

const capability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object' },
  output_schema: { type: 'object' },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

describe('Intelligence workflow Phase 2 acceptance', () => {
  test('runs one governed planner, image leaf, reviewer, and human approval to completion', async () => {
    let currentTime = '2026-07-19T10:00:00.000Z';
    let revoked = false;
    let providerSubmissions = 0;
    let studioJobCreates = 0;
    const publicWire: string[] = [];
    const studioEvents: StudioJobEvent[] = [];
    const telemetryEmissions: WorkflowMetricEmission[] = [];
    const payloadRepository = createMemoryWorkflowPayloadRepository();
    const workflowStore = createMemoryWorkflowStore();
    const routeDecisionStore = createMemoryIntelligenceRouteDecisionStore();
    const workflowService = createWorkflowService({
      port: workflowStore,
      payloads: createStudioWorkflowPayloadStore(
        new InMemoryStudioObjectStore({ namespace: 'workflow-acceptance', ready: true }),
      ),
      payloadRepository,
      authorizePayloadRead: async ({ workerId }) => workerId === 'workflow-acceptance-worker',
      routing: {
        candidateSource: { listImageCandidates: async () => [routeCandidate()] },
        decisionStore: routeDecisionStore,
      },
      now: () => currentTime,
    });

    const studioRepository = createMemoryStudioRepository({
      providers: [
        {
          provider_config_id: PROVIDER_CONFIG_ID,
          account_id: ACCOUNT_ID,
          project_id: PROJECT_ID,
          provider: 'fake',
          display_name: 'Workflow acceptance fake provider',
          base_url: null,
          region: null,
          credential_binding: { kind: 'none' },
          capabilities: ['image.generate'],
          enabled: true,
          created_at: currentTime,
          updated_at: currentTime,
        },
      ],
      now: () => currentTime,
    });
    const originalCreateJob = studioRepository.createJob.bind(studioRepository);
    studioRepository.createJob = async (...args) => {
      studioJobCreates += 1;
      return originalCreateJob(...args);
    };
    const taskStore = createInMemoryIntelligenceTaskStore({ taskId: TASK_ID });
    const taskService = new IntelligenceTaskService({
      store: taskStore,
      createStudioJob: createStudioJobBridge({
        repository: studioRepository,
        assertReadyBeforeReservation: async () => {},
        now: () => new Date(currentTime),
      }),
      readStudioEvents: async ({ jobId, cursor }) => ({
        items: studioEvents.filter(
          (event) => event.job_id === jobId && Number(event.cursor) > Number(cursor ?? 0),
        ),
        next_cursor: null,
      }),
      now: () => new Date(currentTime),
    });
    const taskBridge = createWorkflowImageTaskBridge({
      taskService,
      listExecutionTargets: async () => [
        {
          capability_id: 'studio.image.generate',
          provider_config_id: PROVIDER_CONFIG_ID,
          model: 'fake/image-v1',
        },
      ],
      reserveNodeBudget: workflowService.reserveNodeBudget,
    });
    const telemetry = createWorkflowTelemetry({
      counter: (emission) => telemetryEmissions.push(emission),
      histogram: (emission) => telemetryEmissions.push(emission),
      span: (emission) => telemetryEmissions.push(emission),
    });
    const scheduler = createWorkflowScheduler({
      workflow: workflowService,
      bridge: taskBridge,
      isReady: async () => true,
      listScopes: async () => [{ accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
      authorizeNode: async () =>
        revoked
          ? null
          : {
              actingTokenId: 'workflow-acceptance-token',
              sessionId: 'workflow-acceptance-session',
              parentTaskId: null,
            },
      readNodeRequest: (command) =>
        workflowService.readNodePayloadForExecution({
          ...workflowNodeScope(command.run.run_id, command.node.node_id),
          workerId: command.workerId,
          now: command.now,
        }),
      workerId: 'workflow-acceptance-worker',
      now: () => currentTime,
      nowMilliseconds: () => Date.parse(currentTime),
      traceparent: () => '00-11111111111111111111111111111111-2222222222222222-01',
      leaseMs: 30_000,
      maxClaimsPerRun: 8,
      telemetry,
    });

    const routes = createIntelligenceWorkflowProjectRoutes({
      service: workflowService,
      now: () => currentTime,
      randomUUID: () => RUN_ID,
      loadProjectForUser: async (_context, projectId) =>
        projectId === PROJECT_ID
          ? { row: { accountId: ACCOUNT_ID, projectId }, userId: PLANNER_ID }
          : null,
      assertProjectCapability: async () => {},
      isAgentCardTrusted: async ({ agentName, cardHash }) =>
        agentName === 'content-planner' && cardHash === PLANNER_HASH,
    });
    const app = new Hono();
    app.use('*', async (context, next) => {
      const writable = context as unknown as { set(key: string, value: unknown): void };
      writable.set('authType', 'pat');
      writable.set('iamTokenId', 'workflow-acceptance-token');
      writable.set('sessionId', 'workflow-acceptance-session');
      writable.set('agentGrant', { agent: 'content-planner' });
      await next();
    });
    app.route('/v1/projects', routes);
    app.onError((error, context) => {
      if (error instanceof HTTPException)
        return context.json({ error: error.message }, error.status);
      return context.json({ error: 'Internal error' }, 500);
    });

    const startRequest = workflowStartRequest();
    const created = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows`,
      startRequest,
    );
    expect(created.response.status).toBe(201);
    publicWire.push(created.text);
    expect(JSON.parse(created.text)).toMatchObject({
      created: true,
      run: { run_id: RUN_ID, status: 'draft', evaluation_version: EVALUATION_VERSION },
    });
    const replayed = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows`,
      startRequest,
    );
    expect(replayed.response.status).toBe(200);
    publicWire.push(replayed.text);
    expect(JSON.parse(replayed.text)).toMatchObject({ created: false, run: { run_id: RUN_ID } });

    const planner = createWorkflowPlanner({
      invokeAgent: { invoke: async () => plannerProposal(taskRequest()) },
      authorizeNode: async ({ node }) => node.capability_id === 'studio.image.generate',
    });
    const proposal = await planner.plan({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      binding: { role: 'planner', agentName: 'content-planner', cardHash: PLANNER_HASH },
      context: {
        protocol_version: 'intelligence.workflow.v1',
        run_id: RUN_ID,
        expected_graph_version: 0,
        capabilities: [capability],
        agents: [
          { name: 'content-planner', card_hash: PLANNER_HASH },
          { name: 'image-executor', card_hash: EXECUTOR_HASH },
        ],
        asset_ids: [],
        limits: {
          max_nodes: 8,
          max_dependencies: 8,
          max_approved_credits: 10,
          deadline_at: null,
        },
        evaluation_summaries: [
          { evaluation_version: EVALUATION_VERSION, sample_count: 100, score: 0.95 },
        ],
      },
    });
    const appendRequest = workflowAppendRequest(proposal, taskRequest());
    const appended = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest,
    );
    expect(appended.response.status).toBe(201);
    publicWire.push(appended.text);
    const appendReplay = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/nodes`,
      appendRequest,
    );
    expect(appendReplay.response.status).toBe(200);
    publicWire.push(appendReplay.text);
    expect(await payloadRepository.getNodeInput(workflowNodeScope(RUN_ID, NODE_ID))).toMatchObject({
      contentHash: canonicalWorkflowHash(taskRequest()),
    });
    const sealed = await postJson(
      app,
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/seal`,
      {
        protocol_version: 'intelligence.workflow.v1',
        sender_card_hash: PLANNER_HASH,
        expected_graph_version: 1,
      },
    );
    expect(sealed.response.status).toBe(200);
    publicWire.push(sealed.text);

    const routeInput = imageRouteInput();
    await expect(workflowService.routeImageNode(routeInput)).resolves.toMatchObject({
      created: true,
      decision: {
        policyVersion: 'workflow-route-policy-v1',
        primary: { evaluationVersion: EVALUATION_VERSION },
      },
    });
    await expect(workflowService.routeImageNode(routeInput)).resolves.toMatchObject({
      created: false,
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, attached: 1 });
    expect({ studioJobCreates, providerSubmissions }).toEqual({
      studioJobCreates: 1,
      providerSubmissions: 0,
    });
    const task = await taskStore.get({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      taskId: TASK_ID,
    });
    if (!task?.jobId) throw new Error('workflow task was not attached to a Studio job');

    const fakeProvider = createFakeStudioProvider();
    providerSubmissions += 1;
    const providerContext = { correlationId: task.jobId, submissionKey: `workflow:${task.jobId}` };
    const submission = await fakeProvider.submit(providerContext, taskRequest().input);
    if (submission.kind !== 'async') throw new Error('fake provider must be asynchronous');
    expect(await fakeProvider.poll(providerContext, submission.handle)).toMatchObject({
      status: 'succeeded',
    });
    const queued = await studioRepository.listEvents(PROJECT_ID, task.jobId, null);
    studioEvents.push(
      ...queued.items,
      studioEvent(task.jobId, '2', 'provider-submitted', {}),
      studioEvent(task.jobId, '3', 'progress', {
        progress: 0.9,
        raw_provider_body: PRIVATE_PROVIDER_BODY,
      }),
      studioEvent(task.jobId, '4', 'asset-created', {
        asset_id: ASSET_ID,
        signed_url: PRIVATE_SIGNED_URL,
      }),
      studioEvent(task.jobId, '5', 'succeeded', {}),
    );

    currentTime = '2026-07-19T10:00:31.000Z';
    const claimedForReview = await workflowService.claimReadyNode({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      workerId: 'workflow-acceptance-worker',
      now: currentTime,
      leaseMs: 30_000,
    });
    if (!claimedForReview) throw new Error('attached task was not reclaimable for review');
    const reconciliation = await taskBridge.reconcile({
      ...claimedForReview,
      taskId: TASK_ID,
    });
    expect(reconciliation).toEqual({ status: 'succeeded', assetIds: [ASSET_ID], reasonCode: null });

    const reviewer = createWorkflowReviewer({
      invokeAgent: { invoke: async () => reviewerVerdict() },
      authorizeVerdict: async ({ verdict }) => verdict.verdict === 'approve',
    });
    await expect(
      reviewer.review({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        binding: { role: 'reviewer', agentName: 'quality-reviewer', cardHash: REVIEWER_HASH },
        context: {
          protocol_version: 'intelligence.workflow.v1',
          run_id: RUN_ID,
          node: {
            node_id: NODE_ID,
            role: 'executor',
            agent_name: 'image-executor',
            agent_card_hash: EXECUTOR_HASH,
          },
          result: { status: 'succeeded', asset_ids: [ASSET_ID], reason_codes: [] },
          evaluation_summary: {
            evaluation_version: EVALUATION_VERSION,
            score: 0.95,
            sample_count: 100,
          },
          separation_of_duty: true,
        },
      }),
    ).resolves.toMatchObject({ verdict: 'approve', evaluation_version: EVALUATION_VERSION });

    const projections = new Map<string, WorkflowReviewProjectionRecord>();
    let pendingApproval: WorkflowApproval | null = null;
    const reviewAdapter = createWorkflowReviewAdapter({
      workflow: workflowService,
      projection: {
        async upsert(input) {
          const record = projectionRecord(input);
          projections.set(input.reviewItemId, record);
          return record;
        },
        async get(input) {
          const record = projections.get(input.reviewItemId);
          return record?.accountId === input.accountId && record.projectId === input.projectId
            ? record
            : null;
        },
        async reconcile(input) {
          const record = projections.get(input.reviewItemId);
          if (!record) return null;
          const updated: WorkflowReviewProjectionRecord = {
            ...record,
            status: input.approval.decision === 'approve' ? 'approved' : 'rejected',
            actedBy: input.approval.acting_user_id,
            actedAt: input.approval.resolved_at ? new Date(input.approval.resolved_at) : null,
            feedback: input.feedback,
            updatedAt: new Date(input.approval.resolved_at ?? currentTime),
          };
          projections.set(input.reviewItemId, updated);
          return updated;
        },
      },
      loadApproval: async () => pendingApproval,
      authorize: async () => {},
      now: () => currentTime,
    });
    const approval = workflowApproval();
    const projected = await reviewAdapter.project({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: PLANNER_ID,
      actorType: 'agent',
      actingTokenId: 'workflow-acceptance-token',
      workerId: 'workflow-acceptance-worker',
      run: claimedForReview.run,
      node: claimedForReview.node,
      approval,
    });
    if (!projected?.projection) throw new Error('workflow approval was not projected');
    pendingApproval = projected.approval;
    expect(projected.run.status).toBe('waiting_approval');
    expect(projected.projection.metadata).toEqual({
      namespace: 'kortix.intelligence.workflow.approval.v1',
      approval_id: APPROVAL_ID,
      run_id: RUN_ID,
      node_id: NODE_ID,
    });

    currentTime = '2026-07-19T10:00:32.000Z';
    const approved = await reviewAdapter.resolve({
      reviewItemId: workflowReviewItemId(APPROVAL_ID),
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: HUMAN_ID,
      actorType: 'user',
      actingTokenId: null,
      verdict: 'approve',
    });
    expect(approved).toMatchObject({
      run: { status: 'running' },
      node: { status: 'running', task_id: TASK_ID },
      approval: { status: 'approved', acting_user_id: HUMAN_ID },
      projection: { status: 'approved' },
    });

    currentTime = '2026-07-19T10:00:33.000Z';
    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    const finalRun = await workflowService.getRun({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
    });
    expect(finalRun).toMatchObject({ status: 'succeeded', evaluation_version: EVALUATION_VERSION });
    expect({ studioJobCreates, providerSubmissions }).toEqual({
      studioJobCreates: 1,
      providerSubmissions: 1,
    });

    const eventsResponse = await app.request(
      `/v1/projects/${PROJECT_ID}/intelligence/workflows/${RUN_ID}/events?cursor=0&limit=100`,
    );
    expect(eventsResponse.status).toBe(200);
    const eventsText = await eventsResponse.text();
    publicWire.push(eventsText);
    const events = JSON.parse(eventsText) as {
      items: Array<{ sequence: number; type: string; evaluation_version: string | null }>;
    };
    expect(events.items.map((event) => event.sequence)).toEqual(
      events.items.map((_event, index) => index + 1),
    );
    expect(events.items.map((event) => event.type)).toContain('node_waiting_approval');
    expect(events.items.at(-2)).toMatchObject({
      type: 'node_succeeded',
      evaluation_version: EVALUATION_VERSION,
    });

    const foreign = await app.request(
      `/v1/projects/${OTHER_PROJECT_ID}/intelligence/workflows/${RUN_ID}`,
    );
    expect(foreign.status).toBe(404);
    publicWire.push(await foreign.text());

    const a2a = createA2AWorkflowAdapter({
      isAgentCardTrusted: async () => true,
      start: async () => {
        throw new Error('status-only acceptance adapter');
      },
      get: async () => (finalRun ? { run: finalRun, parentTaskId: null } : null),
    });
    const a2aStatus = await a2a.status({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: PLANNER_ID,
      actorType: 'agent',
      actingTokenId: 'workflow-acceptance-token',
      agentName: 'content-planner',
      runId: RUN_ID,
      senderCardHash: PLANNER_HASH,
    });
    expect(a2aStatus).toMatchObject({ id: RUN_ID, status: { state: 'completed' } });
    publicWire.push(JSON.stringify(a2aStatus), JSON.stringify(telemetryEmissions));

    const revokedRun = revokedWorkflowRun();
    await workflowService.startRunFromRequest({ run: revokedRun, request: { goal: 'revoked' } });
    await workflowService.appendNodeWithPayload({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: REVOKED_RUN_ID,
      expectedGraphVersion: 0,
      idempotencyKey: 'workflow-revoked-node-0001',
      node: revokedWorkflowNode(),
      payload: { ...taskRequest(), idempotency_key: 'revoked-untrusted-key' },
    });
    await workflowService.sealGraph({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: REVOKED_RUN_ID,
      expectedGraphVersion: 1,
      updatedAt: currentTime,
    });
    revoked = true;
    await expect(scheduler.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect({ studioJobCreates, providerSubmissions }).toEqual({
      studioJobCreates: 1,
      providerSubmissions: 1,
    });

    const wire = publicWire.join('\n');
    for (const privateValue of [
      PRIVATE_GOAL,
      PRIVATE_PROMPT,
      PRIVATE_PROVIDER_BODY,
      PRIVATE_SIGNED_URL,
      'PRIVATE_SIGNATURE',
      'workflow-acceptance-token',
    ]) {
      expect(wire).not.toContain(privateValue);
    }
    expect(wire).not.toMatch(/payload_ref|object_ref|provider_url/i);
  }, 20_000);
});

function workflowStartRequest(): IntelligenceWorkflowStartRequest {
  return {
    protocol_version: 'intelligence.workflow.v1',
    idempotency_key: 'workflow-phase2-acceptance-0001',
    goal: PRIVATE_GOAL,
    context_asset_ids: [],
    policy_snapshot_hash: POLICY_HASH,
    evaluation_version: EVALUATION_VERSION,
    max_nodes: 8,
    max_dependencies: 8,
    max_approved_credits: 10,
    deadline_at: null,
  };
}

function taskRequest(): IntelligenceCreateTaskRequest {
  return {
    protocol_version: 'intelligence.v1',
    capability_id: 'studio.image.generate',
    agent_card_hash: EXECUTOR_HASH,
    provider_config_id: PROVIDER_CONFIG_ID,
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: PRIVATE_PROMPT,
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    idempotency_key: 'planner-untrusted-idempotency',
    parent_task_id: null,
    deadline_at: null,
  };
}

function plannerProposal(request: IntelligenceCreateTaskRequest): WorkflowPlannerProposal {
  return {
    protocol_version: 'intelligence.workflow.v1',
    proposal_id: '7a000000-0000-4000-a000-000000000001',
    run_id: RUN_ID,
    planner_agent_name: 'content-planner',
    planner_card_hash: PLANNER_HASH,
    expected_graph_version: 0,
    nodes: [
      {
        node_key: 'generate-approved-image',
        role: 'executor',
        kind: 'capability',
        agent_name: 'image-executor',
        agent_card_hash: EXECUTOR_HASH,
        capability_id: 'studio.image.generate',
        capability_version: '1.0.0',
        input_ref: 'sealed:planner-proposal-input',
        input_hash: canonicalWorkflowHash(request),
        action_summary: 'Generate one governed image',
        requires_approval: true,
        deadline_at: null,
      },
    ],
    dependencies: [],
    proposal_hash: `sha256:${'e'.repeat(64)}`,
    created_at: '2026-07-19T10:00:00.000Z',
  };
}

function workflowAppendRequest(
  proposal: WorkflowPlannerProposal,
  payload: IntelligenceCreateTaskRequest,
): IntelligenceWorkflowAppendNodeRequest {
  const node = proposal.nodes[0];
  if (!node) throw new Error('planner proposal has no node');
  return {
    protocol_version: 'intelligence.workflow.v1',
    sender_card_hash: PLANNER_HASH,
    expected_graph_version: proposal.expected_graph_version,
    idempotency_key: 'workflow-phase2-node-0001',
    node: {
      node_id: NODE_ID,
      node_key: node.node_key,
      role: node.role,
      kind: node.kind,
      agent_name: node.agent_name,
      agent_card_hash: node.agent_card_hash,
      capability_id: node.capability_id,
      capability_version: node.capability_version,
      policy_snapshot_hash: POLICY_HASH,
      evaluation_version: EVALUATION_VERSION,
      deadline_at: node.deadline_at,
    },
    payload,
  };
}

function workflowApproval(): WorkflowApproval {
  return {
    protocol_version: 'intelligence.workflow.v1',
    approval_id: APPROVAL_ID,
    run_id: RUN_ID,
    node_id: NODE_ID,
    risk: 'high',
    reason_code: 'WORKFLOW_POLICY_APPROVAL_REQUIRED',
    action_summary: 'Approve the reviewed image result',
    status: 'pending',
    review_item_id: null,
    acting_user_id: null,
    decision: null,
    feedback_hash: null,
    requested_at: '2026-07-19T10:00:31.000Z',
    resolved_at: null,
  };
}

function reviewerVerdict(): WorkflowReviewerVerdict {
  return {
    protocol_version: 'intelligence.workflow.v1',
    verdict_id: '7b000000-0000-4000-a000-000000000001',
    run_id: RUN_ID,
    node_id: NODE_ID,
    reviewer_agent_name: 'quality-reviewer',
    reviewer_card_hash: REVIEWER_HASH,
    verdict: 'approve',
    reason_codes: ['WORKFLOW_REVIEW_APPROVED'],
    feedback_ref: null,
    feedback_hash: null,
    evaluation_version: EVALUATION_VERSION,
    created_at: '2026-07-19T10:00:31.000Z',
  };
}

function projectionRecord(input: WorkflowReviewProjectionInput): WorkflowReviewProjectionRecord {
  return {
    ...input,
    status: 'needs_you',
    actedBy: null,
    actedAt: null,
    feedback: null,
    updatedAt: input.createdAt,
  };
}

function routeCandidate(): IntelligenceRouteCandidate {
  return {
    candidateId: `sha256:${'f'.repeat(64)}`,
    providerDefinitionId: 'fake',
    providerConfigId: PROVIDER_CONFIG_ID,
    modelId: 'fake/image-v1',
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    region: 'global',
    safetyClass: 'standard',
    supportedInputKinds: ['text'],
    outputKind: 'image',
    ready: true,
    iamAllowed: true,
    agentAllowed: true,
    projectPolicy: 'allow',
    estimatedCostMicredits: 1_000_000,
    estimatedLatencyMs: 1_000,
    riskPenaltyPpm: 0,
    evaluation: {
      snapshotVersion: EVALUATION_VERSION,
      publishedAt: '2026-07-19T09:00:00.000Z',
      sampleCount: 100,
      minimumSampleCount: 30,
      meetsMinimumSamples: true,
      confidenceLowerBoundPpm: 900_000,
      qualityRatePpm: 950_000,
      availabilityRatePpm: 990_000,
      failureRatePpm: 10_000,
    },
  };
}

function routePolicy(): IntelligenceRoutePolicySnapshot {
  return {
    policyVersion: 'workflow-route-policy-v1',
    policyHash: POLICY_HASH,
    allowedRegions: ['global'],
    allowedSafetyClasses: ['standard'],
    maximumCandidateRiskPpm: 1_000_000,
    maximumCostMicredits: 10_000_000,
    maximumLatencyMs: 10_000,
    maximumEvaluationAgeMs: 24 * 60 * 60 * 1_000,
    minimumSampleCount: 30,
    minimumConfidenceLowerBoundPpm: 800_000,
    minimumQualityRatePpm: 800_000,
    minimumAvailabilityRatePpm: 800_000,
    maximumFailureRatePpm: 200_000,
    weightsBps: {
      quality: 10_000,
      availability: 10_000,
      latency: 10_000,
      cost: 10_000,
      risk: 10_000,
    },
    normalization: { latencyMs: 10_000, costMicredits: 10_000_000 },
  };
}

function imageRouteInput() {
  const request: IntelligenceRouteRequest = {
    decisionId: '7c000000-0000-4000-a000-000000000001',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    capabilityId: 'studio.image.generate',
    capabilityVersion: '1.0.0',
    schemaVersion: 'studio.image.generate.request.v1',
    inputKinds: ['text'],
    outputKind: 'image',
    requiredRegion: 'global',
    maximumSafetyClass: 'standard',
    remainingBudgetMicredits: 10_000_000,
    deadlineAt: '2026-07-19T10:05:00.000Z',
    now: '2026-07-19T10:00:00.000Z',
    proposedCandidateId: null,
    requestHash: canonicalWorkflowHash(taskRequest()),
  };
  return {
    ...workflowNodeScope(RUN_ID, NODE_ID),
    request,
    policy: routePolicy(),
    actor: { accountId: ACCOUNT_ID, actorType: 'agent' as const, actorId: PLANNER_ID },
    imageInput: taskRequest().input,
    iamAllowed: true,
    agentAllowed: true,
    projectPolicy: 'allow' as const,
  };
}

function revokedWorkflowRun(): WorkflowRun {
  return {
    protocol_version: 'intelligence.workflow.v1',
    run_id: REVOKED_RUN_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_type: 'agent',
    actor_id: PLANNER_ID,
    agent_name: 'content-planner',
    idempotency_key: 'workflow-revoked-run-0001',
    request_hash: canonicalWorkflowHash({ goal: 'revoked' }),
    status: 'draft',
    graph_version: 0,
    policy_snapshot_hash: POLICY_HASH,
    evaluation_version: EVALUATION_VERSION,
    max_nodes: 1,
    max_dependencies: 0,
    max_approved_credits: 1,
    deadline_at: null,
    created_at: '2026-07-19T10:00:33.000Z',
    updated_at: '2026-07-19T10:00:33.000Z',
    terminal_at: null,
  };
}

function revokedWorkflowNode(): WorkflowNode {
  return {
    protocol_version: 'intelligence.workflow.v1',
    node_id: REVOKED_NODE_ID,
    run_id: REVOKED_RUN_ID,
    node_key: 'revoked-image',
    role: 'executor',
    kind: 'capability',
    agent_name: 'image-executor',
    agent_card_hash: EXECUTOR_HASH,
    capability_id: 'studio.image.generate',
    capability_version: '1.0.0',
    input_hash: canonicalWorkflowHash(taskRequest()),
    policy_snapshot_hash: POLICY_HASH,
    evaluation_version: EVALUATION_VERSION,
    task_id: null,
    status: 'pending',
    attempt_count: 0,
    deadline_at: null,
    created_at: '2026-07-19T10:00:33.000Z',
    updated_at: '2026-07-19T10:00:33.000Z',
    terminal_at: null,
  };
}

function workflowNodeScope(runId: string, nodeId: string) {
  return { accountId: ACCOUNT_ID, projectId: PROJECT_ID, runId, nodeId };
}

async function postJson(app: Hono, path: string, body: unknown) {
  const response = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { response, text: await response.text() };
}

function studioEvent(
  jobId: string,
  cursor: string,
  type: StudioJobEvent['type'],
  payload: Record<string, unknown>,
): StudioJobEvent {
  return {
    event_id: `7d000000-0000-4000-a000-${cursor.padStart(12, '0')}`,
    job_id: jobId,
    cursor,
    type,
    payload,
    created_at: new Date(
      Date.parse('2026-07-19T10:00:00.000Z') + Number(cursor) * 1_000,
    ).toISOString(),
  };
}
