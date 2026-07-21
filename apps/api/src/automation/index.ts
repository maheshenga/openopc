import type { Context, MiddlewareHandler } from 'hono';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import type { AutomationLoadedProject } from './auth-context';
import type { AutomationControlClient } from './control-client';
import { createAutomationApprovalsRouter } from './routes/approvals';
import { type AutomationDeviceReader, createAutomationDevicesRouter } from './routes/devices';
import { createAutomationEventsRouter } from './routes/events';
import { createAutomationJobsRouter } from './routes/jobs';
import { createAutomationKillSwitchRouter } from './routes/kill-switch';
import { createAutomationPoliciesRouter } from './routes/policies';
import { createAutomationProfilesRouter } from './routes/profiles';

export type AutomationApiDependencies = Readonly<{
  enabled: boolean;
  authenticate: MiddlewareHandler<AppEnv>;
  loadProject(
    context: Context,
    projectId: string,
    action: 'read' | 'write' | 'manage',
  ): Promise<AutomationLoadedProject | null>;
  controlClient: AutomationControlClient;
  traceparent(context: Context): string | null;
  deviceReader?: AutomationDeviceReader;
}>;

export function createAutomationApiApp(dependencies: AutomationApiDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.use('*', dependencies.authenticate);
  app.use('*', async (context, next) => {
    if (!dependencies.enabled) {
      return context.json(
        {
          protocol_version: 'automation.v1',
          code: 'AUTOMATION_UNAVAILABLE',
          message: 'Automation is not enabled',
          retryable: false,
          approval_status: null,
          audit_event_id: null,
        },
        503,
      );
    }
    await next();
  });
  app.route('/jobs', createAutomationJobsRouter(dependencies));
  app.route('/jobs', createAutomationEventsRouter(dependencies));
  app.route('/approvals', createAutomationApprovalsRouter(dependencies));
  app.route('/devices', createAutomationDevicesRouter(dependencies));
  app.route('/browser-profiles', createAutomationProfilesRouter(dependencies));
  app.route('/policies', createAutomationPoliciesRouter(dependencies));
  app.route('/kill-switch', createAutomationKillSwitchRouter(dependencies));
  return app;
}
