import { createHash } from 'node:crypto';
import { type Database, intelligenceWorkflowApprovals, intelligenceWorkflowRuns } from '@kortix/db';
import {
  type WorkflowApproval,
  WorkflowApprovalSchema,
  type WorkflowNode,
  type WorkflowRun,
} from '@kortix/intelligence-contracts';
import { type WorkflowPort, canonicalWorkflowHash } from '@kortix/intelligence-orchestration';
import { and, eq } from 'drizzle-orm';

export const WORKFLOW_REVIEW_METADATA_NAMESPACE = 'kortix.intelligence.workflow.approval.v1';

export type WorkflowReviewActorType = 'user' | 'agent' | 'system';
export type WorkflowReviewAction = 'project.review.submit' | 'project.review.act';
export type WorkflowReviewVerdict = 'approve' | 'reject' | 'changes' | 'answer' | 'dismiss';

export type WorkflowReviewAdapterErrorCode =
  | 'WORKFLOW_REVIEW_CONFLICT'
  | 'WORKFLOW_REVIEW_HUMAN_REQUIRED'
  | 'WORKFLOW_REVIEW_SELF_APPROVAL_DENIED'
  | 'WORKFLOW_REVIEW_VERDICT_INVALID';

export class WorkflowReviewAdapterError extends Error {
  constructor(readonly code: WorkflowReviewAdapterErrorCode) {
    super(code);
    this.name = 'WorkflowReviewAdapterError';
  }
}

export type WorkflowReviewProjectionInput = {
  reviewItemId: string;
  accountId: string;
  projectId: string;
  originSessionId: string | null;
  kind: 'decision';
  status: 'needs_you';
  risk: WorkflowApproval['risk'];
  source: 'agent';
  title: string;
  summary: string;
  detail: Record<string, unknown>;
  agent: string;
  createdBy: string;
  metadata: WorkflowReviewMetadata;
  createdAt: Date;
};

export type WorkflowReviewProjectionRecord = Omit<WorkflowReviewProjectionInput, 'status'> & {
  status:
    | 'needs_you'
    | 'waiting'
    | 'approved'
    | 'changes_requested'
    | 'rejected'
    | 'done'
    | 'dismissed';
  actedBy: string | null;
  actedAt: Date | null;
  feedback: string | null;
  updatedAt: Date;
};

export type WorkflowReviewMetadata = {
  namespace: typeof WORKFLOW_REVIEW_METADATA_NAMESPACE;
  approval_id: string;
  run_id: string;
  node_id: string;
};

export interface WorkflowReviewProjectionPort {
  upsert(input: WorkflowReviewProjectionInput): Promise<WorkflowReviewProjectionRecord>;
  get(input: {
    reviewItemId: string;
    accountId: string;
    projectId: string;
  }): Promise<WorkflowReviewProjectionRecord | null>;
  reconcile(input: {
    reviewItemId: string;
    accountId: string;
    projectId: string;
    approval: WorkflowApproval;
    feedback: string | null;
  }): Promise<WorkflowReviewProjectionRecord | null>;
}

export type WorkflowApprovalLookup = (input: {
  accountId: string;
  projectId: string;
  runId: string;
  approvalId: string;
}) => Promise<WorkflowApproval | null>;

export type WorkflowReviewAuthorizer = (input: {
  action: WorkflowReviewAction;
  accountId: string;
  projectId: string;
  actorUserId: string;
  actorType: WorkflowReviewActorType;
  actingTokenId: string | null;
}) => Promise<void>;

export type WorkflowReviewAdapter = ReturnType<typeof createWorkflowReviewAdapter>;

let defaultWorkflowReviewAdapter: WorkflowReviewAdapter | null = null;

export function createWorkflowReviewAdapter(input: {
  workflow: Pick<WorkflowPort, 'pauseForApproval' | 'resolveApproval' | 'resumeRun'>;
  projection: WorkflowReviewProjectionPort;
  loadApproval: WorkflowApprovalLookup;
  authorize: WorkflowReviewAuthorizer;
  now?: () => string;
  onProjectionError?: (error: unknown) => void;
}) {
  return {
    async project(command: {
      accountId: string;
      projectId: string;
      actorUserId: string;
      actorType: WorkflowReviewActorType;
      actingTokenId: string | null;
      workerId: string;
      run: WorkflowRun;
      node: WorkflowNode;
      approval: WorkflowApproval;
    }) {
      await input.authorize(authorization(command, 'project.review.submit'));
      const paused = await input.workflow.pauseForApproval({
        accountId: command.accountId,
        projectId: command.projectId,
        runId: command.run.run_id,
        nodeId: command.node.node_id,
        workerId: command.workerId,
        approval: { ...command.approval, review_item_id: null },
      });
      if (!paused) return null;

      let projection: WorkflowReviewProjectionRecord | null = null;
      try {
        projection = await input.projection.upsert(projectionInput(command, paused.approval));
      } catch (error) {
        reportProjectionError(input.onProjectionError, error);
      }
      return { ...paused, projection };
    },

    async resolve(command: {
      reviewItemId: string;
      accountId: string;
      projectId: string;
      actorUserId: string;
      actorType: WorkflowReviewActorType;
      actingTokenId: string | null;
      verdict: WorkflowReviewVerdict;
      feedback?: string | null;
    }) {
      await input.authorize(authorization(command, 'project.review.act'));
      const projection = await input.projection.get({
        reviewItemId: command.reviewItemId,
        accountId: command.accountId,
        projectId: command.projectId,
      });
      if (!projection) return null;
      const metadata = projection.metadata;
      if (
        metadata.namespace !== WORKFLOW_REVIEW_METADATA_NAMESPACE ||
        workflowReviewItemId(metadata.approval_id) !== command.reviewItemId
      ) {
        throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_CONFLICT');
      }
      const approval = await input.loadApproval({
        accountId: command.accountId,
        projectId: command.projectId,
        runId: metadata.run_id,
        approvalId: metadata.approval_id,
      });
      if (!approval) return null;
      if (
        approval.run_id !== metadata.run_id ||
        approval.node_id !== metadata.node_id ||
        projection.accountId !== command.accountId ||
        projection.projectId !== command.projectId
      ) {
        throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_CONFLICT');
      }
      if (approval.risk === 'high' && command.actorType !== 'user') {
        throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_HUMAN_REQUIRED');
      }
      if (projection.createdBy === command.actorUserId) {
        throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_SELF_APPROVAL_DENIED');
      }
      const decision = workflowDecision(command.verdict);
      const feedback = normalizeFeedback(command.feedback);
      const feedbackHash = feedback ? canonicalWorkflowHash({ feedback }) : null;
      const resolvedAt = resolutionTimestamp(
        approval,
        command.actorUserId,
        decision,
        feedbackHash,
        input.now?.() ?? new Date().toISOString(),
      );
      const resolved = await input.workflow.resolveApproval({
        accountId: command.accountId,
        projectId: command.projectId,
        runId: approval.run_id,
        approvalId: approval.approval_id,
        actingUserId: command.actorUserId,
        decision,
        feedbackHash,
        resolvedAt,
      });
      if (!resolved) return null;

      let resolvedRun = resolved.run;
      if (decision === 'approve') {
        resolvedRun =
          (await input.workflow.resumeRun({
            accountId: command.accountId,
            projectId: command.projectId,
            runId: approval.run_id,
            updatedAt: resolved.approval.resolved_at ?? resolvedAt,
          })) ?? resolvedRun;
      }

      let reconciledProjection: WorkflowReviewProjectionRecord | null = null;
      try {
        reconciledProjection = await input.projection.reconcile({
          reviewItemId: command.reviewItemId,
          accountId: command.accountId,
          projectId: command.projectId,
          approval: resolved.approval,
          feedback,
        });
      } catch (error) {
        reportProjectionError(input.onProjectionError, error);
      }
      return {
        ...resolved,
        run: resolvedRun,
        projection:
          reconciledProjection ??
          reconcileProjectionRecord(projection, resolved.approval, feedback),
      };
    },
  };
}

function reportProjectionError(
  report: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
  try {
    report?.(error);
  } catch {
    // Projection observability cannot change authoritative workflow state.
  }
}

function workflowDecision(
  verdict: WorkflowReviewVerdict,
): 'approve' | 'reject' | 'changes_requested' {
  if (verdict === 'approve') return 'approve';
  if (verdict === 'reject') return 'reject';
  if (verdict === 'changes') return 'changes_requested';
  throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_VERDICT_INVALID');
}

function normalizeFeedback(feedback: string | null | undefined): string | null {
  if (typeof feedback !== 'string') return null;
  const normalized = feedback.trim();
  return normalized === '' ? null : normalized;
}

function resolutionTimestamp(
  approval: WorkflowApproval,
  actorUserId: string,
  decision: 'approve' | 'reject' | 'changes_requested',
  feedbackHash: string | null,
  now: string,
): string {
  if (approval.status === 'pending') return now;
  const expectedStatus = decision === 'approve' ? 'approved' : 'rejected';
  if (
    approval.status !== expectedStatus ||
    approval.acting_user_id !== actorUserId ||
    approval.decision !== decision ||
    approval.feedback_hash !== feedbackHash ||
    approval.resolved_at === null
  ) {
    throw new WorkflowReviewAdapterError('WORKFLOW_REVIEW_CONFLICT');
  }
  return approval.resolved_at;
}

function reconcileProjectionRecord(
  projection: WorkflowReviewProjectionRecord,
  approval: WorkflowApproval,
  feedback: string | null,
): WorkflowReviewProjectionRecord {
  const actedAt = approval.resolved_at ? new Date(approval.resolved_at) : null;
  return {
    ...projection,
    status:
      approval.decision === 'approve'
        ? 'approved'
        : approval.decision === 'changes_requested'
          ? 'changes_requested'
          : approval.status === 'rejected'
            ? 'rejected'
            : 'dismissed',
    actedBy: approval.acting_user_id,
    actedAt,
    feedback,
    updatedAt: actedAt ?? projection.updatedAt,
  };
}

export function workflowReviewItemId(approvalId: string): string {
  const bytes = createHash('sha256')
    .update(`${WORKFLOW_REVIEW_METADATA_NAMESPACE}\0${approvalId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function parseWorkflowReviewMetadata(value: unknown): WorkflowReviewMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join('\0') !== ['approval_id', 'namespace', 'node_id', 'run_id'].join('\0')) return null;
  if (
    candidate.namespace !== WORKFLOW_REVIEW_METADATA_NAMESPACE ||
    typeof candidate.approval_id !== 'string' ||
    typeof candidate.run_id !== 'string' ||
    typeof candidate.node_id !== 'string'
  ) {
    return null;
  }
  return {
    namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
    approval_id: candidate.approval_id,
    run_id: candidate.run_id,
    node_id: candidate.node_id,
  };
}

export function createPostgresWorkflowApprovalLookup(database: Database): WorkflowApprovalLookup {
  return async (input) => {
    const [row] = await database
      .select({
        approvalId: intelligenceWorkflowApprovals.approvalId,
        runId: intelligenceWorkflowApprovals.runId,
        nodeId: intelligenceWorkflowApprovals.nodeId,
        risk: intelligenceWorkflowApprovals.risk,
        reasonCode: intelligenceWorkflowApprovals.reasonCode,
        actionSummary: intelligenceWorkflowApprovals.actionSummary,
        status: intelligenceWorkflowApprovals.status,
        reviewItemId: intelligenceWorkflowApprovals.reviewItemId,
        actingUserId: intelligenceWorkflowApprovals.actingUserId,
        decision: intelligenceWorkflowApprovals.decision,
        feedbackHash: intelligenceWorkflowApprovals.feedbackHash,
        requestedAt: intelligenceWorkflowApprovals.requestedAt,
        resolvedAt: intelligenceWorkflowApprovals.resolvedAt,
      })
      .from(intelligenceWorkflowApprovals)
      .innerJoin(
        intelligenceWorkflowRuns,
        eq(intelligenceWorkflowRuns.runId, intelligenceWorkflowApprovals.runId),
      )
      .where(
        and(
          eq(intelligenceWorkflowApprovals.approvalId, input.approvalId),
          eq(intelligenceWorkflowApprovals.runId, input.runId),
          eq(intelligenceWorkflowRuns.accountId, input.accountId),
          eq(intelligenceWorkflowRuns.projectId, input.projectId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return WorkflowApprovalSchema.parse({
      protocol_version: 'intelligence.workflow.v1',
      approval_id: row.approvalId,
      run_id: row.runId,
      node_id: row.nodeId,
      risk: row.risk,
      reason_code: row.reasonCode,
      action_summary: row.actionSummary,
      status: row.status,
      review_item_id: row.reviewItemId,
      acting_user_id: row.actingUserId,
      decision: row.decision,
      feedback_hash: row.feedbackHash,
      requested_at: new Date(row.requestedAt).toISOString(),
      resolved_at: row.resolvedAt ? new Date(row.resolvedAt).toISOString() : null,
    });
  };
}

export function setDefaultWorkflowReviewAdapter(adapter: WorkflowReviewAdapter | null): void {
  defaultWorkflowReviewAdapter = adapter;
}

export function getDefaultWorkflowReviewAdapter(): WorkflowReviewAdapter | null {
  return defaultWorkflowReviewAdapter;
}

function authorization(
  command: {
    accountId: string;
    projectId: string;
    actorUserId: string;
    actorType: WorkflowReviewActorType;
    actingTokenId: string | null;
  },
  action: WorkflowReviewAction,
) {
  return {
    action,
    accountId: command.accountId,
    projectId: command.projectId,
    actorUserId: command.actorUserId,
    actorType: command.actorType,
    actingTokenId: command.actingTokenId,
  };
}

function projectionInput(
  command: {
    accountId: string;
    projectId: string;
    actorUserId: string;
    run: WorkflowRun;
    node: WorkflowNode;
  },
  approval: WorkflowApproval,
): WorkflowReviewProjectionInput {
  return {
    reviewItemId: workflowReviewItemId(approval.approval_id),
    accountId: command.accountId,
    projectId: command.projectId,
    originSessionId: null,
    kind: 'decision',
    status: 'needs_you',
    risk: approval.risk,
    source: 'agent',
    title: 'Workflow approval required',
    summary: approval.action_summary,
    detail: {
      reason_code: approval.reason_code,
      options: ['approve', 'reject', 'changes_requested'],
    },
    agent: command.node.agent_name ?? command.run.agent_name ?? '',
    createdBy: command.actorUserId,
    metadata: {
      namespace: WORKFLOW_REVIEW_METADATA_NAMESPACE,
      approval_id: approval.approval_id,
      run_id: approval.run_id,
      node_id: approval.node_id,
    },
    createdAt: new Date(approval.requested_at),
  };
}
