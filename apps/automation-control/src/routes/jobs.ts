import { AutomationJobRequestSchema } from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { InternalAutomationEnv } from '../internal-auth';
import type { AutomationRepository } from '../repository';

const MaxJobRequestBytes = 1024 * 1024;

export function createJobsRouter(repository: AutomationRepository): Hono<InternalAutomationEnv> {
  const router = new Hono<InternalAutomationEnv>();

  router.post('/', async (context) => {
    const contentLength = Number(context.req.header('content-length') ?? '0');
    if (contentLength > MaxJobRequestBytes) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Automation request is too large',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      body = null;
    }
    const parsed = AutomationJobRequestSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_INVALID_REQUEST',
          message: 'Automation job request is invalid',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        400,
      );
    }
    const result = await repository.createJob(parsed.data, context.get('automationActor'));
    return context.json(result, result.created ? 201 : 200);
  });

  router.get('/:jobId', async (context) => {
    const actor = context.get('automationActor');
    const job = await repository.getJobForProject(
      actor.accountId,
      actor.projectId,
      context.req.param('jobId'),
    );
    if (!job) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_NOT_FOUND',
          message: 'Automation job was not found',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        404,
      );
    }
    return context.json(job);
  });

  router.post('/:jobId/cancel', async (context) => {
    const actor = context.get('automationActor');
    const job = await repository.requestCancellation(
      actor.accountId,
      actor.projectId,
      context.req.param('jobId'),
      actor.userId,
    );
    return context.json(job);
  });

  return router;
}
