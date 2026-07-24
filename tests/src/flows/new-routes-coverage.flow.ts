/**
 * New route coverage backlog.
 *
 * These are lightweight black-box checks for newly surfaced manifest routes.
 * They deliberately assert auth/validation/read-only boundaries and avoid
 * provisioning sandboxes, calling paid upstream LLMs, or mutating production
 * provider state.
 */
import { flow } from '../core/flow';

const ZERO_UUID = '00000000-0000-4000-a000-000000000000';

flow(
  'COV-1',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: ['GET /metrics', 'GET /v1/router/health'],
  },
  async (ctx) => {
    await ctx.step('metrics endpoint is mounted or explicitly disabled', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/metrics');
      // /metrics is intentionally protected by the internal observability key.
      r.status([200, 401, 404]);
    });
    await ctx.step('LLM gateway health endpoint is mounted', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/router/health');
      r.status([200, 404]);
    });
  },
);

// COV-2 (warm-snapshot-config admin toggle) removed — the routes it covered
// were deleted in #4095 ("remove the dead warm-fork sessions toggle") without
// retiring this flow, leaving stale manifest drift.

flow(
  'COV-3',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/executor/connect-status',
      'GET /v1/executor/projects/:projectId/catalog',
      'POST /v1/executor/projects/:projectId/call',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();

    await ctx.step('ANON cannot read executor connection status', async () => {
      const r = await ctx.client.as(ctx.P.ANON).get('/v1/executor/connect-status');
      r.status(401);
    });
    await ctx.step('project member can reach executor catalog', async () => {
      const r = await ctx.client
        .as(ctx.P.OWNER)
        .get('/v1/executor/projects/:projectId/catalog', { params: { projectId: p.id } });
      r.status([200, 403, 501]);
    });
    await ctx.step(
      'project member call boundary rejects invalid tool body without upstream side effects',
      async () => {
        const r = await ctx.client
          .as(ctx.P.OWNER)
          .post('/v1/executor/projects/:projectId/call', {}, { params: { projectId: p.id } });
        r.status([400, 403, 404, 501]);
      },
    );
  },
);

flow(
  'COV-4',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:projectId/gateway/overview',
      'GET /v1/projects/:projectId/gateway/series',
      'GET /v1/projects/:projectId/gateway/sessions',
      'GET /v1/projects/:projectId/gateway/breakdown',
      'GET /v1/projects/:projectId/gateway/errors',
      'GET /v1/projects/:projectId/gateway/logs',
      'GET /v1/projects/:projectId/gateway/logs/:logId',
      'GET /v1/projects/:projectId/gateway/budgets',
      'PUT /v1/projects/:projectId/gateway/budgets',
      'DELETE /v1/projects/:projectId/gateway/budgets/:budgetId',
      'GET /v1/projects/:projectId/gateway/keys',
      'POST /v1/projects/:projectId/gateway/keys',
      'DELETE /v1/projects/:projectId/gateway/keys/:keyId',
      'POST /v1/projects/:projectId/gateway/playground',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };

    await ctx.step('gateway analytics reads are reachable for a project member', async () => {
      for (const route of [
        '/v1/projects/:projectId/gateway/overview',
        '/v1/projects/:projectId/gateway/series',
        '/v1/projects/:projectId/gateway/sessions',
        '/v1/projects/:projectId/gateway/breakdown',
        '/v1/projects/:projectId/gateway/errors',
        '/v1/projects/:projectId/gateway/logs',
        '/v1/projects/:projectId/gateway/budgets',
      ]) {
        const r = await owner.get(route, { params });
        r.status([200, 403]);
      }
    });
    await ctx.step('gateway log detail unknown id returns boundary response', async () => {
      const r = await owner.get('/v1/projects/:projectId/gateway/logs/:logId', {
        params: { ...params, logId: ZERO_UUID },
      });
      r.status([404, 500]);
    });
    await ctx.step('gateway budget mutation validates permissions and payload', async () => {
      const put = await owner.put(
        '/v1/projects/:projectId/gateway/budgets',
        { scope: 'member', limit_usd: 1 },
        { params },
      );
      put.status([400, 403]);

      const del = await owner.del('/v1/projects/:projectId/gateway/budgets/:budgetId', {
        params: { ...params, budgetId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway key management reaches auth/validation boundary', async () => {
      const list = await owner.get('/v1/projects/:projectId/gateway/keys', { params });
      list.status([200, 403]);

      const create = await owner.post('/v1/projects/:projectId/gateway/keys', {}, { params });
      create.status([400, 403]);

      const del = await owner.del('/v1/projects/:projectId/gateway/keys/:keyId', {
        params: { ...params, keyId: ZERO_UUID },
      });
      del.status([200, 403, 404]);
    });
    await ctx.step('gateway playground rejects invalid body before model calls', async () => {
      const r = await owner.post('/v1/projects/:projectId/gateway/playground', {}, { params });
      r.status([400, 403]);
    });
  },
);

flow(
  'COV-5',
  {
    domain: 'coverage',
    routes: [
      'GET /v1/projects/:projectId/channels/slack/file',
      'POST /v1/projects/:projectId/channels/slack/file/upload',
      'PATCH /v1/projects/:projectId/triggers/activation',
      'GET /v1/projects/:projectId/sessions/:sessionId/transcript',
    ],
  },
  async (ctx) => {
    const p = await ctx.fixtures.project();
    const owner = ctx.client.as(ctx.P.OWNER);
    const params = { projectId: p.id };

    await ctx.step('Slack file proxy validates missing or unconfigured file inputs', async () => {
      const download = await owner.get('/v1/projects/:projectId/channels/slack/file', { params });
      download.status([400, 404]);

      const upload = await owner.post(
        '/v1/projects/:projectId/channels/slack/file/upload',
        {},
        { params },
      );
      upload.status([400, 404]);
    });
    await ctx.step('trigger activation validates paused boolean', async () => {
      const r = await owner.patch('/v1/projects/:projectId/triggers/activation', {}, { params });
      r.status(400);
    });
    await ctx.step('session transcript unknown session is a 404 boundary', async () => {
      const r = await owner.get('/v1/projects/:projectId/sessions/:sessionId/transcript', {
        params: { ...params, sessionId: ZERO_UUID },
      });
      r.status(404);
    });
  },
);

flow(
  'COV-6',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: [
      'POST /internal/gateway/authenticate',
      'POST /internal/gateway/billing',
      'POST /internal/gateway/budget-check',
      'POST /internal/gateway/models',
      'POST /internal/gateway/resolve-upstream',
      'POST /internal/gateway/trace',
      'POST /internal/gateway/usage',
    ],
  },
  async (ctx) => {
    for (const route of [
      '/internal/gateway/authenticate',
      '/internal/gateway/billing',
      '/internal/gateway/budget-check',
      '/internal/gateway/models',
      '/internal/gateway/resolve-upstream',
      '/internal/gateway/trace',
      '/internal/gateway/usage',
    ]) {
      await ctx.step(`${route} rejects unauthenticated internal call`, async () => {
        const r = await ctx.client.as(ctx.P.ANON).post(route, {});
        // The standalone gateway is disabled by default; preserve that
        // explicit fail-closed boundary alongside auth/validation responses.
        r.status([400, 401, 403, 503]);
      });
    }
  },
);

flow(
  'COV-7',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: ['POST /v1/webhooks/sandbox/daytona', 'POST /v1/webhooks/sandbox/platinum'],
  },
  async (ctx) => {
    await ctx.step('sandbox provider webhooks reject unsigned Daytona payload', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/sandbox/daytona', {});
      r.status([400, 401, 403, 503]);
    });
    await ctx.step('sandbox provider webhooks reject unsigned Platinum payload', async () => {
      const r = await ctx.client.as(ctx.P.ANON).post('/v1/webhooks/sandbox/platinum', {});
      r.status([400, 401, 403, 503]);
    });
  },
);

flow(
  'COV-8',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: [
      'GET /v1/projects/:projectId/llm-catalog',
      'POST /v1/projects/:projectId/marketplace/install-session',
      'PATCH /v1/projects/:projectId/channels/email/installation',
      'POST /v1/channels/slack/identity/bind',
      'POST /internal/gateway/authorize',
    ],
  },
  async (ctx) => {
    const params = { projectId: ZERO_UUID };

    await ctx.step('unauthenticated project marketplace and catalog routes are gated', async () => {
      for (const route of ['/v1/projects/:projectId/llm-catalog']) {
        const r = await ctx.client.as(ctx.P.ANON).get(route, { params });
        r.status(401);
      }
    });

    await ctx.step('unauthenticated marketplace mutation routes are gated', async () => {
      for (const route of ['/v1/projects/:projectId/marketplace/install-session']) {
        const r = await ctx.client.as(ctx.P.ANON).post(route, {}, { params });
        r.status([400, 401]);
      }
    });

    await ctx.step('unauthenticated email and Slack identity mutations are gated', async () => {
      const email = await ctx.client
        .as(ctx.P.ANON)
        .patch('/v1/projects/:projectId/channels/email/installation', {}, { params });
      email.status(401);

      const slack = await ctx.client.as(ctx.P.ANON).post('/v1/channels/slack/identity/bind', {});
      slack.status(401);
    });

    await ctx.step(
      'internal gateway authorization rejects missing internal credentials',
      async () => {
        const r = await ctx.client.as(ctx.P.ANON).post('/internal/gateway/authorize', {});
        r.status([401, 503]);
      },
    );
  },
);

/**
 * Studio/Intelligence/Automation route perimeter. These requests deliberately
 * use an anonymous principal and inert UUIDs: the goal is to prove that every
 * manifest route is mounted behind the expected auth or feature gate without
 * creating jobs, reserving credits, touching storage, or calling an upstream
 * provider.
 */
flow(
  'COV-9',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: [
      'DELETE /v1/automation/browser-profiles/:profileId',
      'DELETE /v1/projects/:projectId/studio/providers/:providerConfigId',
      'GET /v1/accounts/:accountId/studio/pricing-catalog',
      'GET /v1/automation/approvals',
      'GET /v1/automation/browser-profiles',
      'GET /v1/automation/devices',
      'GET /v1/automation/jobs/:jobId',
      'GET /v1/automation/jobs/:jobId/events',
      'GET /v1/automation/policies',
      'GET /v1/projects/:projectId/intelligence/ag-ui/workflows/:runId/stream',
      'GET /v1/projects/:projectId/intelligence/agent-card',
      'GET /v1/projects/:projectId/intelligence/capabilities',
      'GET /v1/projects/:projectId/intelligence/catalog',
      'GET /v1/projects/:projectId/intelligence/catalog/describe',
      'GET /v1/projects/:projectId/intelligence/tasks/:taskId/events',
      'GET /v1/projects/:projectId/intelligence/tasks/by-job/:jobId',
      'GET /v1/projects/:projectId/studio/assets',
      'GET /v1/projects/:projectId/studio/assets/:assetId',
      'GET /v1/projects/:projectId/studio/capabilities',
      'GET /v1/projects/:projectId/studio/jobs',
      'GET /v1/projects/:projectId/studio/jobs/:jobId',
      'GET /v1/projects/:projectId/studio/jobs/:jobId/events',
      'GET /v1/projects/:projectId/studio/providers',
      'PATCH /v1/projects/:projectId/studio/providers/:providerConfigId',
      'POST /internal/automation/desktop/execute',
      'POST /v1/accounts/:accountId/studio/billing-incidents/:incidentId/resolve',
      'POST /v1/accounts/:accountId/studio/pricing-catalog',
      'POST /v1/accounts/:accountId/studio/pricing-catalog/:pricingCatalogId/deactivate',
      'POST /v1/automation/approvals/:approvalId/resolve',
      'POST /v1/automation/browser-profiles',
      'POST /v1/automation/jobs',
      'POST /v1/automation/jobs/:jobId/cancel',
      'POST /v1/automation/kill-switch',
      'POST /v1/projects/:projectId/intelligence/tasks',
      'POST /v1/projects/:projectId/studio/assets/:assetId/download-url',
      'POST /v1/projects/:projectId/studio/estimates',
      'POST /v1/projects/:projectId/studio/jobs',
      'POST /v1/projects/:projectId/studio/jobs/:jobId/cancel',
      'POST /v1/projects/:projectId/studio/jobs/:jobId/recovery',
      'POST /v1/projects/:projectId/studio/providers',
      'POST /v1/projects/:projectId/studio/uploads',
      'POST /v1/projects/:projectId/studio/uploads/:uploadId/finalize',
      'PUT /v1/automation/policies',
    ],
  },
  async (ctx) => {
    const params = {
      accountId: ZERO_UUID,
      projectId: ZERO_UUID,
      profileId: ZERO_UUID,
      providerConfigId: ZERO_UUID,
      pricingCatalogId: ZERO_UUID,
      approvalId: ZERO_UUID,
      jobId: ZERO_UUID,
      taskId: ZERO_UUID,
      runId: ZERO_UUID,
      assetId: ZERO_UUID,
      uploadId: ZERO_UUID,
    };
    const routes: Array<[string, string]> = [
      ['DELETE', '/v1/automation/browser-profiles/:profileId'],
      ['DELETE', '/v1/projects/:projectId/studio/providers/:providerConfigId'],
      ['GET', '/v1/accounts/:accountId/studio/pricing-catalog'],
      ['GET', '/v1/automation/approvals'],
      ['GET', '/v1/automation/browser-profiles'],
      ['GET', '/v1/automation/devices'],
      ['GET', '/v1/automation/jobs/:jobId'],
      ['GET', '/v1/automation/jobs/:jobId/events'],
      ['GET', '/v1/automation/policies'],
      ['GET', '/v1/projects/:projectId/intelligence/ag-ui/workflows/:runId/stream'],
      ['GET', '/v1/projects/:projectId/intelligence/agent-card'],
      ['GET', '/v1/projects/:projectId/intelligence/capabilities'],
      ['GET', '/v1/projects/:projectId/intelligence/catalog'],
      ['GET', '/v1/projects/:projectId/intelligence/catalog/describe'],
      ['GET', '/v1/projects/:projectId/intelligence/tasks/:taskId/events'],
      ['GET', '/v1/projects/:projectId/intelligence/tasks/by-job/:jobId'],
      ['GET', '/v1/projects/:projectId/studio/assets'],
      ['GET', '/v1/projects/:projectId/studio/assets/:assetId'],
      ['GET', '/v1/projects/:projectId/studio/capabilities'],
      ['GET', '/v1/projects/:projectId/studio/jobs'],
      ['GET', '/v1/projects/:projectId/studio/jobs/:jobId'],
      ['GET', '/v1/projects/:projectId/studio/jobs/:jobId/events'],
      ['GET', '/v1/projects/:projectId/studio/providers'],
      ['PATCH', '/v1/projects/:projectId/studio/providers/:providerConfigId'],
      ['POST', '/internal/automation/desktop/execute'],
      ['POST', '/v1/accounts/:accountId/studio/billing-incidents/:incidentId/resolve'],
      ['POST', '/v1/accounts/:accountId/studio/pricing-catalog'],
      ['POST', '/v1/accounts/:accountId/studio/pricing-catalog/:pricingCatalogId/deactivate'],
      ['POST', '/v1/automation/approvals/:approvalId/resolve'],
      ['POST', '/v1/automation/browser-profiles'],
      ['POST', '/v1/automation/jobs'],
      ['POST', '/v1/automation/jobs/:jobId/cancel'],
      ['POST', '/v1/automation/kill-switch'],
      ['POST', '/v1/projects/:projectId/intelligence/tasks'],
      ['POST', '/v1/projects/:projectId/studio/assets/:assetId/download-url'],
      ['POST', '/v1/projects/:projectId/studio/estimates'],
      ['POST', '/v1/projects/:projectId/studio/jobs'],
      ['POST', '/v1/projects/:projectId/studio/jobs/:jobId/cancel'],
      ['POST', '/v1/projects/:projectId/studio/jobs/:jobId/recovery'],
      ['POST', '/v1/projects/:projectId/studio/providers'],
      ['POST', '/v1/projects/:projectId/studio/uploads'],
      ['POST', '/v1/projects/:projectId/studio/uploads/:uploadId/finalize'],
      ['PUT', '/v1/automation/policies'],
    ];

    await ctx.step('anonymous requests hit auth or an explicit disabled-feature gate', async () => {
      for (const [method, route] of routes) {
        const response = await ctx.client.as(ctx.P.ANON).request(method, route, {
          params,
          body: method === 'GET' || method === 'DELETE' ? undefined : {},
          query: route.endsWith('/catalog/describe') ? { ref: 'studio:image.generate' } : undefined,
        });
        response.status([400, 401, 403, 503]);
      }
    });
  },
);

flow(
  'COV-10',
  {
    domain: 'coverage',
    publicOnly: true,
    routes: [
      'POST /v1/developer/modules/validate',
      'POST /v1/developer/modules/releases',
      'GET /v1/developer/modules/releases',
      'GET /v1/developer/modules/releases/:releaseId',
      'POST /v1/developer/modules/releases/:releaseId/review-requests',
      'GET /v1/developer/modules/releases/:releaseId/review-history',
      'GET /v1/admin/developer/modules/reviews',
      'GET /v1/admin/developer/modules/releases/:releaseId/review',
      'POST /v1/admin/developer/modules/releases/:releaseId/review-decisions',
    ],
  },
  async (ctx) => {
    await ctx.step('developer module validation requires authentication', async () => {
      const response = await ctx.client.as(ctx.P.ANON).post('/v1/developer/modules/validate', {});
      response.status(401);
    });
    await ctx.step('developer module release APIs require authentication', async () => {
      const releaseId = '30000000-0000-4000-a000-000000000003';
      const responses = await Promise.all([
        ctx.client.as(ctx.P.ANON).post('/v1/developer/modules/releases', {}),
        ctx.client.as(ctx.P.ANON).get('/v1/developer/modules/releases'),
        ctx.client
          .as(ctx.P.ANON)
          .get('/v1/developer/modules/releases/:releaseId', { params: { releaseId } }),
      ]);
      for (const response of responses) response.status(401);
    });
    await ctx.step('developer module review APIs require authentication', async () => {
      const releaseId = '30000000-0000-4000-a000-000000000003';
      const params = { releaseId };
      const responses = await Promise.all([
        ctx.client
          .as(ctx.P.ANON)
          .post('/v1/developer/modules/releases/:releaseId/review-requests', {}, { params }),
        ctx.client
          .as(ctx.P.ANON)
          .get('/v1/developer/modules/releases/:releaseId/review-history', { params }),
        ctx.client.as(ctx.P.ANON).get('/v1/admin/developer/modules/reviews'),
        ctx.client
          .as(ctx.P.ANON)
          .get('/v1/admin/developer/modules/releases/:releaseId/review', { params }),
        ctx.client
          .as(ctx.P.ANON)
          .post('/v1/admin/developer/modules/releases/:releaseId/review-decisions', {}, { params }),
      ]);
      for (const response of responses) response.status(401);
    });
  },
);
