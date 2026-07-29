import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

import { DeveloperApplicationSchema } from '../developer/app';
import {
  DEVELOPER_APPLICATION_REVIEW_PERMISSION,
  DeveloperApplicationError,
  type DeveloperApplicationService,
} from '../developer/applications';
import { auth, errors, json } from '../openapi';
import type { AppEnv } from '../types';
import { authorizeAdminDecision } from './admin-authorization';

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
  applicationService: Pick<DeveloperApplicationService, 'decide' | 'suspend'>;
}

async function authorizeReview(context: Context<AppEnv>): Promise<string> {
  try {
    const decision = await authorizeAdminDecision(context, {
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
        const actorUserId = await authorizeReview(context);
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
        const actorUserId = await authorizeReview(context);
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
