import { createRoute, z } from '@hono/zod-openapi';
import { validateRegistryItem } from '@kortix/registry';
import type { Context, MiddlewareHandler } from 'hono';

import { ACCOUNT_ACTIONS } from '../iam/actions';
import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  DEVELOPER_MODULE_REVIEW_REQUIREMENTS,
  DeveloperModuleReleaseError,
  type DeveloperModuleReleaseService,
} from './releases';
import { DeveloperModuleReviewError, type DeveloperModuleReviewService } from './reviews';

const RegistryValidationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  path: z.string(),
  message: z.string(),
});

const RegistryValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(RegistryValidationIssueSchema),
});

const RegistryItemBodySchema = z.record(z.unknown());

const DeveloperModuleReleaseSchema = z.object({
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

const DeveloperModuleReleaseSubmissionSchema = z.object({
  created: z.boolean(),
  release: DeveloperModuleReleaseSchema,
});

const DeveloperModuleReleaseListSchema = z.object({
  releases: z.array(DeveloperModuleReleaseSchema),
});

const DeveloperModuleReleaseBodySchema = z.object({
  account_id: z.string().uuid().optional(),
  item: z.record(z.unknown()),
});

const DeveloperModuleReleaseQuerySchema = z.object({
  account_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const DeveloperModuleReviewEvidenceSchema = z
  .object({
    requirement: z.enum(DEVELOPER_MODULE_REVIEW_REQUIREMENTS),
    outcome: z.literal('passed'),
    method: z.literal('manual'),
    summary: z.string(),
    observed_at: z.string(),
    tool: z.string().optional(),
    tool_version: z.string().optional(),
    evidence_digest: z.string().optional(),
  })
  .strict();

const DeveloperModuleReviewEventSchema = z.object({
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
  evidence: z.array(DeveloperModuleReviewEvidenceSchema),
  created_at: z.string(),
});

const DeveloperModuleReviewTransitionSchema = z.object({
  release: DeveloperModuleReleaseSchema,
  event: DeveloperModuleReviewEventSchema,
});

const DeveloperModuleReviewHistorySchema = z.object({
  history: z.array(DeveloperModuleReviewEventSchema),
});

const DeveloperModuleReviewRequestSchema = z
  .object({
    account_id: z.string().uuid().optional(),
    expected_status: z.enum(['validated', 'changes_requested']),
    expected_revision: z.number().int().min(0),
    reason: z.string().max(4_000).optional(),
  })
  .strict();

const DeveloperModuleReviewHistoryQuerySchema = z
  .object({ account_id: z.string().uuid().optional() })
  .strict();

type DeveloperAccountAction =
  | typeof ACCOUNT_ACTIONS.ACCOUNT_READ
  | typeof ACCOUNT_ACTIONS.ACCOUNT_WRITE;

export type DeveloperAppDependencies = Readonly<{
  authenticate: MiddlewareHandler<AppEnv>;
  resolveAccountId: (context: Context<AppEnv>, source: 'body' | 'query') => Promise<string>;
  authorizeAccount: (
    context: Context<AppEnv>,
    accountId: string,
    action: DeveloperAccountAction,
  ) => Promise<void>;
  releaseService: Pick<DeveloperModuleReleaseService, 'submit' | 'list' | 'get'>;
  reviewService: Pick<DeveloperModuleReviewService, 'requestReview' | 'history'>;
}>;

function reviewErrorResponse(context: Context<AppEnv>, error: unknown) {
  if (!(error instanceof DeveloperModuleReviewError)) throw error;
  const body = { error: error.code };
  if (error.status === 400) return context.json(body, 400);
  if (error.status === 403) return context.json(body, 403);
  if (error.status === 404) return context.json(body, 404);
  return context.json(body, 409);
}

export function createDeveloperApp(dependencies: DeveloperAppDependencies) {
  const app = makeOpenApiApp<AppEnv>();

  app.use('*', dependencies.authenticate);
  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/validate',
      tags: ['developer'],
      summary: 'Validate a developer module registry item',
      ...auth,
      request: {
        body: {
          required: true,
          content: {
            'application/json': { schema: RegistryItemBodySchema },
          },
        },
      },
      responses: {
        200: json(RegistryValidationResultSchema, 'Module validation result'),
        ...errors(400, 401),
      },
    }),
    (context) => context.json(validateRegistryItem(context.req.valid('json')), 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/releases',
      tags: ['developer'],
      summary: 'Submit an immutable validated developer module release',
      ...auth,
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleReleaseBodySchema } },
        },
      },
      responses: {
        200: json(DeveloperModuleReleaseSubmissionSchema, 'Idempotent existing release'),
        201: json(DeveloperModuleReleaseSubmissionSchema, 'Validated release created'),
        ...errors(400, 401, 403, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      try {
        const result = await dependencies.releaseService.submit({
          accountId,
          actorUserId: context.get('userId'),
          item: context.req.valid('json').item,
        });
        return context.json(result, result.created ? 201 : 200);
      } catch (error) {
        if (!(error instanceof DeveloperModuleReleaseError)) throw error;
        const body = { error: error.code };
        if (error.status === 400) return context.json(body, 400);
        return context.json(body, 409);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases',
      tags: ['developer'],
      summary: 'List account-scoped developer module releases',
      ...auth,
      request: { query: DeveloperModuleReleaseQuerySchema },
      responses: {
        200: json(DeveloperModuleReleaseListSchema, 'Developer module releases'),
        ...errors(400, 401, 403),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      const query = context.req.valid('query');
      const releases = await dependencies.releaseService.list({ accountId, limit: query.limit });
      return context.json({ releases: [...releases] }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases/{releaseId}',
      tags: ['developer'],
      summary: 'Read one account-scoped developer module release',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        query: z.object({ account_id: z.string().uuid().optional() }),
      },
      responses: {
        200: json(DeveloperModuleReleaseSchema, 'Developer module release'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const release = await dependencies.releaseService.get({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json(release, 200);
      } catch (error) {
        if (!(error instanceof DeveloperModuleReleaseError)) throw error;
        return context.json({ error: error.code }, 404);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/modules/releases/{releaseId}/review-requests',
      tags: ['developer'],
      summary: 'Request or resubmit a developer module release for platform review',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        body: {
          required: true,
          content: { 'application/json': { schema: DeveloperModuleReviewRequestSchema } },
        },
      },
      responses: {
        201: json(DeveloperModuleReviewTransitionSchema, 'Review request recorded'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'body');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);
      const body = context.req.valid('json');
      try {
        const transition = await dependencies.reviewService.requestReview({
          accountId,
          releaseId: context.req.valid('param').releaseId,
          actorUserId: context.get('userId'),
          expectedStatus: body.expected_status,
          expectedRevision: body.expected_revision,
          reason: body.reason,
        });
        return context.json(transition, 201);
      } catch (error) {
        return reviewErrorResponse(context, error);
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/modules/releases/{releaseId}/review-history',
      tags: ['developer'],
      summary: 'Read immutable developer module review history',
      ...auth,
      request: {
        params: z.object({ releaseId: z.string().uuid() }),
        query: DeveloperModuleReviewHistoryQuerySchema,
      },
      responses: {
        200: json(DeveloperModuleReviewHistorySchema, 'Chronological review history'),
        ...errors(400, 401, 403, 404),
      },
    }),
    async (context) => {
      const accountId = await dependencies.resolveAccountId(context, 'query');
      context.set('accountId', accountId);
      await dependencies.authorizeAccount(context, accountId, ACCOUNT_ACTIONS.ACCOUNT_READ);
      try {
        const history = await dependencies.reviewService.history({
          accountId,
          releaseId: context.req.valid('param').releaseId,
        });
        return context.json({ history: [...history] }, 200);
      } catch (error) {
        if (error instanceof DeveloperModuleReviewError && error.status === 404) {
          return context.json({ error: error.code }, 404);
        }
        throw error;
      }
    },
  );

  return app;
}
