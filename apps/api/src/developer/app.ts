import { createRoute, z } from '@hono/zod-openapi';
import { validateRegistryItem } from '@kortix/registry';
import type { Context, MiddlewareHandler } from 'hono';

import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import {
  DEVELOPER_MODULE_RELEASE_STATUSES,
  DEVELOPER_MODULE_REVIEW_REQUIREMENTS,
  DeveloperModuleReleaseError,
  type DeveloperModuleReleaseService,
} from './releases';

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

export type DeveloperAppDependencies = Readonly<{
  authenticate: MiddlewareHandler<AppEnv>;
  resolveAccountId: (context: Context<AppEnv>, source: 'body' | 'query') => Promise<string>;
  releaseService: Pick<DeveloperModuleReleaseService, 'submit' | 'list' | 'get'>;
}>;

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

  return app;
}
