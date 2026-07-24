import { createRoute, z } from '@hono/zod-openapi';
import { validateRegistryItem } from '@kortix/registry';
import type { MiddlewareHandler } from 'hono';

import { auth, errors, json, makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';

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

export type DeveloperAppDependencies = Readonly<{
  authenticate: MiddlewareHandler<AppEnv>;
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

  return app;
}
