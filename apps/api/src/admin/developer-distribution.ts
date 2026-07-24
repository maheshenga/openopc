import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';

import {
  DeveloperModuleDistributionError,
  type DeveloperModuleDistributionService,
} from '../developer/distribution';
import { DEVELOPER_MODULE_RELEASE_STATUSES } from '../developer/releases';
import { auth, errors, json } from '../openapi';
import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';
import { DeveloperModuleReleaseSchema } from './developer-reviews';

const DistributionEventSchema = z.object({
  distribution_event_id: z.string().uuid(),
  release_id: z.string().uuid(),
  account_id: z.string().uuid(),
  sequence: z.number().int().positive(),
  action: z.enum(['sign', 'publish', 'revoke']),
  from_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  to_status: z.enum(DEVELOPER_MODULE_RELEASE_STATUSES),
  actor_user_id: z.string().uuid(),
  actor_kind: z.literal('platform_admin'),
  reason: z.string().nullable(),
  created_at: z.string(),
});

const TransitionSchema = z.object({
  release: DeveloperModuleReleaseSchema,
  event: DistributionEventSchema,
});

const SignBodySchema = z
  .object({
    expected_status: z.literal('approved'),
    expected_revision: z.number().int().min(0),
  })
  .strict();

const PublishBodySchema = z
  .object({
    expected_status: z.literal('signed'),
    expected_revision: z.number().int().min(0),
  })
  .strict();

export type AdminDeveloperDistributionRouteDependencies = Readonly<{
  distributionService: Pick<DeveloperModuleDistributionService, 'sign' | 'publish'>;
  enabled: boolean;
  recordAuditEvent: (input: AuditEventInput) => Promise<unknown>;
}>;

function errorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleDistributionError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  if (error.status === 409) return context.json(body, 409);
  return context.json(body, 503);
}

function assertEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_SIGNER_UNAVAILABLE', 503);
  }
}

function clientIp(context: { req: { header(name: string): string | undefined } }): string | null {
  return (
    context.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    context.req.header('x-real-ip') ||
    null
  );
}

async function recordTransitionAudit(
  context: Context<AppEnv>,
  dependencies: AdminDeveloperDistributionRouteDependencies,
  input: {
    action: 'signed' | 'published';
    expectedStatus: 'approved' | 'signed';
    expectedRevision: number;
    release: {
      account_id: string;
      release_id: string;
      status: string;
      review_revision: number;
      signature_key_id: string | null;
    };
  },
): Promise<void> {
  await dependencies
    .recordAuditEvent({
      accountId: input.release.account_id,
      actorUserId: context.get('userId'),
      action: `developer.module.distribution.${input.action}`,
      resourceType: 'developer_module_release',
      resourceId: input.release.release_id,
      before: {
        status: input.expectedStatus,
        review_revision: input.expectedRevision,
      },
      after: {
        status: input.release.status,
        review_revision: input.release.review_revision,
      },
      ip: clientIp(context),
      userAgent: context.req.header('user-agent') ?? null,
      metadata: { signature_key_id: input.release.signature_key_id },
    })
    .catch(() => undefined);
}

export function registerAdminDeveloperDistributionRoutes(
  app: OpenAPIHono<AppEnv>,
  dependencies: AdminDeveloperDistributionRouteDependencies,
): void {
  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/modules/releases/{releaseId}/sign',
      tags: ['admin', 'developer'],
      summary: 'Sign an approved declarative developer module release',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: SignBodySchema } },
        },
      },
      responses: {
        200: json(TransitionSchema, 'Developer module release signed'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      try {
        assertEnabled(dependencies.enabled);
        const transition = await dependencies.distributionService.sign({
          releaseId: context.req.valid('param').releaseId,
          actorUserId: context.get('userId'),
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
        });
        context.set('accountId', transition.release.account_id);
        await recordTransitionAudit(context, dependencies, {
          action: 'signed',
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
          release: transition.release,
        });
        return context.json(transition, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/developer/modules/releases/{releaseId}/publish',
      tags: ['admin', 'developer'],
      summary: 'Publish a signed developer module release',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: PublishBodySchema } },
        },
      },
      responses: {
        200: json(TransitionSchema, 'Developer module release published'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const body = context.req.valid('json');
      try {
        assertEnabled(dependencies.enabled);
        const transition = await dependencies.distributionService.publish({
          releaseId: context.req.valid('param').releaseId,
          actorUserId: context.get('userId'),
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
        });
        context.set('accountId', transition.release.account_id);
        await recordTransitionAudit(context, dependencies, {
          action: 'published',
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
          release: transition.release,
        });
        return context.json(transition, 200);
      } catch (error) {
        return errorResponse(context, error);
      }
    },
  );
}
