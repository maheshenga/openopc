import {
  StudioCreateJobRequestSchema,
  StudioEstimateRequestSchema,
  studioPhase1Capabilities,
} from '@kortix/api-contract';
import type { StudioEstimateResponse, StudioJob } from '@kortix/api-contract';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { PROJECT_ACTIONS } from '../iam/actions';
import { createMemoryStudioRepository } from './repositories/memory';
import type { StudioLoadedProject, StudioRepository } from './types';

export { createMemoryStudioRepository } from './repositories/memory';
export type { StudioRepository } from './types';

type LoadProjectForUser = (
  c: any,
  projectId: string,
  action: 'read' | 'write' | 'session' | 'manage',
) => Promise<StudioLoadedProject | null>;

type AssertProjectCapability = (
  c: any,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
) => Promise<void>;

export type StudioProjectRouteDeps = {
  repository?: StudioRepository;
  loadProjectForUser?: LoadProjectForUser;
  assertProjectCapability?: AssertProjectCapability;
};

const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 100;
const StudioCreateUploadRequestSchema = z.object({
  declared_mime_type: z.string().min(1),
  expected_size_bytes: z.number().int().positive(),
  expected_checksum_sha256: z.string().min(32),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

function limitFromQuery(raw: string | undefined): number {
  return Math.min(Math.max(Number(raw) || DEFAULT_JOB_LIMIT, 1), MAX_JOB_LIMIT);
}

function badRequest(c: any, error: unknown) {
  return c.json({
    error: 'Invalid Studio request',
    code: 'STUDIO_VALIDATION_ERROR',
    details: error,
  }, 400);
}

function idempotencyMismatch(c: any) {
  return c.json({
    error: 'A Studio job already exists for this idempotency key with a different request hash',
    code: 'STUDIO_IDEMPOTENCY_MISMATCH',
  }, 409);
}

async function loadProjectOr404(
  c: any,
  deps: Required<StudioProjectRouteDeps>,
  projectId: string,
): Promise<StudioLoadedProject | Response> {
  const loaded = await deps.loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  return loaded;
}

function estimateFor(input: unknown): Pick<StudioEstimateResponse, 'provider_cost_credits' | 'platform_cost_credits' | 'max_approved_credits' | 'line_items'> {
  const parsed = StudioEstimateRequestSchema.parse(input);
  const outputCount = parsed.input.capability === 'image.generate' ? parsed.input.image.output_count : 1;
  const qualityMultiplier = parsed.input.capability === 'image.generate' && parsed.input.image.quality === 'high' ? 2 : 1;
  const providerCost = outputCount * qualityMultiplier;
  return {
    provider_cost_credits: providerCost,
    platform_cost_credits: 0,
    max_approved_credits: providerCost,
    line_items: [{ label: 'Fake image generation', credits: providerCost }],
  };
}

function createEstimateResponse(input: unknown): StudioEstimateResponse {
  const costs = estimateFor(input);
  return {
    estimate_id: crypto.randomUUID(),
    estimate_token: `studio-estimate-${crypto.randomUUID()}`,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    currency: 'credits',
    input_hash: canonicalStudioRequestHash(input),
    ...costs,
  };
}

function cancellable(job: StudioJob): boolean {
  return job.status === 'queued';
}

export function createStudioProjectRoutes(inputDeps: StudioProjectRouteDeps = {}) {
  if (!inputDeps.repository || !inputDeps.loadProjectForUser || !inputDeps.assertProjectCapability) {
    throw new Error('createStudioProjectRoutes requires explicit Studio route dependencies');
  }
  const deps: Required<StudioProjectRouteDeps> = {
    repository: inputDeps.repository,
    loadProjectForUser: inputDeps.loadProjectForUser,
    assertProjectCapability: inputDeps.assertProjectCapability,
  };
  const app = new Hono();

  app.get('/:projectId/studio/capabilities', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
    );
    return c.json({ items: studioPhase1Capabilities, next_cursor: null });
  });

  app.get('/:projectId/studio/providers', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
    );
    const providers = await deps.repository.listProviders(projectId);
    return c.json({ items: providers.map(({ account_id: _accountId, ...provider }) => provider), next_cursor: null });
  });

  app.post('/:projectId/studio/estimates', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_USE,
    );
    const body = await c.req.json();
    const parsed = StudioEstimateRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const provider = await deps.repository.getProvider(projectId, parsed.data.provider_config_id);
    if (!provider || !provider.capabilities.includes(parsed.data.capability)) {
      return c.json({ error: 'Studio provider unavailable', code: 'STUDIO_PROVIDER_UNAVAILABLE' }, 404);
    }
    const estimate = createEstimateResponse(parsed.data);
    await deps.repository.saveEstimate(parsed.data, estimate);
    return c.json(estimate);
  });

  app.post('/:projectId/studio/jobs', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_RUN,
    );
    const body = await c.req.json();
    const parsed = StudioCreateJobRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const expectedHash = canonicalStudioRequestHash({
      capability: parsed.data.capability,
      provider_config_id: parsed.data.provider_config_id,
      model: parsed.data.model,
      input: parsed.data.input,
    });
    if (parsed.data.request_hash !== expectedHash) return idempotencyMismatch(c);

    const provider = await deps.repository.getProvider(projectId, parsed.data.provider_config_id);
    if (!provider || !provider.capabilities.includes(parsed.data.capability)) {
      return c.json({ error: 'Studio provider unavailable', code: 'STUDIO_PROVIDER_UNAVAILABLE' }, 404);
    }
    const estimate = await deps.repository.getEstimate(parsed.data.estimate_id);
    if (!estimate || estimate.estimate_token !== parsed.data.estimate_token) {
      return c.json({ error: 'Studio estimate expired', code: 'STUDIO_ESTIMATE_EXPIRED' }, 409);
    }
    const result = await deps.repository.createJob(
      {
        ...parsed.data,
        account_id: loaded.row.accountId,
        project_id: projectId,
        actor_user_id: loaded.userId,
        actor_type: 'user',
      },
      provider,
      estimate,
    );
    if (result.mismatch) return idempotencyMismatch(c);
    return c.json(result.job, result.created ? 201 : 200);
  });

  app.get('/:projectId/studio/jobs', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ,
    );
    return c.json(await deps.repository.listJobs(projectId, limitFromQuery(c.req.query('limit')), c.req.query('cursor')));
  });

  app.get('/:projectId/studio/jobs/:jobId', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ,
    );
    const job = await deps.repository.getJob(projectId, c.req.param('jobId'));
    if (!job) return c.json({ error: 'Not found' }, 404);
    return c.json({ ...job, cancellable: cancellable(job) });
  });

  app.post('/:projectId/studio/jobs/:jobId/cancel', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_CANCEL,
    );
    const job = await deps.repository.cancelQueuedJob(projectId, c.req.param('jobId'));
    if (!job) throw new HTTPException(409, { message: 'STUDIO_JOB_NOT_CANCELLABLE' });
    return c.json(job);
  });

  app.get('/:projectId/studio/jobs/:jobId/events', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_JOBS_READ,
    );
    const job = await deps.repository.getJob(projectId, c.req.param('jobId'));
    if (!job) return c.json({ error: 'Not found' }, 404);
    return c.json(await deps.repository.listEvents(projectId, job.job_id, c.req.query('cursor')));
  });

  app.post('/:projectId/studio/uploads', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_WRITE,
    );
    const parsed = StudioCreateUploadRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const upload = await deps.repository.createUpload({
      account_id: loaded.row.accountId,
      project_id: projectId,
      actor_user_id: loaded.userId,
      declared_mime_type: parsed.data.declared_mime_type,
      expected_size_bytes: parsed.data.expected_size_bytes,
      expected_checksum_sha256: parsed.data.expected_checksum_sha256,
      metadata: parsed.data.metadata ?? {},
    });
    return c.json(upload, 201);
  });

  app.post('/:projectId/studio/uploads/:uploadId/finalize', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_WRITE,
    );
    const asset = await deps.repository.finalizeUpload(projectId, c.req.param('uploadId'));
    if (!asset) return c.json({ error: 'Not found' }, 404);
    return c.json(asset);
  });

  app.get('/:projectId/studio/assets', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_READ,
    );
    return c.json(await deps.repository.listAssets(projectId, limitFromQuery(c.req.query('limit')), c.req.query('cursor')));
  });

  app.get('/:projectId/studio/assets/:assetId', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_READ,
    );
    const asset = await deps.repository.getAsset(projectId, c.req.param('assetId'));
    if (!asset) return c.json({ error: 'Not found' }, 404);
    return c.json(asset);
  });

  app.post('/:projectId/studio/assets/:assetId/download-url', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_ASSETS_READ,
    );
    const asset = await deps.repository.getAsset(projectId, c.req.param('assetId'));
    if (!asset) return c.json({ error: 'Not found' }, 404);
    return c.json({
      asset_id: asset.asset_id,
      signed_download_url: `https://studio.local/download/${asset.asset_id}`,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
  });

  return app;
}
