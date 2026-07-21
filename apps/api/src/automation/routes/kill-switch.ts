import { createRoute, z } from '@hono/zod-openapi';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';
import { forwardAutomationJson, invalidAutomationRequest, loadAutomationProject } from './shared';

const KillSwitchBodySchema = z
  .object({
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account') }).strict(),
      z.object({ kind: z.literal('project') }).strict(),
      z.object({ kind: z.literal('device'), device_id: z.string().uuid() }).strict(),
    ]),
  })
  .strict();
const KillSwitchResultSchema = z
  .object({ generation: z.number().int().nonnegative(), audit_event_id: z.string().uuid() })
  .strict();

export function createAutomationKillSwitchRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['automation'],
      summary: 'Activate automation kill switch',
      ...auth,
      request: {
        query: z.object({ project_id: z.string().uuid() }),
        body: { content: { 'application/json': { schema: KillSwitchBodySchema } } },
      },
      responses: {
        200: json(z.any(), 'Kill switch activated'),
        ...errors(400, 401, 403, 404, 503),
      },
    }),
    async (context) => {
      const body = KillSwitchBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return invalidAutomationRequest(context, 'Kill-switch request is invalid');
      const { project_id: projectId } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'manage');
      const response = await dependencies.controlClient.request({
        method: 'POST',
        path: '/v1/automation/kill-switch',
        actor: automationActorFromProject(
          loaded,
          body.data.scope.kind === 'device' ? body.data.scope.device_id : null,
        ),
        body: body.data,
      });
      return forwardAutomationJson(context, response, KillSwitchResultSchema);
    },
  );
  return router;
}
