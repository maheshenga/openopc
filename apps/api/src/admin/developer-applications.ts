import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { DeveloperApplicationSchema, DeveloperOrganizationSchema } from '../developer/app';
import {
  DEVELOPER_APPLICATION_STATES,
  DEVELOPER_APPLICATION_REVIEW_PERMISSION,
  DeveloperApplicationError,
  type DeveloperApplicationService,
} from '../developer/applications';
import { auth, errors, json } from '../openapi';
import type { AppEnv } from '../types';
import {
  authorizeAdminDecision,
  authorizeAdminTarget,
  type AdminDecisionAuthorizer,
} from './admin-authorization';

const AdminApplicationListItemSchema = z.object({
  application: DeveloperApplicationSchema,
  organization: DeveloperOrganizationSchema,
}).strict();

const AdminApplicationPageSchema = z.object({
  applications: z.array(AdminApplicationListItemSchema),
  next_cursor: z.string().nullable(),
}).strict();

const PolicyAcceptanceSchema = z.object({
  account_id: z.string().uuid(),
  user_id: z.string().uuid(),
  policy: z.enum(['acceptable_use', 'module_rules']),
  version: z.string(),
  source: z.literal('developer_application'),
  accepted_at: z.string(),
}).strict();

const ApplicationAuditEventSchema = z.object({
  action: z.enum([
    'developer_application.submitted',
    'developer_application.approved',
    'developer_application.rejected',
    'developer_application.suspended',
  ]),
  account_id: z.string().uuid(),
  application_id: z.string().uuid(),
  actor_user_id: z.string().uuid(),
  from_state: z
    .object({ state: z.enum(DEVELOPER_APPLICATION_STATES), revision: z.number().int() })
    .nullable(),
  to_state: z.object({ state: z.enum(DEVELOPER_APPLICATION_STATES), revision: z.number().int() }),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
}).strict();

const AdminApplicationDetailSchema = AdminApplicationListItemSchema.extend({
  policy_acceptances: z.array(PolicyAcceptanceSchema),
  history: z.array(ApplicationAuditEventSchema),
}).strict();

const ApplicationListQuerySchema = z
  .object({
    state: z.enum(DEVELOPER_APPLICATION_STATES).default('submitted'),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

const DecisionBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    expected_revision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

const SuspensionBodySchema = z
  .object({
    expected_revision: z.number().int().nonnegative(),
    reason: z.string().min(1).max(4_000),
  })
  .strict();

export interface AdminDeveloperApplicationRouteDependencies {
  applicationService: Pick<
    DeveloperApplicationService,
    'adminList' | 'adminGet' | 'decide' | 'suspend'
  >;
  authorizeAdminDecision?: AdminDecisionAuthorizer;
}

const APPLICATION_READ_REQUIREMENT = {
  permission: DEVELOPER_APPLICATION_REVIEW_PERMISSION,
  stepUp: false,
  crossTenantAudit: true,
} as const;

async function authorizeReview(
  context: Context<AppEnv>,
  authorize: AdminDecisionAuthorizer,
): Promise<string> {
  try {
    const decision = await authorize(context, {
      permission: DEVELOPER_APPLICATION_REVIEW_PERMISSION,
      stepUp: true,
      crossTenantAudit: false,
    });
    return decision.actorUserId;
  } catch (error) {
    if (error instanceof HTTPException && error.status === 403) {
      const code = error.message.includes('Step-up')
        ? 'DEVELOPER_APPLICATION_STEP_UP_REQUIRED'
        : 'DEVELOPER_APPLICATION_FORBIDDEN';
      throw new DeveloperApplicationError(code, 403);
    }
    throw error;
  }
}

function errorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperApplicationError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  if (error.status === 409) return context.json(body, 409);
  return context.json(body, 503);
}

export function registerAdminDeveloperApplicationRoutes(
  app: OpenAPIHono<AppEnv>,
  dependencies: AdminDeveloperApplicationRouteDependencies,
): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/applications',
      tags: ['admin', 'developer'],
      summary: 'List the platform developer application review queue',
      ...auth,
      request: { query: ApplicationListQuerySchema },
      responses: {
        200: json(AdminApplicationPageSchema, 'Developer application review queue'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      try {
        const authorize = dependencies.authorizeAdminDecision ?? authorizeAdminDecision;
        await authorize(context, { ...APPLICATION_READ_REQUIREMENT, crossTenantAudit: false });
        const query = context.req.valid('query');
        return context.json(
          await dependencies.applicationService.adminList({
            state: query.state,
            limit: query.limit,
            cursor: query.cursor,
          }),
          200,
        );
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/developer/applications/{applicationId}',
      tags: ['admin', 'developer'],
      summary: 'Read a developer application and its immutable review history',
      ...auth,
      request: { params: z.object({ applicationId: z.string().uuid() }) },
      responses: {
        200: json(AdminApplicationDetailSchema, 'Developer application review detail'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      try {
        const authorize = dependencies.authorizeAdminDecision ?? authorizeAdminDecision;
        await authorize(context, { ...APPLICATION_READ_REQUIREMENT, crossTenantAudit: false });
        const detail = await dependencies.applicationService.adminGet({
          applicationId: context.req.valid('param').applicationId,
        });
        await authorizeAdminTarget(
          context,
          detail.application.account_id,
          APPLICATION_READ_REQUIREMENT,
          authorize,
        );
        return context.json(detail, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/applications/{applicationId}/decision',
      tags: ['admin', 'developer'],
      summary: 'Approve or reject a revision-fenced developer application',
      ...auth,
      request: {
        params: z.object({ applicationId: z.string().uuid() }),
        body: { required: true, content: { 'application/json': { schema: DecisionBodySchema } } },
      },
      responses: {
        200: json(DeveloperApplicationSchema, 'Developer application decision recorded'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      try {
        const actorUserId = await authorizeReview(
          context,
          dependencies.authorizeAdminDecision ?? authorizeAdminDecision,
        );
        const body = context.req.valid('json');
        const application = await dependencies.applicationService.decide({
          actorUserId,
          applicationId: context.req.valid('param').applicationId,
          decision: body.decision,
          expectedRevision: body.expected_revision,
          reason: body.reason,
        });
        context.set('accountId', application.account_id);
        return context.json(application, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/applications/{applicationId}/suspend',
      tags: ['admin', 'developer'],
      summary: 'Suspend an approved developer application',
      ...auth,
      request: {
        params: z.object({ applicationId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: SuspensionBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperApplicationSchema, 'Developer application suspended'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      try {
        const actorUserId = await authorizeReview(
          context,
          dependencies.authorizeAdminDecision ?? authorizeAdminDecision,
        );
        const body = context.req.valid('json');
        const application = await dependencies.applicationService.suspend({
          actorUserId,
          applicationId: context.req.valid('param').applicationId,
          expectedRevision: body.expected_revision,
          reason: body.reason,
        });
        context.set('accountId', application.account_id);
        return context.json(application, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );
}
