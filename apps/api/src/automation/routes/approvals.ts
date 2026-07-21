import { createRoute, z } from '@hono/zod-openapi';
import { AutomationApprovalSchema } from '@kortix/intelligence-contracts';
import { auth, errors, json, makeOpenApiApp } from '../../openapi';
import type { AppEnv } from '../../types';
import { automationActorFromProject } from '../auth-context';
import type { AutomationApiDependencies } from '../index';
import { forwardAutomationJson, invalidAutomationRequest, loadAutomationProject } from './shared';

const ApprovalQuerySchema = z.object({
  project_id: z.string().uuid(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'consumed']).default('pending'),
});
const ResolveApprovalBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    action_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const ApprovalListSchema = z
  .object({ approvals: z.array(AutomationApprovalSchema).max(256) })
  .strict();
const InternalResolutionSchema = z
  .object({
    approval_id: z.string().uuid(),
    status: z.enum(['approved', 'rejected']),
    token: z.string().nullable(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export function createAutomationApprovalsRouter(dependencies: AutomationApiDependencies) {
  const router = makeOpenApiApp<AppEnv>();
  router.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['automation'],
      summary: 'List automation approvals',
      ...auth,
      request: { query: ApprovalQuerySchema },
      responses: { 200: json(z.any(), 'Approvals'), ...errors(400, 401, 403, 404, 503) },
    }),
    async (context) => {
      const { project_id: projectId, status } = context.req.valid('query');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'read');
      const response = await dependencies.controlClient.request({
        method: 'GET',
        path: `/v1/automation/approvals?status=${encodeURIComponent(status)}`,
        actor: automationActorFromProject(loaded),
      });
      return forwardAutomationJson(context, response, ApprovalListSchema);
    },
  );
  router.openapi(
    createRoute({
      method: 'post',
      path: '/{approvalId}/resolve',
      tags: ['automation'],
      summary: 'Resolve an automation approval',
      ...auth,
      request: {
        params: z.object({ approvalId: z.string().uuid() }),
        query: z.object({ project_id: z.string().uuid() }),
        body: { content: { 'application/json': { schema: ResolveApprovalBodySchema } } },
      },
      responses: {
        200: json(z.any(), 'Resolved approval'),
        ...errors(400, 401, 403, 404, 409, 503),
      },
    }),
    async (context) => {
      const body = ResolveApprovalBodySchema.safeParse(await context.req.json().catch(() => null));
      if (!body.success) return invalidAutomationRequest(context, 'Approval resolution is invalid');
      const { project_id: projectId } = context.req.valid('query');
      const { approvalId } = context.req.valid('param');
      const loaded = await loadAutomationProject(context, dependencies, projectId, 'write');
      const response = await dependencies.controlClient.request({
        method: 'POST',
        path: `/v1/automation/approvals/${approvalId}/resolve`,
        actor: automationActorFromProject(loaded),
        body: body.data,
      });
      const parsed = InternalResolutionSchema.safeParse(response.body);
      if (response.status >= 200 && response.status < 300 && parsed.success) {
        const { token: _token, ...publicValue } = parsed.data;
        return context.json(publicValue, 200) as never;
      }
      return forwardAutomationJson(context, response, InternalResolutionSchema);
    },
  );
  return router;
}
