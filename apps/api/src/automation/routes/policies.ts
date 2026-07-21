import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';
import { forwardAutomationJson, invalidAutomationRequest, loadAutomationProject } from './shared';

const ProjectQuerySchema = z.object({ project_id: z.string().uuid() });
const PolicyBodySchema = z
  .object({
    allowed_origins: z.array(z.string().url()).max(64),
    open_network_allowed: z.boolean(),
    persistent_profiles_allowed: z.boolean(),
    full_access_allowed: z.boolean(),
    default_approval_policy: z.enum(['project-default', 'full-access']),
    expected_policy_version: z.string().trim().min(1).max(128),
  })
  .strict();
const PolicySchema = z
  .object({
    project_id: z.string().uuid(),
    allowed_origins: z.array(z.string().url()).max(64),
    open_network_allowed: z.boolean(),
    persistent_profiles_allowed: z.boolean(),
    full_access_allowed: z.boolean(),
    default_approval_policy: z.enum(['project-default', 'full-access']),
    policy_version: z.string().min(1).max(128),
    updated_by: z.string().uuid().nullable(),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export function createAutomationPoliciesRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['automation'],
      summary: 'Get automation policy',
      ...auth,
      request: { query: ProjectQuerySchema },
      responses: { 200: json(z.any(), 'Policy'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'read');
      const response = await dependencies.controlClient.request({
        method: 'GET',
        path: '/v1/automation/policies',
        actor: automationActorFromProject(loaded),
      });
      return forwardAutomationJson(context, response, PolicySchema);
    },
  );
  router.openapi(
    createRoute({
      method: 'put',
      path: '/',
      tags: ['automation'],
      summary: 'Update automation policy',
      ...auth,
      request: {
        query: ProjectQuerySchema,
        body: { content: { 'application/json': { schema: PolicyBodySchema } } },
      },
      responses: { 200: json(z.any(), 'Updated policy'), ...errors(400, 401, 403, 404, 409, 503) },
    }),
    async (context) => {
      const body = PolicyBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return invalidAutomationRequest(context, 'Automation policy is invalid');
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'manage');
      const response = await dependencies.controlClient.request({
        method: 'PUT',
        path: '/v1/automation/policies',
        actor: automationActorFromProject(loaded),
        body: body.data,
      });
      return forwardAutomationJson(context, response, PolicySchema);
    },
  );
  return router;
}
