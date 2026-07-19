import { describe, expect, test } from 'bun:test';
import { canonicalWorkflowHash } from '@kortix/intelligence-orchestration';
import {
  workflowApprovalFixture,
  workflowNodeFixture,
  workflowRunFixture,
} from '@kortix/intelligence-orchestration/fixtures';
import {
  WORKFLOW_REVIEW_METADATA_NAMESPACE,
  type WorkflowReviewProjectionRecord,
  createWorkflowReviewAdapter,
  workflowReviewItemId,
} from './review-adapter';

const ACCOUNT_ID = '63000000-0000-4000-a000-000000000001';
const PROJECT_ID = '64000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '64000000-0000-4000-a000-000000000002';
const USER_ID = '65000000-0000-4000-a000-000000000001';
const OTHER_USER_ID = '65000000-0000-4000-a000-000000000002';
const NOW = '2026-07-19T09:00:00.000Z';

function resolutionGuardFixture(
  options: {
    risk?: 'none' | 'low' | 'medium' | 'high';
    createdBy?: string;
    projectionProjectId?: string;
  } = {},
) {
  const run = workflowRunFixture({
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_id: OTHER_USER_ID,
    status: 'waiting_approval',
  });
  const node = workflowNodeFixture({ run_id: run.run_id, status: 'waiting_approval' });
  const approval = workflowApprovalFixture({
    run_id: run.run_id,
    node_id: node.node_id,
    risk: options.risk ?? 'high',
  });
  const reviewItemId = workflowReviewItemId(approval.approval_id);
  const projection = {
    reviewItemId,
    accountId: ACCOUNT_ID,
    projectId: options.projectionProjectId ?? PROJECT_ID,
    originSessionId: null,
    kind: 'decision' as const,
    status: 'needs_you' as const,
    risk: approval.risk,
    source: 'agent' as const,
    title: 'Workflow approval required',
    summary: approval.action_summary,
    detail: {},
    agent: node.agent_name ?? '',
    createdBy: options.createdBy ?? OTHER_USER_ID,
    actedBy: null,
    actedAt: null,
    feedback: null,
    metadata: {
      namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
      approval_id: approval.approval_id,
      run_id: run.run_id,
      node_id: node.node_id,
    },
    createdAt: new Date(approval.requested_at),
    updatedAt: new Date(approval.requested_at),
  } satisfies WorkflowReviewProjectionRecord;
  let resolveCalls = 0;
  let loadApprovalCalls = 0;
  const adapter = createWorkflowReviewAdapter({
    workflow: {
      pauseForApproval: async () => {
        throw new Error('unused');
      },
      resolveApproval: async () => {
        resolveCalls += 1;
        throw new Error('must not run');
      },
      resumeRun: async () => {
        throw new Error('must not run');
      },
    },
    projection: {
      upsert: async () => {
        throw new Error('unused');
      },
      get: async ({ projectId }) => (projectId === projection.projectId ? projection : null),
      reconcile: async () => {
        throw new Error('must not run');
      },
    },
    loadApproval: async () => {
      loadApprovalCalls += 1;
      return approval;
    },
    authorize: async () => undefined,
  });
  return {
    adapter,
    approval,
    reviewItemId,
    resolveCalls: () => resolveCalls,
    loadApprovalCalls: () => loadApprovalCalls,
  };
}

describe('workflow Review Center adapter', () => {
  test('pauses authoritatively before creating one redaction-safe native decision projection', async () => {
    const order: string[] = [];
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: USER_ID,
      status: 'running',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'running' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'high',
      action_summary: 'Publish the approved campaign image',
      review_item_id: null,
    });
    let pausedInput: Record<string, unknown> | null = null;
    let projectionInput: Record<string, unknown> | null = null;
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async (input) => {
          order.push('pause');
          pausedInput = input as unknown as Record<string, unknown>;
          return {
            run: { ...run, status: 'waiting_approval' },
            node: { ...node, status: 'waiting_approval' },
            approval: input.approval,
          };
        },
        resolveApproval: async () => {
          throw new Error('unused');
        },
        resumeRun: async () => {
          throw new Error('unused');
        },
      },
      projection: {
        upsert: async (input) => {
          order.push('project');
          projectionInput = input as unknown as Record<string, unknown>;
          return {
            ...input,
            originSessionId: null,
            status: 'needs_you',
            actedBy: null,
            actedAt: null,
            feedback: null,
            updatedAt: input.createdAt,
          };
        },
        get: async () => null,
        reconcile: async () => null,
      },
      loadApproval: async () => null,
      authorize: async ({ action }) => {
        order.push(action);
      },
      now: () => NOW,
    });

    const result = await adapter.project({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      actorType: 'user',
      actingTokenId: null,
      workerId: 'workflow-worker-a',
      run,
      node,
      approval,
    });

    expect(order).toEqual(['project.review.submit', 'pause', 'project']);
    expect(pausedInput).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      runId: run.run_id,
      nodeId: node.node_id,
      workerId: 'workflow-worker-a',
      approval: { ...approval, review_item_id: null },
    });
    const expectedReviewItemId = workflowReviewItemId(approval.approval_id);
    expect(projectionInput).toMatchObject({
      reviewItemId: expectedReviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      kind: 'decision',
      risk: 'high',
      createdBy: USER_ID,
      metadata: {
        namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
        approval_id: approval.approval_id,
        run_id: run.run_id,
        node_id: node.node_id,
      },
    });
    expect(expectedReviewItemId).toMatch(/^[0-9a-f-]{36}$/);
    expect(expectedReviewItemId).not.toBe(approval.approval_id);
    expect(JSON.stringify(projectionInput)).not.toMatch(
      /prompt|payload|input_ref|credential|provider/i,
    );
    expect(result?.projection?.reviewItemId).toBe(expectedReviewItemId);
  });

  test('keeps the authoritative pause when both projection and error reporting fail', async () => {
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: USER_ID,
      status: 'running',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'running' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      review_item_id: null,
    });
    let pauseCalls = 0;
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async (input) => {
          pauseCalls += 1;
          return {
            run: { ...run, status: 'waiting_approval' },
            node: { ...node, status: 'waiting_approval' },
            approval: input.approval,
          };
        },
        resolveApproval: async () => {
          throw new Error('unused');
        },
        resumeRun: async () => {
          throw new Error('unused');
        },
      },
      projection: {
        upsert: async () => {
          throw new Error('review inbox unavailable');
        },
        get: async () => null,
        reconcile: async () => null,
      },
      loadApproval: async () => null,
      authorize: async () => undefined,
      onProjectionError: () => {
        throw new Error('telemetry unavailable');
      },
    });

    await expect(
      adapter.project({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        workerId: 'workflow-worker-a',
        run,
        node,
        approval,
      }),
    ).resolves.toMatchObject({ projection: null, approval: { approval_id: approval.approval_id } });
    expect(pauseCalls).toBe(1);
  });

  test('resolves a high-risk approval through a human verdict before reconciling the projection', async () => {
    const order: string[] = [];
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: OTHER_USER_ID,
      status: 'waiting_approval',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'waiting_approval' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'high',
      review_item_id: null,
    });
    const reviewItemId = workflowReviewItemId(approval.approval_id);
    const projection = {
      reviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      originSessionId: null,
      kind: 'decision' as const,
      status: 'needs_you' as const,
      risk: 'high' as const,
      source: 'agent' as const,
      title: 'Workflow approval required',
      summary: approval.action_summary,
      detail: {},
      agent: node.agent_name ?? '',
      createdBy: OTHER_USER_ID,
      actedBy: null,
      actedAt: null,
      feedback: null,
      metadata: {
        namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
        approval_id: approval.approval_id,
        run_id: run.run_id,
        node_id: node.node_id,
      },
      createdAt: new Date(approval.requested_at),
      updatedAt: new Date(approval.requested_at),
    } satisfies WorkflowReviewProjectionRecord;
    const feedback = 'Approved after checking the public action summary';
    const feedbackHash = canonicalWorkflowHash({ feedback });
    const resolvedApproval = {
      ...approval,
      status: 'approved' as const,
      acting_user_id: USER_ID,
      decision: 'approve' as const,
      feedback_hash: feedbackHash,
      resolved_at: NOW,
    };
    const resolveCalls: unknown[] = [];
    const reconcileCalls: unknown[] = [];
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async () => {
          throw new Error('unused');
        },
        resolveApproval: async (input) => {
          order.push('resolve');
          resolveCalls.push(input);
          return {
            run,
            node: { ...node, status: 'running' },
            approval: resolvedApproval,
          };
        },
        resumeRun: async () => {
          order.push('resume');
          return { ...run, status: 'running', updated_at: NOW };
        },
      },
      projection: {
        upsert: async () => {
          throw new Error('unused');
        },
        get: async () => {
          order.push('projection.get');
          return projection;
        },
        reconcile: async (input) => {
          order.push('projection.reconcile');
          reconcileCalls.push(input);
          return {
            ...projection,
            status: 'approved',
            actedBy: USER_ID,
            actedAt: new Date(NOW),
            feedback,
            updatedAt: new Date(NOW),
          };
        },
      },
      loadApproval: async () => {
        order.push('approval.get');
        return approval;
      },
      authorize: async ({ action }) => {
        order.push(action);
      },
      now: () => NOW,
    });

    const result = await adapter.resolve({
      reviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      actorType: 'user',
      actingTokenId: null,
      verdict: 'approve',
      feedback,
    });

    expect(order).toEqual([
      'project.review.act',
      'projection.get',
      'approval.get',
      'resolve',
      'resume',
      'projection.reconcile',
    ]);
    expect(resolveCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        approvalId: approval.approval_id,
        actingUserId: USER_ID,
        decision: 'approve',
        feedbackHash,
        resolvedAt: NOW,
      },
    ]);
    expect(reconcileCalls).toEqual([
      {
        reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        approval: resolvedApproval,
        feedback,
      },
    ]);
    expect(result?.run.status).toBe('running');
    expect(result?.projection.status).toBe('approved');
  });

  test('replays an exact terminal verdict with the authoritative resolved timestamp', async () => {
    const feedback = 'Already approved';
    const feedbackHash = canonicalWorkflowHash({ feedback });
    const resolvedAt = '2026-07-19T08:30:00.000Z';
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: OTHER_USER_ID,
      status: 'running',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'running' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'high',
      status: 'approved',
      acting_user_id: USER_ID,
      decision: 'approve',
      feedback_hash: feedbackHash,
      resolved_at: resolvedAt,
    });
    const reviewItemId = workflowReviewItemId(approval.approval_id);
    const projection = {
      reviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      originSessionId: null,
      kind: 'decision' as const,
      status: 'needs_you' as const,
      risk: 'high' as const,
      source: 'agent' as const,
      title: 'Workflow approval required',
      summary: approval.action_summary,
      detail: {},
      agent: node.agent_name ?? '',
      createdBy: OTHER_USER_ID,
      actedBy: null,
      actedAt: null,
      feedback: null,
      metadata: {
        namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
        approval_id: approval.approval_id,
        run_id: run.run_id,
        node_id: node.node_id,
      },
      createdAt: new Date(approval.requested_at),
      updatedAt: new Date(approval.requested_at),
    } satisfies WorkflowReviewProjectionRecord;
    const resolveCalls: unknown[] = [];
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async () => {
          throw new Error('unused');
        },
        resolveApproval: async (input) => {
          resolveCalls.push(input);
          return { run, node, approval };
        },
        resumeRun: async () => run,
      },
      projection: {
        upsert: async () => {
          throw new Error('unused');
        },
        get: async () => projection,
        reconcile: async () => ({
          ...projection,
          status: 'approved',
          actedBy: USER_ID,
          actedAt: new Date(resolvedAt),
          feedback,
          updatedAt: new Date(resolvedAt),
        }),
      },
      loadApproval: async () => approval,
      authorize: async () => undefined,
      now: () => NOW,
    });

    await expect(
      adapter.resolve({
        reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'approve',
        feedback,
      }),
    ).resolves.toMatchObject({ projection: { status: 'approved' } });
    expect(resolveCalls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        runId: run.run_id,
        approvalId: approval.approval_id,
        actingUserId: USER_ID,
        decision: 'approve',
        feedbackHash,
        resolvedAt,
      },
    ]);
  });

  test('rejects a conflicting terminal verdict before another workflow write', async () => {
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: OTHER_USER_ID,
      status: 'running',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'running' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'high',
      status: 'approved',
      acting_user_id: USER_ID,
      decision: 'approve',
      feedback_hash: null,
      resolved_at: '2026-07-19T08:30:00.000Z',
    });
    const reviewItemId = workflowReviewItemId(approval.approval_id);
    const projection = {
      reviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      originSessionId: null,
      kind: 'decision' as const,
      status: 'approved' as const,
      risk: 'high' as const,
      source: 'agent' as const,
      title: 'Workflow approval required',
      summary: approval.action_summary,
      detail: {},
      agent: node.agent_name ?? '',
      createdBy: OTHER_USER_ID,
      actedBy: USER_ID,
      actedAt: new Date(approval.resolved_at ?? NOW),
      feedback: null,
      metadata: {
        namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
        approval_id: approval.approval_id,
        run_id: run.run_id,
        node_id: node.node_id,
      },
      createdAt: new Date(approval.requested_at),
      updatedAt: new Date(approval.resolved_at ?? NOW),
    } satisfies WorkflowReviewProjectionRecord;
    let resolveCalls = 0;
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async () => {
          throw new Error('unused');
        },
        resolveApproval: async () => {
          resolveCalls += 1;
          throw new Error('must not run');
        },
        resumeRun: async () => {
          throw new Error('must not run');
        },
      },
      projection: {
        upsert: async () => {
          throw new Error('unused');
        },
        get: async () => projection,
        reconcile: async () => {
          throw new Error('must not run');
        },
      },
      loadApproval: async () => approval,
      authorize: async () => undefined,
    });

    await expect(
      adapter.resolve({
        reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'reject',
      }),
    ).rejects.toEqual(expect.objectContaining({ code: 'WORKFLOW_REVIEW_CONFLICT' }));
    expect(resolveCalls).toBe(0);
  });

  test('requires a human actor for a high-risk workflow approval', async () => {
    const fixture = resolutionGuardFixture({ risk: 'high' });

    await expect(
      fixture.adapter.resolve({
        reviewItemId: fixture.reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'agent',
        actingTokenId: '68000000-0000-4000-a000-000000000001',
        verdict: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_REVIEW_HUMAN_REQUIRED' });
    expect(fixture.resolveCalls()).toBe(0);
  });

  test('denies reviewer self-approval before the workflow decision', async () => {
    const fixture = resolutionGuardFixture({ risk: 'medium', createdBy: USER_ID });

    await expect(
      fixture.adapter.resolve({
        reviewItemId: fixture.reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_REVIEW_SELF_APPROVAL_DENIED' });
    expect(fixture.resolveCalls()).toBe(0);
  });

  test('returns opaque null for a workflow review item in another project', async () => {
    const fixture = resolutionGuardFixture({ risk: 'medium' });

    await expect(
      fixture.adapter.resolve({
        reviewItemId: fixture.reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'approve',
      }),
    ).resolves.toBeNull();
    expect(fixture.loadApprovalCalls()).toBe(0);
    expect(fixture.resolveCalls()).toBe(0);
  });

  test('rejects non-workflow Review Center verdicts before state mutation', async () => {
    const fixture = resolutionGuardFixture({ risk: 'medium' });

    await expect(
      fixture.adapter.resolve({
        reviewItemId: fixture.reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'dismiss',
      }),
    ).rejects.toMatchObject({ code: 'WORKFLOW_REVIEW_VERDICT_INVALID' });
    expect(fixture.resolveCalls()).toBe(0);
  });

  test('preserves a resolved workflow when projection reconciliation and reporting fail', async () => {
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: OTHER_USER_ID,
      status: 'waiting_approval',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'waiting_approval' });
    const approval = workflowApprovalFixture({
      run_id: run.run_id,
      node_id: node.node_id,
      risk: 'medium',
    });
    const resolvedApproval = {
      ...approval,
      status: 'approved' as const,
      acting_user_id: USER_ID,
      decision: 'approve' as const,
      feedback_hash: null,
      resolved_at: NOW,
    };
    const reviewItemId = workflowReviewItemId(approval.approval_id);
    const projection = {
      reviewItemId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      originSessionId: null,
      kind: 'decision' as const,
      status: 'needs_you' as const,
      risk: 'medium' as const,
      source: 'agent' as const,
      title: 'Workflow approval required',
      summary: approval.action_summary,
      detail: {},
      agent: node.agent_name ?? '',
      createdBy: OTHER_USER_ID,
      actedBy: null,
      actedAt: null,
      feedback: null,
      metadata: {
        namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
        approval_id: approval.approval_id,
        run_id: run.run_id,
        node_id: node.node_id,
      },
      createdAt: new Date(approval.requested_at),
      updatedAt: new Date(approval.requested_at),
    } satisfies WorkflowReviewProjectionRecord;
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async () => {
          throw new Error('unused');
        },
        resolveApproval: async () => ({
          run,
          node: { ...node, status: 'running' },
          approval: resolvedApproval,
        }),
        resumeRun: async () => ({ ...run, status: 'running', updated_at: NOW }),
      },
      projection: {
        upsert: async () => {
          throw new Error('unused');
        },
        get: async () => projection,
        reconcile: async () => {
          throw new Error('review inbox update unavailable');
        },
      },
      loadApproval: async () => approval,
      authorize: async () => undefined,
      now: () => NOW,
      onProjectionError: () => {
        throw new Error('telemetry unavailable');
      },
    });

    await expect(
      adapter.resolve({
        reviewItemId,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'user',
        actingTokenId: null,
        verdict: 'approve',
      }),
    ).resolves.toMatchObject({
      run: { status: 'running' },
      approval: { status: 'approved' },
      projection: { status: 'approved', actedBy: USER_ID },
    });
  });

  test('denies projection before workflow or inbox writes when review.submit is revoked', async () => {
    const run = workflowRunFixture({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      actor_id: USER_ID,
      status: 'running',
    });
    const node = workflowNodeFixture({ run_id: run.run_id, status: 'running' });
    const approval = workflowApprovalFixture({ run_id: run.run_id, node_id: node.node_id });
    let pauseCalls = 0;
    let projectionCalls = 0;
    const adapter = createWorkflowReviewAdapter({
      workflow: {
        pauseForApproval: async () => {
          pauseCalls += 1;
          throw new Error('must not run');
        },
        resolveApproval: async () => {
          throw new Error('unused');
        },
        resumeRun: async () => {
          throw new Error('unused');
        },
      },
      projection: {
        upsert: async () => {
          projectionCalls += 1;
          throw new Error('must not run');
        },
        get: async () => null,
        reconcile: async () => null,
      },
      loadApproval: async () => null,
      authorize: async ({ action }) => {
        if (action === 'project.review.submit') throw new Error('review.submit revoked');
      },
    });

    await expect(
      adapter.project({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        actorUserId: USER_ID,
        actorType: 'agent',
        actingTokenId: '68000000-0000-4000-a000-000000000001',
        workerId: 'workflow-worker-a',
        run,
        node,
        approval,
      }),
    ).rejects.toThrow('review.submit revoked');
    expect({ pauseCalls, projectionCalls }).toEqual({ pauseCalls: 0, projectionCalls: 0 });
  });
});
