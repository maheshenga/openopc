import { config } from '../../config';
import { createIntelligenceWorkflowProjectRoutes } from '../../intelligence/workflows/project-routes';
import { buildIntelligenceWorkflowRuntime } from '../../intelligence/workflows/runtime';
import {
  createDefaultIntelligenceProjectRoutes,
  getDefaultStudioApiRuntime,
} from '../../studio/default-routes';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';

projectsApp.route('/', createDefaultIntelligenceProjectRoutes());

if (config.INTELLIGENCE_WORKFLOWS_ENABLED) {
  const [databaseModule, payloadModule, storeModule, serviceModule] = await Promise.all([
    import('../../shared/db'),
    import('../../intelligence/workflows/payload-store'),
    import('../../intelligence/workflows/postgres-store'),
    import('../../intelligence/workflows/service'),
  ]);
  const workflowRuntime = buildIntelligenceWorkflowRuntime({
    enabled: true,
    createService() {
      const studioRuntime = getDefaultStudioApiRuntime();
      if (!studioRuntime.enabled) {
        throw new Error(
          'Intelligence workflows require the configured private Studio object store',
        );
      }
      return serviceModule.createWorkflowService({
        port: storeModule.createPostgresWorkflowStore(databaseModule.db),
        payloads: payloadModule.createStudioWorkflowPayloadStore(studioRuntime.store),
      });
    },
  });

  if (!workflowRuntime.enabled) {
    throw new Error('Intelligence workflow runtime failed to enable');
  }

  projectsApp.route(
    '/',
    createIntelligenceWorkflowProjectRoutes({
      service: workflowRuntime.service,
      loadProjectForUser,
      assertProjectCapability,
      // Task 8 binds installed project Agent/card sources. Until then graph
      // commands fail closed while user start/read/cancel routes remain usable.
      isAgentCardTrusted: async () => false,
    }),
  );
}
