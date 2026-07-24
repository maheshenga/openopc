import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  DEVELOPER_MODULE_REVIEW_REQUIREMENTS,
} from '../developer/releases';
import {
  DeveloperModuleReviewError,
  type DeveloperModuleReviewService,
} from '../developer/reviews';
import { auth, errors, json } from '../openapi';
import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';

const ReleaseSchema = z.object({
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  item_name: z.string(),
  publisher_id: z.string(),
  module_id: z.string(),
  module_version: z.string(),
  manifest: z.record(z.unknown()),
  manifest_digest: z.string(),
  review_requirements: z.array(z.enum(DEVELOPER_MODULE_REVIEW_REQUIREMENTS)),
  status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  review_revision: z.number().int().min(0),
  created_by: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
});

const EvidenceSchema = z
  .object({
    requirement: z.enum(DEVELOPER_MODULE_REVIEW_REQUIREMENTS),
    outcome: z.literal('passed'),
    method: z.literal('manual'),
    summary: z.string().max(1_000),
    observed_at: z.string(),
    tool: z.string().optional(),
    tool_version: z.string().optional(),
    evidence_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

const EventSchema = z.object({
  review_event_id: z.string().uuid(),
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  action: z.enum(['submit', 'resubmit', 'request_changes', 'approve', 'revoke']),
  from_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  to_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  actor_user_id: z.string().uuid(),
  actor_kind: z.enum(['publisher', 'platform_admin']),
  reason: z.string().nullable(),
  evidence: z.array(EvidenceSchema),
  created_at: z.string(),
});

const TransitionSchema = z.object({ release: ReleaseSchema, event: EventSchema });
const DetailSchema = z.object({ release: ReleaseSchema, history: z.array(EventSchema) });
const QueueSchema = z.object({
  releases: z.array(ReleaseSchema),
  next_cursor: z.string().nullable(),
});

const QueueQuerySchema = z
  .object({
    status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES).default('review_pending'),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const DecisionBodySchema = z
  .object({
    decision: z.enum(['request_changes', 'approve', 'revoke']),
    expected_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
    expected_revision: z.number().int().min(0),
    reason: z.string().max(4_000).optional(),
    evidence: z.array(EvidenceSchema).max(16).optional(),
  })
  .strict();

export type AdminDeveloperReviewRouteDependencies = Readonly<{
  reviewService: Pick<DeveloperModuleReviewService, 'adminList' | 'adminGet' | 'decide'>;
  recordAuditEvent: (input: AuditEventInput) => Promise<unknown>;
}>;

function errorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleReviewError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

function clientIp(context: { req: { header(name: string): string | undefined } }): string | null {
  return (
    context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    context.req.header('x-real-ip') ||
    null
  );
}

function auditAction(action: 'request_changes' | 'approve' | 'revoke'): string {
  if (action === 'request_changes') return 'developer.module.review.changes_requested';
  if (action === 'approve') return 'developer.module.review.approved';
  return 'developer.module.review.revoked';
}

export function registerAdminDeveloperReviewRoutes(
  app: OpenAPIHono<AppEnv>,
  dependencies: AdminDeveloperReviewRouteDependencies,
): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/modules/reviews',
      tags: ['admin', 'developer'],
      summary: 'List the platform developer module review queue',
      ...auth,
      request: { query: QueueQuerySchema },
      responses: {
        200: json(QueueSchema, 'Developer module review queue'),
        ...errors(400, 401, 403),
      },
    }),
    async (context) => {
      const query = context.req.valid('query');
      try {
        const page = await dependencies.reviewService.adminList({
          status: query.status,
          limit: query.limit,
          cursor: query.cursor,
        });
        return context.json(page, 200);
      } catch (error) {
        if (error instanceof DeveloperModuleReviewError && error.status === 400) {
          return context.json({ error: error.code }, 400);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/modules/releases/{releaseId}/review',
      tags: ['admin', 'developer'],
      summary: 'Read one developer module release and its immutable review history',
      ...auth,
      request: { params: z.object({ releaseId: z.string().uuid() }) },
      responses: {
        200: json(DetailSchema, 'Developer module review detail'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (context) => {
      try {
        const detail = await dependencies.reviewService.adminGet({
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json(detail, 200);
      } catch (error) {
        if (error instanceof DeveloperModuleReviewError && error.status === 404) {
          return context.json({ error: error.code }, 404);
        }
        throw error;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/modules/releases/{releaseId}/review-decisions',
      tags: ['admin', 'developer'],
      summary: 'Record a platform-admin developer module review decision',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DecisionBodySchema } },
        },
      },
      responses: {
        200: json(TransitionSchema, 'Developer module review decision recorded'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      try {
        const transition = await dependencies.reviewService.decide({
          releaseId: context.req.valid('param').releaseId,
          actorUserId: context.get('userId'),
          decision: body.decision,
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
          reason: body.reason,
          evidence: body.evidence,
        });
        context.set('accountId', transition.release.account_id);
        await dependencies
          .recordAuditEvent({
            accountId: transition.release.account_id,
            actorUserId: context.get('userId'),
            action: auditAction(body.decision),
            resourceType: 'developer_module_release',
            resourceId: transition.release.release_id,
            before: {
              status: transition.event.from_status,
              review_revision: body.expected_revision,
            },
            after: {
              status: transition.release.status,
              review_revision: transition.release.review_revision,
            },
            ip: clientIp(context),
            userAgent: context.req.header('user-agent') ?? null,
          })
          .catch(() => undefined);
        return context.json(transition, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );
}
