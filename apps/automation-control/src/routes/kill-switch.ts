import { Hono } from 'hono';
import { z } from 'zod';
import type { InternalAutomationEnv } from '../internal-auth';
import type { KillSwitchScope, KillSwitchService } from '../kill-switch-service';

const KillSwitchBodySchema = z
  .object({
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('account') }).strict(),
      z.object({ kind: z.literal('project') }).strict(),
      z.object({ kind: z.literal('device'), device_id: z.string().uuid() }).strict(),
    ]),
  })
  .strict();

export function createKillSwitchRouter(service: KillSwitchService): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();
  router.post('/', async (context) => {
    const body = KillSwitchBodySchema.safeParse(await context.req.json().catch(() => null));
    if (!body.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Kill-switch request is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const actor = context.get('automationActor');
    let scope: KillSwitchScope;
    if (body.data.scope.kind === 'account') {
      scope = { kind: 'account', accountId: actor.accountId };
    } else if (body.data.scope.kind === 'project') {
      scope = { kind: 'project', accountId: actor.accountId, projectId: actor.projectId };
    } else {
      scope = {
        kind: 'device',
        accountId: actor.accountId,
        projectId: actor.projectId,
        deviceId: body.data.scope.device_id,
      };
    }
    const activated = await service.activate(scope, actor);
    return context.json({
      generation: activated.generation,
      audit_event_id: activated.auditEventId,
    });
  });
  return router;
}
