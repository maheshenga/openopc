import { AutomationErrorSchema } from '@kortix/intelligence-contracts';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ZodTypeAny } from 'zod';
import type { AutomationApiDependencies } from '../index';

export async function loadAutomationProject(
  context: Context,
  dependencies: AutomationApiDependencies,
  projectId: string,
  action: 'read' | 'write' | 'manage',
) {
  const loaded = await dependencies.loadProject(context, projectId, action);
  if (!loaded) throw new HTTPException(404, { message: 'Project not found' });
  return loaded;
}

export function invalidAutomationRequest(context: Context, message: string): never {
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

export function forwardAutomationJson(
  context: Context,
  response: { status: number; body: unknown },
  successSchema: ZodTypeAny,
): never {
  const success = successSchema.safeParse(response.body);
  if (response.status >= 200 && response.status < 300 && success.success) {
    return context.json(success.data, response.status as never) as never;
  }
  const error = AutomationErrorSchema.safeParse(response.body);
  if (response.status >= 400 && response.status <= 599 && error.success) {
    return context.json(error.data, response.status as never) as never;
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
