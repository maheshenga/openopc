import { createRoute, z } from '@hono/zod-openapi';
import {
  AutomationErrorSchema,
  AutomationJobRequestSchema,
  AutomationJobSchema,
} from '@kortix/intelligence-contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';

const JobIdParamsSchema = z.object({ jobId: z.string().uuid() });
const ProjectQuerySchema = z.object({ project_id: z.string().uuid() });
const CreateJobResponseSchema = z
  .object({ job: AutomationJobSchema, created: z.boolean() })
  .strict();

function invalidRequest(context: Context, message: string): never {
  return context.json(
    {
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_INVALID_REQUEST',
      message,
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    },
    400,
  ) as never;
}

function downstreamResponse(
  context: Context,
  response: { status: number; body: unknown },
  successSchema: z.ZodTypeAny,
): never {
  const success = successSchema.safeParse(response.body);
  if (response.status >= 200 && response.status < 300 && success.success) {
    return context.json(success.data, response.status as 200 | 201) as never;
  }
  const error = AutomationErrorSchema.safeParse(response.body);
  if (error.success && response.status >= 400 && response.status <= 599) {
    return context.json(error.data, response.status as 400) as never;
  }
  return context.json(
    {
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_INTERNAL',
      message: 'Automation control returned an invalid response',
      retryable: true,
      approval_status: null,
      audit_event_id: null,
    },
    502,
  ) as never;
}

async function loadProject(
  context: Context,
  dependencies: AutomationApiDependencies,
  projectId: string,
  action: 'read' | 'write',
) {
  const loaded = await dependencies.loadProject(context, projectId, action);
  if (!loaded) throw new HTTPException(404, { message: 'Project not found' });
  return loaded;
}

export function createAutomationJobsRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();

  router.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['automation'],
      summary: 'Create an automation job',
      ...auth,
      request: {
        body: { content: { 'application/json': { schema: AutomationJobRequestSchema } } },
      },
      responses: {
        200: json(z.any(), 'Existing job'),
        201: json(z.any(), 'Created job'),
        ...errors(400, 401, 403, 404, 503),
      },
    }),
    async (context) => {
      const parsed = AutomationJobRequestSchema.safeParse(
        await context.req.json().catch(() => null),
      );
      if (!parsed.success) return invalidRequest(context, 'Automation job request is invalid');
      const loaded = await loadProject(context, dependencies, parsed.data.project_id, 'write');
      if (loaded.row.accountId !== parsed.data.tenant_id) {
        throw new HTTPException(403, { message: 'Automation account scope does not match' });
      }
      const actor = automationActorFromProject(
        loaded,
        context.req.header('x-kortix-device-id') ?? null,
      );
      const body = {
        ...parsed.data,
        tenant_id: actor.accountId,
        project_id: actor.projectId,
        traceparent: dependencies.traceparent(context) ?? parsed.data.traceparent,
      };
      const response = await dependencies.controlClient.request({
        method: 'POST',
        path: '/v1/automation/jobs',
        actor,
        body,
      });
      return downstreamResponse(context, response, CreateJobResponseSchema);
    },
  );

  router.openapi(
    createRoute({
      method: 'get',
      path: '/{jobId}',
      tags: ['automation'],
      summary: 'Get an automation job',
      ...auth,
      request: { params: JobIdParamsSchema, query: ProjectQuerySchema },
      responses: { 200: json(z.any(), 'Automation job'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const { jobId } = context.req.valid('param');
      const loaded = await loadProject(context, dependencies, projectId, 'read');
      const response = await dependencies.controlClient.request({
        method: 'GET',
        path: `/v1/automation/jobs/${jobId}`,
        actor: automationActorFromProject(loaded),
      });
      return downstreamResponse(context, response, AutomationJobSchema);
    },
  );

  router.openapi(
    createRoute({
      method: 'post',
      path: '/{jobId}/cancel',
      tags: ['automation'],
      summary: 'Cancel an automation job',
      ...auth,
      request: { params: JobIdParamsSchema, query: ProjectQuerySchema },
      responses: { 200: json(z.any(), 'Cancelled job'), ...errors(400, 401, 403, 404, 409, 503) },
    }),
    async (context) => {
      const { project_id: projectId } = context.req.valid('query');
      const { jobId } = context.req.valid('param');
      const loaded = await loadProject(context, dependencies, projectId, 'write');
      const response = await dependencies.controlClient.request({
        method: 'POST',
        path: `/v1/automation/jobs/${jobId}/cancel`,
        actor: automationActorFromProject(loaded),
      });
      return downstreamResponse(context, response, AutomationJobSchema);
    },
  );

  return router;
}
