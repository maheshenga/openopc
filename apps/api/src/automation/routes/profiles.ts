import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';
import { forwardAutomationJson, invalidAutomationRequest, loadAutomationProject } from './shared';

const ProjectQuerySchema = z.object({ project_id: z.string().uuid() });
const ProfileBodySchema = z
  .object({
    encrypted_state_ref: z.string().regex(/^sealed:[A-Za-z0-9][A-Za-z0-9._:/-]{0,2040}$/),
    state_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
const ProfileSchema = z
  .object({
    profile_id: z.string().uuid(),
    project_id: z.string().uuid(),
    state_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: z.enum(['active', 'revoked', 'expired']),
    created_by: z.string().uuid(),
    last_used_at: z.string().datetime({ offset: true }).nullable(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
    revoked_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();
const ProfileListSchema = z.object({ profiles: z.array(ProfileSchema).max(128) }).strict();

export function createAutomationProfilesRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['automation'],
      summary: 'List browser profiles',
      ...auth,
      request: { query: ProjectQuerySchema },
      responses: { 200: json(z.any(), 'Profiles'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'read');
      const response = await dependencies.controlClient.request({
        method: 'GET',
        path: '/v1/automation/browser-profiles',
        actor: automationActorFromProject(loaded),
      });
      return forwardAutomationJson(context, response, ProfileListSchema);
    },
  );
  router.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['automation'],
      summary: 'Create browser profile',
      ...auth,
      request: {
        query: ProjectQuerySchema,
        body: { content: { 'application/json': { schema: ProfileBodySchema } } },
      },
      responses: { 201: json(z.any(), 'Created profile'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const body = ProfileBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return invalidAutomationRequest(context, 'Browser profile is invalid');
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'write');
      const response = await dependencies.controlClient.request({
        method: 'POST',
        path: '/v1/automation/browser-profiles',
        actor: automationActorFromProject(loaded),
        body: body.data,
      });
      return forwardAutomationJson(context, response, ProfileSchema);
    },
  );
  router.openapi(
    createRoute({
      method: 'delete',
      path: '/{profileId}',
      tags: ['automation'],
      summary: 'Revoke browser profile',
      ...auth,
      request: { params: z.object({ profileId: z.string().uuid() }), query: ProjectQuerySchema },
      responses: { 200: json(z.any(), 'Revoked profile'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const { profileId } = context.req.valid('param');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'write');
      const response = await dependencies.controlClient.request({
        method: 'DELETE',
        path: `/v1/automation/browser-profiles/${profileId}`,
        actor: automationActorFromProject(loaded),
      });
      return forwardAutomationJson(context, response, ProfileSchema);
    },
  );
  return router;
}
