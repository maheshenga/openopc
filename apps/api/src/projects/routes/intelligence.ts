import { config } from '../../config';
import { assertAuthorized } from '../../iam/dispatcher';
import { createIntelligenceWorkflowProjectRoutes } from '../../intelligence/workflows/project-routes';
import {
  createPostgresWorkflowApprovalLookup,
  createWorkflowReviewAdapter,
  setDefaultWorkflowReviewAdapter,
} from '../../intelligence/workflows/review-adapter';
import {
  type IntelligenceWorkflowRuntime,
  buildIntelligenceWorkflowRuntime,
  setDefaultIntelligenceWorkflowRuntime,
} from '../../intelligence/workflows/runtime';
import {
  createDefaultIntelligenceProjectRoutes,
  getDefaultStudioApiRuntime,
} from '../../studio/default-routes';
import { assertProjectCapability, loadProjectForUser } from '../lib/access';
import { projectsApp } from '../lib/app';
import { createWorkflowReviewProjectionStore } from '../workflow-review-projection';

projectsApp.route('/', createDefaultIntelligenceProjectRoutes());

let workflowRuntime: IntelligenceWorkflowRuntime = { enabled: false };
setDefaultWorkflowReviewAdapter(null);
if (!config.INTELLIGENCE_WORKFLOWS_ENABLED) {
  // Keep the additive stream path stable without initializing the workflow runtime.
  projectsApp.get('/:projectId/intelligence/ag-ui/workflows/:runId/stream', (c) =>
    c.json(
      { error: 'Intelligence AG-UI stream is disabled', code: 'INTELLIGENCE_AG_UI_DISABLED' },
      404,
    ),
  );
}
if (config.INTELLIGENCE_WORKFLOWS_ENABLED) {
  const [databaseModule, payloadModule, payloadRepositoryModule, storeModule, serviceModule] =
    await Promise.all([
      import('../../shared/db'),
      import('../../intelligence/workflows/payload-store'),
      import('../../intelligence/workflows/payload-repository'),
      import('../../intelligence/workflows/postgres-store'),
      import('../../intelligence/workflows/service'),
    ]);
  workflowRuntime = buildIntelligenceWorkflowRuntime({
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
        payloadRepository: payloadRepositoryModule.createPostgresWorkflowPayloadRepository(
          databaseModule.db,
        ),
      });
    },
  });

  if (!workflowRuntime.enabled) {
    throw new Error('Intelligence workflow runtime failed to enable');
  }

  setDefaultWorkflowReviewAdapter(
    createWorkflowReviewAdapter({
      workflow: workflowRuntime.service,
      projection: createWorkflowReviewProjectionStore(databaseModule.db),
      loadApproval: createPostgresWorkflowApprovalLookup(databaseModule.db),
      authorize: ({ action, accountId, projectId, actorUserId, actingTokenId }) =>
        assertAuthorized(
          actorUserId,
          accountId,
          action,
          { type: 'project', id: projectId },
          actingTokenId ?? undefined,
        ),
    }),
  );

  projectsApp.route(
    '/',
    createIntelligenceWorkflowProjectRoutes({
      service: workflowRuntime.service,
      loadProjectForUser,
      assertProjectCapability,
      agUi: { enabled: config.INTELLIGENCE_AG_UI_ENABLED },
      // Task 8 binds installed project Agent/card sources. Until then graph
      // commands fail closed while user start/read/cancel routes remain usable.
      isAgentCardTrusted: async () => false,
    }),
  );
}

setDefaultIntelligenceWorkflowRuntime(workflowRuntime);
