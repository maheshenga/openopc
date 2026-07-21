import { type Database, automationApprovals, automationJobs } from '@kortix/db';
import { type AutomationApproval, AutomationApprovalSchema } from '@kortix/intelligence-contracts';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApprovalService, OneTimeApprovalToken } from '../approval-service';
import type { InternalAutomationEnv } from '../internal-auth';

const ApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']);
const ResolveApprovalBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    action_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();

export interface ApprovalRouteStore {
  list(input: {
    accountId: string;
    projectId: string;
    status: z.infer<typeof ApprovalStatusSchema>;
  }): Promise<readonly AutomationApproval[]>;
  resolve(input: {
    accountId: string;
    projectId: string;
    approvalId: string;
    actionHash: `sha256:${string}`;
    actorUserId: string;
    decision: 'approve' | 'reject';
  }): Promise<OneTimeApprovalToken | null>;
}

export function createPostgresApprovalRouteStore(
  db: Database,
  approvalService: ApprovalService,
): ApprovalRouteStore {
  return {
    async list(input) {
      const rows = await db
        .select({ approval: automationApprovals })
        .from(automationApprovals)
        .innerJoin(automationJobs, eq(automationJobs.jobId, automationApprovals.jobId))
        .where(
          and(
            eq(automationJobs.accountId, input.accountId),
            eq(automationJobs.projectId, input.projectId),
            eq(automationApprovals.status, input.status),
          ),
        )
        .orderBy(desc(automationApprovals.createdAt))
        .limit(256);
      return rows.map(({ approval }) =>
        AutomationApprovalSchema.parse({
          approval_id: approval.approvalId,
          job_id: approval.jobId,
          step_id: approval.stepId,
          project_id: input.projectId,
          action_hash: approval.actionHash,
          status: approval.status,
          acting_user_id: approval.actingUserId,
          expires_at: approval.expiresAt,
          resolved_at: approval.resolvedAt,
        }),
      );
    },
    resolve: (input) => approvalService.resolve(input),
  };
}

export function createApprovalsRouter(store: ApprovalRouteStore): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();

  router.get('/', async (context) => {
    const status = ApprovalStatusSchema.safeParse(context.req.query('status') ?? 'pending');
    if (!status.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Approval status is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const actor = context.get('automationActor');
    const approvals = await store.list({
      accountId: actor.accountId,
      projectId: actor.projectId,
      status: status.data,
    });
    return context.json({ approvals });
  });

  router.post('/:approvalId/resolve', async (context) => {
    const body = ResolveApprovalBodySchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Approval resolution is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const actor = context.get('automationActor');
    const resolved = await store.resolve({
      accountId: actor.accountId,
      projectId: actor.projectId,
      approvalId: context.req.param('approvalId'),
      actionHash: body.data.action_hash as `sha256:${string}`,
      actorUserId: actor.userId,
      decision: body.data.decision,
    });
    return context.json(
      resolved
        ? {
            approval_id: resolved.approvalId,
            status: 'approved' as const,
            token: resolved.token,
            expires_at: resolved.expiresAt,
          }
        : {
            approval_id: context.req.param('approvalId'),
            status: 'rejected' as const,
            token: null,
            expires_at: null,
          },
    );
  });

  return router;
}
