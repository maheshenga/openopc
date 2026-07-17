import {
  StudioCreateJobRequestSchema,
  StudioCreateProviderConfigRequestSchema,
  StudioCredentialBindingSchema,
  StudioEstimateRequestSchema,
  StudioRecoveryRequestSchema,
  StudioUpdateProviderConfigRequestSchema,
  studioPhase1Capabilities,
} from '@kortix/api-contract';
import type {
  StudioCredentialBinding,
  StudioEstimateResponse,
  StudioJob,
  StudioRecoveryRequest,
  StudioRecoveryResponse,
} from '@kortix/api-contract';
import { StudioStorageUnavailableError } from '@kortix/studio-runtime';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from '../iam/actions';
import type { AppEnv } from '../types';
import {
  type UnsignedStudioEstimate,
  issueStudioEstimateToken,
  verifyStudioEstimateToken,
} from './estimate-token';
import {
  type StudioEstimateResolution,
  type StudioEstimateResolutionError,
  resolveStudioEstimate,
} from './estimates';
import { StudioRecoveryServiceError } from './recovery';
import type { StudioProviderConfigService } from './providers';
import { createMemoryStudioRepository } from './repositories/memory';
import { type StudioStorageService, StudioStorageServiceError } from './storage';
import { isStudioRepositoryError } from './types';
import type { StudioLoadedProject, StudioRepository } from './types';
import type { StudioTelemetry } from './metrics';

export { createMemoryStudioRepository } from './repositories/memory';
export type { StudioRepository } from './types';

type LoadProjectForUser = (
  c: Context<AppEnv>,
  projectId: string,
  action: 'read' | 'write' | 'session' | 'manage',
) => Promise<StudioLoadedProject | null>;

type AssertProjectCapability = (
  c: Context<AppEnv>,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
) => Promise<void>;

type AssertAccountCapability = (
  c: Context<AppEnv>,
  userId: string,
  accountId: string,
  action: string,
) => Promise<void>;

export interface StudioRecoveryExecutor {
  recover(input: {
    accountId: string;
    projectId: string;
    jobId: string;
    actorUserId: string;
    actorType: 'user' | 'agent' | 'system';
    actingTokenId: string | null;
    request: StudioRecoveryRequest;
  }): Promise<StudioRecoveryResponse>;
}

export type StudioCredentialBindingExists = (input: {
  accountId: string;
  projectId: string;
  binding: StudioCredentialBinding;
}) => Promise<boolean>;

export type StudioProjectRouteDeps = {
  repository?: StudioRepository;
  loadProjectForUser?: LoadProjectForUser;
  assertProjectCapability?: AssertProjectCapability;
  assertAccountCapability?: AssertAccountCapability;
  providerConfigService?: StudioProviderConfigService;
  storageService?: StudioStorageService;
  recoveryService?: StudioRecoveryExecutor;
  credentialBindingExists?: StudioCredentialBindingExists;
  estimateSigningSecret?: string;
  telemetry?: StudioTelemetry;
};

const DEFAULT_JOB_LIMIT = 50;
const MAX_JOB_LIMIT = 100;
const StudioCreateUploadRequestSchema = z
  .object({
    declared_mime_type: z.string().min(1),
    expected_size_bytes: z.number().int().positive(),
    expected_checksum_sha256: z.string().min(32),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function limitFromQuery(raw: string | undefined): number {
  return Math.min(Math.max(Number(raw) || DEFAULT_JOB_LIMIT, 1), MAX_JOB_LIMIT);
}

function badRequest(c: Context<AppEnv>, error: unknown) {
  return c.json(
    {
      error: 'Invalid Studio request',
      code: 'STUDIO_VALIDATION_ERROR',
      details: error,
    },
    400,
  );
}

function storageErrorResponse(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof StudioStorageUnavailableError) {
    return c.json({ error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' }, 503);
  }
  if (error instanceof StudioStorageServiceError) {
    const status =
      error.code === 'STUDIO_UPLOAD_EXPIRED'
        ? 410
        : error.code === 'STUDIO_ASSET_TOO_LARGE'
          ? 413
          : 400;
    return c.json({ error: 'Invalid Studio asset', code: error.code }, status);
  }
  throw error;
}

function recoveryErrorResponse(c: Context<AppEnv>, error: unknown): Response {
  if (!(error instanceof StudioRecoveryServiceError)) {
    return c.json({ error: 'Studio recovery failed', code: 'STUDIO_INTERNAL_ERROR' }, 500);
  }
  if (error.status === 404) return c.json({ error: 'Not found' }, 404);
  if (error.status === 500) {
    return c.json({ error: 'Studio recovery failed', code: 'STUDIO_INTERNAL_ERROR' }, 500);
  }
  const messages: Partial<Record<typeof error.code, string>> = {
    STUDIO_ASSET_INVALID: 'Invalid Studio recovery evidence',
    STUDIO_STORAGE_UNAVAILABLE: 'Studio storage unavailable',
    STUDIO_RECOVERY_CONFLICT: 'Studio recovery idempotency conflict',
    STUDIO_JOB_CONFLICT: 'Studio job is not recoverable',
    STUDIO_BILLING_INCIDENT_REQUIRED: 'Studio recovery requires billing incident review',
  };
  return c.json(
    {
      error: messages[error.code] ?? 'Studio recovery failed',
      code: error.code,
    },
    error.status,
  );
}

function idempotencyMismatch(c: Context<AppEnv>) {
  return c.json(
    {
      error: 'A Studio job already exists for this idempotency key with a different request hash',
      code: 'STUDIO_IDEMPOTENCY_MISMATCH',
    },
    409,
  );
}

async function loadProjectOr404(
  c: Context<AppEnv>,
  deps: { loadProjectForUser: LoadProjectForUser },
  projectId: string,
): Promise<StudioLoadedProject | Response> {
  const loaded = await deps.loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  return loaded;
}

function createEstimateResponse(input: {
  request: unknown;
  loaded: StudioLoadedProject;
  secret: string;
  resolution: StudioEstimateResolution;
}): StudioEstimateResponse {
  const { request, loaded, secret, resolution } = input;
  const unsigned: UnsignedStudioEstimate = {
    estimate_id: crypto.randomUUID(),
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    currency: 'credits',
    input_hash: canonicalStudioRequestHash(request),
    ...resolution.costs,
  };
  return {
    ...unsigned,
    estimate_token: issueStudioEstimateToken({
      secret,
      accountId: loaded.row.accountId,
      projectId: loaded.row.projectId,
      actorUserId: loaded.userId,
      estimate: unsigned,
      versionBinding: resolution.versionBinding,
    }),
  };
}

function estimateResolutionError(c: Context<AppEnv>, resolution: StudioEstimateResolutionError) {
  return c.json({ error: resolution.message, code: resolution.code }, resolution.status);
}

function cancellable(job: StudioJob): boolean {
  return job.status === 'queued' || job.status === 'running';
}

function studioActorContext(
  c: Context<AppEnv>,
): Pick<
  import('./types').StudioCreateJobInput,
  'actor_type' | 'acting_token_id' | 'agent_name' | 'session_id'
> {
  const authType = c.get('authType');
  if (authType === 'service_account') {
    return {
      actor_type: 'system',
      acting_token_id: null,
      agent_name: null,
      session_id: null,
    };
  }
  if (authType === 'pat') {
    const grant = c.get('agentGrant') as { agent?: string } | null | undefined;
    return {
      actor_type: grant ? 'agent' : 'user',
      acting_token_id: c.get('iamTokenId') ?? null,
      agent_name: grant?.agent ?? null,
      session_id: c.get('sessionId') ?? null,
    };
  }
  return {
    actor_type: 'user',
    acting_token_id: null,
    agent_name: null,
    session_id: null,
  };
}

export function createStudioProjectRoutes(inputDeps: StudioProjectRouteDeps = {}) {
  if (
    !inputDeps.repository ||
    !inputDeps.loadProjectForUser ||
    !inputDeps.assertProjectCapability ||
    !inputDeps.estimateSigningSecret
  ) {
    throw new Error('createStudioProjectRoutes requires explicit Studio route dependencies');
  }
  const deps = {
    repository: inputDeps.repository,
    loadProjectForUser: inputDeps.loadProjectForUser,
    assertProjectCapability: inputDeps.assertProjectCapability,
    assertAccountCapability: inputDeps.assertAccountCapability,
    providerConfigService: inputDeps.providerConfigService,
    storageService: inputDeps.storageService,
    recoveryService: inputDeps.recoveryService,
    credentialBindingExists: inputDeps.credentialBindingExists,
    estimateSigningSecret: inputDeps.estimateSigningSecret,
    telemetry: inputDeps.telemetry,
  };
  const app = new Hono<AppEnv>();

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
    if (!deps.storageService || !(await deps.storageService.isReady())) {
      return c.json({ items: [], next_cursor: null });
    }
    const providers = await deps.repository.listProviders(projectId);
    let hasExecutableProvider = false;
    for (const provider of providers) {
      const binding = StudioCredentialBindingSchema.safeParse(provider.credential_binding);
      if (
        !provider.enabled ||
        !provider.capabilities.includes('image.generate') ||
        !binding.success
      ) {
        continue;
      }
      if (provider.provider === 'fake' && binding.data.kind === 'none') {
        hasExecutableProvider = true;
        break;
      }
      if (
        provider.provider !== 'openai-compatible' ||
        binding.data.kind === 'none' ||
        !deps.credentialBindingExists
      ) {
        continue;
      }
      try {
        hasExecutableProvider = await deps.credentialBindingExists({
          accountId: loaded.row.accountId,
          projectId,
          binding: binding.data,
        });
      } catch {
        hasExecutableProvider = false;
      }
      if (hasExecutableProvider) break;
    }
    if (!hasExecutableProvider) return c.json({ items: [], next_cursor: null });
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
    return c.json({
      items: providers.map(({ account_id: _accountId, ...provider }) => provider),
      next_cursor: null,
    });
  });

  app.post('/:projectId/studio/providers', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
    );
    if (!deps.providerConfigService) {
      return c.json({ error: 'Studio provider management unavailable' }, 503);
    }
    const parsed = StudioCreateProviderConfigRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const result = await deps.providerConfigService.create({
      accountId: loaded.row.accountId,
      projectId,
      request: parsed.data,
    });
    if (!result.ok) {
      return result.code === 'not_found'
        ? c.json({ error: 'Not found' }, 404)
        : c.json(
            {
              error: 'Invalid Studio provider configuration',
              code:
                result.code === 'stale'
                  ? 'STUDIO_PROVIDER_CONFIG_STALE'
                  : 'STUDIO_PROVIDER_CONFIG_INVALID',
            },
            result.code === 'stale' ? 409 : 400,
          );
    }
    const { account_id: _accountId, ...provider } = result.value;
    return c.json(provider, 201);
  });

  app.patch('/:projectId/studio/providers/:providerConfigId', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
    );
    if (!deps.providerConfigService) {
      return c.json({ error: 'Studio provider management unavailable' }, 503);
    }
    const parsed = StudioUpdateProviderConfigRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const result = await deps.providerConfigService.update({
      accountId: loaded.row.accountId,
      projectId,
      providerConfigId: c.req.param('providerConfigId'),
      request: parsed.data,
    });
    if (!result.ok) {
      if (result.code === 'not_found') return c.json({ error: 'Not found' }, 404);
      return c.json(
        {
          error: 'Invalid Studio provider configuration',
          code:
            result.code === 'stale'
              ? 'STUDIO_PROVIDER_CONFIG_STALE'
              : 'STUDIO_PROVIDER_CONFIG_INVALID',
        },
        result.code === 'stale' ? 409 : 400,
      );
    }
    const { account_id: _accountId, ...provider } = result.value;
    return c.json(provider);
  });

  app.delete('/:projectId/studio/providers/:providerConfigId', async (c) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectOr404(c, deps, projectId);
    if (loaded instanceof Response) return loaded;
    await deps.assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_STUDIO_PROVIDERS_MANAGE,
    );
    if (!deps.providerConfigService) {
      return c.json({ error: 'Studio provider management unavailable' }, 503);
    }
    const result = await deps.providerConfigService.disable({
      accountId: loaded.row.accountId,
      projectId,
      providerConfigId: c.req.param('providerConfigId'),
    });
    if (!result.ok) return c.json({ error: 'Not found' }, 404);
    const { account_id: _accountId, ...provider } = result.value;
    return c.json(provider);
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
    if (!deps.storageService || !(await deps.storageService.isReady())) {
      return c.json(
        { error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' },
        503,
      );
    }
    const body = await c.req.json();
    const parsed = StudioEstimateRequestSchema.safeParse(body);
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const resolution = await resolveStudioEstimate({
      repository: deps.repository,
      accountId: loaded.row.accountId,
      projectId,
      request: parsed.data,
      credentialBindingExists: deps.credentialBindingExists,
    });
    if (!resolution.ok) return estimateResolutionError(c, resolution);
    const estimate = createEstimateResponse({
      request: parsed.data,
      loaded,
      secret: deps.estimateSigningSecret,
      resolution: resolution.value,
    });
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
    if (!deps.storageService || !(await deps.storageService.isReady())) {
      return c.json(
        { error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' },
        503,
      );
    }
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

    const replay = await deps.repository.findJobByIdempotency(
      loaded.row.accountId,
      parsed.data.idempotency_key,
    );
    if (replay) {
      if (replay.project_id !== projectId || replay.request_hash !== expectedHash) {
        return idempotencyMismatch(c);
      }
      return c.json(replay, 200);
    }

    const initialVerification = verifyStudioEstimateToken({
      token: parsed.data.estimate_token,
      secret: deps.estimateSigningSecret,
    });
    if (
      !initialVerification.valid ||
      initialVerification.claims.account_id !== loaded.row.accountId ||
      initialVerification.claims.project_id !== projectId ||
      initialVerification.claims.actor_user_id !== loaded.userId ||
      initialVerification.claims.estimate.estimate_id !== parsed.data.estimate_id ||
      initialVerification.claims.estimate.input_hash !== expectedHash
    ) {
      return c.json({ error: 'Studio estimate expired', code: 'STUDIO_ESTIMATE_EXPIRED' }, 409);
    }
    const expectedVersionBinding =
      initialVerification.claims.version === 2
        ? {
            providerConfigVersion: initialVerification.claims.provider_config_version,
            pricingCatalogId: initialVerification.claims.pricing_catalog_id,
            pricingVersion: initialVerification.claims.pricing_version,
          }
        : undefined;
    const resolution = await resolveStudioEstimate({
      repository: deps.repository,
      accountId: loaded.row.accountId,
      projectId,
      request: {
        capability: parsed.data.capability,
        provider_config_id: parsed.data.provider_config_id,
        model: parsed.data.model,
        input: parsed.data.input,
      },
      ...(expectedVersionBinding ? { expectedVersionBinding } : {}),
      credentialBindingExists: deps.credentialBindingExists,
    });
    if (!resolution.ok) return estimateResolutionError(c, resolution);
    const verifiedEstimate = verifyStudioEstimateToken({
      token: parsed.data.estimate_token,
      secret: deps.estimateSigningSecret,
      expectedVersionBinding: resolution.value.versionBinding,
    });
    if (!verifiedEstimate.valid) {
      const code =
        verifiedEstimate.reason === 'provider_config_stale'
          ? 'STUDIO_PROVIDER_CONFIG_STALE'
          : verifiedEstimate.reason === 'pricing_stale'
            ? 'STUDIO_PRICING_STALE'
            : 'STUDIO_ESTIMATE_EXPIRED';
      return c.json({ error: 'Studio estimate expired', code }, 409);
    }
    const estimate: StudioEstimateResponse = {
      ...verifiedEstimate.claims.estimate,
      estimate_token: parsed.data.estimate_token,
    };
    const actorContext = studioActorContext(c);
    let result: Awaited<ReturnType<StudioRepository['createJob']>>;
    try {
      result = await deps.repository.createJob(
        {
          ...parsed.data,
          account_id: loaded.row.accountId,
          project_id: projectId,
          actor_user_id: loaded.userId,
          ...actorContext,
          parent_job_id: null,
        },
        resolution.value.provider,
        estimate,
        resolution.value.productionBinding,
      );
    } catch (error) {
      if (isStudioRepositoryError(error)) {
        return c.json({ error: error.message, code: error.studioCode }, error.httpStatus);
      }
      throw error;
    }
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
    return c.json(
      await deps.repository.listJobs(
        projectId,
        limitFromQuery(c.req.query('limit')),
        c.req.query('cursor'),
      ),
    );
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
    const job = await deps.repository.requestCancellation(projectId, c.req.param('jobId'));
    if (!job) throw new HTTPException(409, { message: 'STUDIO_JOB_NOT_CANCELLABLE' });
    return c.json(job);
  });

  app.post('/:projectId/studio/jobs/:jobId/recovery', async (c) => {
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
    if (!deps.assertAccountCapability || !deps.recoveryService) {
      return c.json({ error: 'Studio recovery unavailable', code: 'STUDIO_INTERNAL_ERROR' }, 503);
    }
    await deps.assertAccountCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      ACCOUNT_ACTIONS.BILLING_WRITE,
    );
    const parsed = StudioRecoveryRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return badRequest(c, parsed.error.flatten());
    const actor = studioActorContext(c);
    try {
      return c.json(await deps.recoveryService.recover({
        accountId: loaded.row.accountId,
        projectId,
        jobId: c.req.param('jobId'),
        actorUserId: loaded.userId,
        actorType: actor.actor_type,
        actingTokenId: actor.acting_token_id,
        request: parsed.data,
      }));
    } catch (error) {
      return recoveryErrorResponse(c, error);
    }
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
    if (!deps.storageService) {
      return c.json(
        { error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' },
        503,
      );
    }
    try {
      const upload = await deps.storageService.createUpload({
        account_id: loaded.row.accountId,
        project_id: projectId,
        actor_user_id: loaded.userId,
        declared_mime_type: parsed.data.declared_mime_type,
        expected_size_bytes: parsed.data.expected_size_bytes,
        expected_checksum_sha256: parsed.data.expected_checksum_sha256,
        metadata: parsed.data.metadata ?? {},
      });
      return c.json(upload, 201);
    } catch (error) {
      return storageErrorResponse(c, error);
    }
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
    if (!deps.storageService) {
      return c.json(
        { error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' },
        503,
      );
    }
    try {
      const asset = await deps.storageService.finalizeUpload({
        accountId: loaded.row.accountId,
        projectId,
        uploadId: c.req.param('uploadId'),
      });
      if (!asset) return c.json({ error: 'Not found' }, 404);
      return c.json(asset);
    } catch (error) {
      return storageErrorResponse(c, error);
    }
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
    return c.json(
      await deps.repository.listAssets(
        projectId,
        limitFromQuery(c.req.query('limit')),
        c.req.query('cursor'),
      ),
    );
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
    if (!deps.storageService) {
      return c.json(
        { error: 'Studio storage unavailable', code: 'STUDIO_STORAGE_UNAVAILABLE' },
        503,
      );
    }
    try {
      const download = await deps.storageService.createDownloadUrl({
        accountId: loaded.row.accountId,
        projectId,
        assetId: c.req.param('assetId'),
      });
      if (!download) return c.json({ error: 'Not found' }, 404);
      return c.json(download);
    } catch (error) {
      return storageErrorResponse(c, error);
    }
  });

  return app;
}
