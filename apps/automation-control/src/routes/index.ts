import {
  type AutomationErrorCode,
  AutomationErrorCodeSchema,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import {
  type InternalAuthOptions,
  type InternalAutomationEnv,
  createInternalAuthMiddleware,
} from '../internal-auth';
import type { KillSwitchService } from '../kill-switch-service';
import type { AutomationRepository } from '../repository';
import { type ApprovalRouteStore, createApprovalsRouter } from './approvals';
import {
  type AutomationEventReader,
  type AutomationEventStreamOptions,
  createEventsRouter,
} from './events';
import { createJobsRouter } from './jobs';
import { createKillSwitchRouter } from './kill-switch';
import { type AutomationPolicyStore, createPoliciesRouter } from './policies';
import { type BrowserProfileStore, createProfilesRouter } from './profiles';

export type AutomationRouteDependencies = Readonly<{
  auth: InternalAuthOptions;
  repository: AutomationRepository;
  eventReader: AutomationEventReader;
  eventStream?: AutomationEventStreamOptions;
  approvalStore: ApprovalRouteStore;
  profileStore: BrowserProfileStore;
  policyStore: AutomationPolicyStore;
  killSwitchService: KillSwitchService;
}>;

function statusFor(code: AutomationErrorCode): 400 | 403 | 404 | 409 | 500 {
  if (code === 'AUTOMATION_FORBIDDEN') return 403;
  if (code === 'AUTOMATION_NOT_FOUND') return 404;
  if (code === 'AUTOMATION_CONFLICT') return 409;
  if (code === 'AUTOMATION_INVALID_REQUEST') return 400;
  return 500;
}

export function createAutomationRoutes(
  dependencies: AutomationRouteDependencies,
): Hono<InternalAutomationEnv> {
  const app = new Hono<InternalAutomationEnv>();
  app.use('/v1/automation/*', createInternalAuthMiddleware(dependencies.auth));
  app.route('/v1/automation/jobs', createJobsRouter(dependencies.repository));
  app.route(
    '/v1/automation/jobs',
    createEventsRouter({
      repository: dependencies.repository,
      eventReader: dependencies.eventReader,
      stream: dependencies.eventStream,
    }),
  );
  app.route('/v1/automation/approvals', createApprovalsRouter(dependencies.approvalStore));
  app.route('/v1/automation/browser-profiles', createProfilesRouter(dependencies.profileStore));
  app.route('/v1/automation/policies', createPoliciesRouter(dependencies.policyStore));
  app.route('/v1/automation/kill-switch', createKillSwitchRouter(dependencies.killSwitchService));
  app.onError((error, context) => {
    const rawCode =
      'code' in error && typeof error.code === 'string' ? error.code : 'AUTOMATION_INTERNAL';
    const parsedCode = AutomationErrorCodeSchema.safeParse(
      rawCode === 'AUTOMATION_APPROVAL_EXPIRED' ? 'AUTOMATION_CONFLICT' : rawCode,
    );
    const code = parsedCode.success ? parsedCode.data : 'AUTOMATION_INTERNAL';
    return context.json(
      {
        protocol_version: 'automation.v1',
        code,
        message: code === 'AUTOMATION_INTERNAL' ? 'Automation request failed' : error.message,
        retryable: false,
        approval_status: null,
        audit_event_id: null,
      },
      statusFor(code),
    );
  });
  return app;
}
