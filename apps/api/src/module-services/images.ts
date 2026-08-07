import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { Hono } from 'hono';
import {
  type ModuleServiceCapabilityClaimsV1,
  ModulePaymentIdempotencyKeySchema,
  type OpenOpcImageAsset,
  OpenOpcImageEstimateRequestSchema,
  type OpenOpcImageEstimate,
  OpenOpcImageGenerateInputSchema,
  type OpenOpcImageGenerateInput,
  type OpenOpcImageJob,
  OpenOpcImageJobCreateInputSchema,
  type OpenOpcImageJobEvent,
  type OpenOpcImageModel,
  type OpenOpcImageListInput,
  OpenOpcImageListInputSchema,
  type OpenOpcServiceOperation,
} from '@kortix/api-contract';
import type { StudioJob, StudioJobEvent, StudioEstimateResponse } from '@kortix/api-contract';
import { canonicalStudioRequestHash, StudioStorageUnavailableError } from '@kortix/studio-runtime';

import {
  createDefaultModuleImageRuntime,
  type DefaultModuleImageRuntime,
} from '../studio/default-routes';
import { type StudioCredentialBindingExists } from '../studio/index';
import { resolveStudioEstimate } from '../studio/estimates';
import { issueStudioEstimateToken, verifyStudioEstimateToken } from '../studio/estimate-token';
import { fakeStudioDefinitionConfig, resolveStudioProviderDefinition } from '../studio/providers';
import {
  StudioStorageServiceError,
  type StudioStorageService,
} from '../studio/storage';
import type { StudioRepository } from '../studio/types';
import { createProjectCapabilityRegistry } from '../intelligence/capability-registry';
import {
  ReleaseProfileUnavailableError,
  type RuntimeReleaseProfile,
  assertRuntimeCapability,
  loadRuntimeReleaseProfile,
} from '../release-profile/runtime';
import type { AppEnv } from '../types';
import { ModuleServiceCapabilityError } from './capability-grants';
import { requireModuleServiceOperation } from './service-auth';

const MODEL_ID_PREFIX = 'img1/';
const MODEL_SIGNING_DOMAIN = 'openopc:module:image-model:v1:';
const MODEL_CIPHER_ALGORITHM = 'aes-256-gcm';
const MODEL_NONCE_BYTES = 12;
const MODEL_TAG_BYTES = 16;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const IMAGE_OPERATIONS = {
  models: 'images.models.read',
  estimate: 'images.estimates.create',
  jobCreate: 'images.jobs.create',
  jobRead: 'images.jobs.read',
  jobCancel: 'images.jobs.cancel',
  assetCreate: 'images.assets.create',
  assetRead: 'images.assets.read',
  assetDownload: 'images.assets.download',
} as const satisfies Record<string, Extract<OpenOpcServiceOperation, `images.${string}`>>;

type ImageOperation = (typeof IMAGE_OPERATIONS)[keyof typeof IMAGE_OPERATIONS];

type CapabilityTarget = {
  capability_id: string;
  provider_config_id: string;
  model: string;
  imageCapabilities?: OpenOpcImageModel['capabilities'];
};

const DEFAULT_IMAGE_CAPABILITIES: OpenOpcImageModel['capabilities'] = {
  reference_images: false,
  max_reference_images: 0,
  supports_negative_prompt: false,
  supports_seed: false,
  aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
  qualities: ['standard', 'high'],
  max_output_count: 8,
};

type ImageCapabilityRegistry = {
  discover(
    projectId: string,
    actor: {
      accountId: string;
      userId?: string;
      actorType?: 'user' | 'agent' | 'system';
      actingTokenId?: string | null;
    },
  ): Promise<{ executionTargets: readonly CapabilityTarget[] }>;
};

export interface ModuleImageDependencies {
  runtime: RuntimeReleaseProfile;
  repository: StudioRepository;
  storageService: StudioStorageService | null;
  credentialBindingExists?: StudioCredentialBindingExists;
  estimateSigningSecret: string;
  capabilityRegistry: ImageCapabilityRegistry;
  requireCapability(
    authorization: string | undefined,
    operation: ImageOperation,
  ): Promise<ModuleServiceCapabilityClaimsV1>;
}

export function createRuntimeModuleImageDependencies(): ModuleImageDependencies {
  const defaults: DefaultModuleImageRuntime = createDefaultModuleImageRuntime();
  // The intelligence capability registry is created lazily so the module
  // service import does not create a second Studio provider graph.
  const capabilityRegistry = createDefaultImageCapabilityRegistry(defaults);
  return {
    runtime: loadRuntimeReleaseProfile(),
    repository: defaults.repository,
    storageService: defaults.storageService,
    credentialBindingExists: defaults.credentialBindingExists,
    estimateSigningSecret: defaults.estimateSigningSecret,
    capabilityRegistry,
    requireCapability: (authorization, operation) =>
      requireModuleServiceOperation(authorization, { service: 'ai', operation }),
  };
}

export function createModuleImageRoutes(dependencies: ModuleImageDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/models', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.models);
      await requireStorage(dependencies);
      const targets = await discoverTargets(dependencies, claims);
      const data = targets.map((target, index) =>
        publicModel(claims, target, dependencies.estimateSigningSecret, index),
      );
      return jsonResponse({ data });
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/estimates', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const parsed = OpenOpcImageEstimateRequestSchema.safeParse(await readJsonBody(context));
      if (!parsed.success) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.estimate);
      await requireStorage(dependencies);
      const target = await resolveTarget(dependencies, claims, parsed.data.model);
      const request = studioRequest(target, parsed.data.input);
      const resolution = await resolveStudioEstimate({
        repository: dependencies.repository,
        accountId: claims.accountId,
        projectId: claims.projectId,
        request,
        credentialBindingExists: dependencies.credentialBindingExists,
      });
      if (!resolution.ok) return studioResolutionError(resolution);
      const unsigned = {
        estimate_id: randomUUID(),
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
        currency: 'credits' as const,
        input_hash: canonicalStudioRequestHash(request),
        ...resolution.value.costs,
      };
      const estimate: OpenOpcImageEstimate = {
        ...unsigned,
        estimate_token: issueStudioEstimateToken({
          secret: dependencies.estimateSigningSecret,
          accountId: claims.accountId,
          projectId: claims.projectId,
          actorUserId: claims.actorUserId as string,
          estimate: unsigned,
          versionBinding: resolution.value.versionBinding,
        }),
      };
      return jsonResponse(estimate);
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/jobs', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const parsed = OpenOpcImageJobCreateInputSchema.safeParse(await readJsonBody(context));
      if (!parsed.success) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const idempotencyKey = context.req.header('idempotency-key');
      if (!idempotencyKey || !ModulePaymentIdempotencyKeySchema.safeParse(idempotencyKey).success) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      }
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.jobCreate);
      await requireStorage(dependencies);
      const target = await resolveTarget(dependencies, claims, parsed.data.model);
      const request = studioRequest(target, parsed.data.input);
      const requestHash = canonicalStudioRequestHash(request);
      const replay = await dependencies.repository.findJobByIdempotency(claims.accountId, idempotencyKey);
      if (replay) {
        if (
          replay.project_id !== claims.projectId ||
          replay.actor_user_id !== claims.actorUserId ||
          replay.request_hash !== requestHash
        ) {
          return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_IDEMPOTENCY_CONFLICT', 409));
        }
        return jsonResponse({
          job: mapJob(replay, claims, dependencies.estimateSigningSecret),
          created: false,
        });
      }
      const approval = parsed.data.estimate;
      const initial = verifyStudioEstimateToken({
        token: approval.estimate_token,
        secret: dependencies.estimateSigningSecret,
      });
      if (
        !initial.valid ||
        initial.claims.account_id !== claims.accountId ||
        initial.claims.project_id !== claims.projectId ||
        initial.claims.actor_user_id !== claims.actorUserId ||
        initial.claims.estimate.estimate_id !== approval.estimate_id ||
        initial.claims.estimate.max_approved_credits !== approval.max_approved_credits ||
        initial.claims.estimate.input_hash !== requestHash
      ) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_ESTIMATE_EXPIRED', 409));
      }
      const expectedVersionBinding =
        initial.claims.version === 2
          ? {
              providerConfigVersion: initial.claims.provider_config_version,
              pricingCatalogId: initial.claims.pricing_catalog_id,
              pricingVersion: initial.claims.pricing_version,
            }
          : undefined;
      const resolution = await resolveStudioEstimate({
        repository: dependencies.repository,
        accountId: claims.accountId,
        projectId: claims.projectId,
        request,
        ...(expectedVersionBinding ? { expectedVersionBinding } : {}),
        credentialBindingExists: dependencies.credentialBindingExists,
      });
      if (!resolution.ok) return studioResolutionError(resolution);
      const verified = verifyStudioEstimateToken({
        token: approval.estimate_token,
        secret: dependencies.estimateSigningSecret,
        expectedVersionBinding: resolution.value.versionBinding,
      });
      if (!verified.valid) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_ESTIMATE_EXPIRED', 409));
      }
      const estimate: StudioEstimateResponse = {
        ...verified.claims.estimate,
        estimate_token: approval.estimate_token,
      };
      const result = await dependencies.repository.createJob(
        {
          capability: 'image.generate',
          provider_config_id: target.provider_config_id,
          model: target.model,
          input: request.input,
          estimate_id: estimate.estimate_id,
          estimate_token: estimate.estimate_token,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          account_id: claims.accountId,
          project_id: claims.projectId,
          actor_user_id: claims.actorUserId,
          actor_type: 'user',
          acting_token_id: null,
          agent_name: null,
          session_id: null,
          parent_job_id: null,
        },
        resolution.value.provider,
        estimate,
        resolution.value.productionBinding,
      );
      if (result.mismatch) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_IDEMPOTENCY_CONFLICT', 409));
      }
      return jsonResponse(
        { job: mapJob(result.job, claims, dependencies.estimateSigningSecret), created: result.created },
        result.created ? 201 : 200,
      );
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/jobs/list', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const input = parseListInput(await readJsonBody(context));
      if (!input) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.jobRead);
      const page = await dependencies.repository.listJobs(claims.projectId, input.limit ?? 50, input.cursor);
      return jsonResponse({
        items: page.items
          .filter((job) => job.actor_user_id === claims.actorUserId)
          .map((job) => mapJob(job, claims, dependencies.estimateSigningSecret)),
        next_cursor: page.next_cursor,
      });
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.get('/jobs/:jobId', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const jobId = context.req.param('jobId');
      if (!UUID_PATTERN.test(jobId)) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.jobRead);
      const job = await dependencies.repository.getJob(claims.projectId, jobId);
      if (!job || job.actor_user_id !== claims.actorUserId) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_NOT_FOUND', 404));
      }
      return jsonResponse(mapJob(job, claims, dependencies.estimateSigningSecret));
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/jobs/:jobId/events', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const jobId = context.req.param('jobId');
      const input = parseListInput(await readJsonBody(context));
      if (!UUID_PATTERN.test(jobId) || !input) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      }
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.jobRead);
      const job = await dependencies.repository.getJob(claims.projectId, jobId);
      if (!job || job.actor_user_id !== claims.actorUserId) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_NOT_FOUND', 404));
      }
      const page = await dependencies.repository.listEvents(claims.projectId, jobId, input.cursor);
      return jsonResponse({ items: page.items.map(mapEvent), next_cursor: page.next_cursor });
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/jobs/:jobId/cancel', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const jobId = context.req.param('jobId');
      if (!UUID_PATTERN.test(jobId)) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.jobCancel);
      const existing = await dependencies.repository.getJob(claims.projectId, jobId);
      if (!existing || existing.actor_user_id !== claims.actorUserId) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_NOT_FOUND', 404));
      }
      if (!['queued', 'running'].includes(existing.status)) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_JOB_NOT_CANCELLABLE', 409));
      }
      const job = await dependencies.repository.requestCancellation(claims.projectId, jobId);
      if (!job) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_JOB_NOT_CANCELLABLE', 409));
      return jsonResponse(mapJob(job, claims, dependencies.estimateSigningSecret));
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/assets', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.assetCreate);
      const storage = await requireStorage(dependencies);
      const mimeType = context.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      const contentLengthHeader = context.req.header('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
      if (
        !mimeType ||
        !IMAGE_MIME_TYPES.has(mimeType) ||
        (contentLength !== null &&
          (!/^\d+$/.test(contentLengthHeader ?? '') || contentLength <= 0 || contentLength > MAX_IMAGE_BYTES))
      ) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      }
      const bytes = await readBoundedRequestBody(context.req.raw.body, MAX_IMAGE_BYTES);
      if (!bytes || (contentLength !== null && bytes.byteLength !== contentLength)) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      }
      const asset = await storage.createAssetFromBytes({
        accountId: claims.accountId,
        projectId: claims.projectId,
        actorUserId: claims.actorUserId as string,
        mimeType: mimeType as 'image/png' | 'image/jpeg' | 'image/webp',
        bytes,
      });
      return jsonResponse(mapAsset(asset), 201);
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/assets/list', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const input = parseListInput(await readJsonBody(context));
      if (!input) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.assetRead);
      const page = await dependencies.repository.listAssets(claims.projectId, input.limit ?? 50, input.cursor);
      return jsonResponse({ items: page.items.map(mapAsset), next_cursor: page.next_cursor });
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.get('/assets/:assetId', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const assetId = context.req.param('assetId');
      if (!UUID_PATTERN.test(assetId)) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.assetRead);
      const asset = await dependencies.repository.getAsset(claims.projectId, assetId);
      if (!asset || asset.account_id !== claims.accountId) {
        return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_NOT_FOUND', 404));
      }
      return jsonResponse(mapAsset(asset));
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  app.post('/assets/:assetId/content', async (context) => {
    try {
      assertImageRuntime(dependencies);
      const assetId = context.req.param('assetId');
      if (!UUID_PATTERN.test(assetId)) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400));
      const claims = await requireImageClaims(context.req.header('authorization'), dependencies, IMAGE_OPERATIONS.assetDownload);
      const storage = await requireStorage(dependencies);
      const result = await storage.readAsset({
        accountId: claims.accountId,
        projectId: claims.projectId,
        assetId,
      });
      if (!result) return imageErrorResponse(new ModuleServiceCapabilityError('MODULE_IMAGE_NOT_FOUND', 404));
      return new Response(Buffer.from(result.bytes), {
        status: 200,
        headers: {
          'content-type': result.asset.mime_type,
          'content-length': String(result.bytes.byteLength),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    } catch (error) {
      return imageErrorResponse(error);
    }
  });

  return app;
}

function createDefaultImageCapabilityRegistry(
  defaults: DefaultModuleImageRuntime,
): ImageCapabilityRegistry {
  return createProjectCapabilityRegistry({
    repository: defaults.repository,
    isStorageReady: async () => Boolean(defaults.storageService && (await defaults.storageService.isReady())),
    credentialBindingExists: defaults.credentialBindingExists,
  });
}

async function requireImageClaims(
  authorization: string | undefined,
  dependencies: ModuleImageDependencies,
  operation: ImageOperation,
): Promise<ModuleServiceCapabilityClaimsV1 & { actorUserId: string }> {
  const claims = await dependencies.requireCapability(authorization, operation);
  if (!claims.actorUserId || !UUID_PATTERN.test(claims.actorUserId)) {
    throw new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400);
  }
  return claims as ModuleServiceCapabilityClaimsV1 & { actorUserId: string };
}

function assertImageRuntime(dependencies: ModuleImageDependencies): void {
  assertRuntimeCapability('module.ai.gateway', dependencies.runtime);
}

async function requireStorage(dependencies: ModuleImageDependencies): Promise<StudioStorageService> {
  if (!dependencies.storageService || !(await dependencies.storageService.isReady())) {
    throw new ModuleServiceCapabilityError('MODULE_IMAGE_STORAGE_UNAVAILABLE', 503);
  }
  return dependencies.storageService;
}

async function discoverTargets(
  dependencies: ModuleImageDependencies,
  claims: ModuleServiceCapabilityClaimsV1 & { actorUserId: string },
): Promise<readonly CapabilityTarget[]> {
  const result = await dependencies.capabilityRegistry.discover(claims.projectId, {
    accountId: claims.accountId,
    userId: claims.actorUserId,
    actorType: 'user',
    actingTokenId: claims.grantId,
  });
  const targets = result.executionTargets.filter(
    (target) =>
      target.capability_id === 'studio.image.generate' &&
      UUID_PATTERN.test(target.provider_config_id) &&
      typeof target.model === 'string' &&
      target.model.length > 0,
  );
  return Promise.all(
    targets.map(async (target) => ({
      ...target,
      imageCapabilities: await resolveImageCapabilities(dependencies, claims, target),
    })),
  );
}

async function resolveImageCapabilities(
  dependencies: ModuleImageDependencies,
  claims: ModuleServiceCapabilityClaimsV1 & { actorUserId: string },
  target: { provider_config_id: string; model: string },
): Promise<OpenOpcImageModel['capabilities']> {
  try {
    const [publicProvider, rawProvider] = await Promise.all([
      dependencies.repository.getProvider(claims.projectId, target.provider_config_id),
      dependencies.repository.getProviderConfigRecord(
        claims.accountId,
        claims.projectId,
        target.provider_config_id,
      ),
    ]);
    const config =
      rawProvider ??
      (publicProvider?.provider === 'fake'
        ? fakeStudioDefinitionConfig({ providerConfigId: target.provider_config_id })
        : null);
    if (!config) return DEFAULT_IMAGE_CAPABILITIES;
    const registration = resolveStudioProviderDefinition(config.provider);
    const descriptor = registration?.definition
      .capabilities(config)
      .find(
        (candidate) =>
          candidate.capability === 'image.generate' && candidate.supported_models.includes(target.model),
      );
    if (!descriptor) return DEFAULT_IMAGE_CAPABILITIES;

    const maxReferenceImages = boundedCapabilityLimit(
      descriptor.limits.max_reference_images,
      DEFAULT_IMAGE_CAPABILITIES.max_reference_images,
    );
    const maxOutputCount = boundedOutputLimit(
      descriptor.limits.max_outputs,
      DEFAULT_IMAGE_CAPABILITIES.max_output_count,
    );
    const advancedFields = modelAdvancedFields(config, target.model);
    const supportsAdvanced = config.provider === 'fake' || advancedFields !== null;
    return {
      ...DEFAULT_IMAGE_CAPABILITIES,
      reference_images: maxReferenceImages > 0,
      max_reference_images: maxReferenceImages,
      supports_negative_prompt:
        supportsAdvanced && (config.provider === 'fake' || advancedFields?.has('negative_prompt') === true),
      supports_seed: supportsAdvanced && (config.provider === 'fake' || advancedFields?.has('seed') === true),
      max_output_count: maxOutputCount,
    };
  } catch {
    return DEFAULT_IMAGE_CAPABILITIES;
  }
}

function boundedCapabilityLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8
    ? value
    : fallback;
}

function boundedOutputLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 8
    ? value
    : fallback;
}

function modelAdvancedFields(
  config: { capability_map?: unknown },
  model: string,
): Set<string> | null {
  if (!config.capability_map || typeof config.capability_map !== 'object' || Array.isArray(config.capability_map)) {
    return null;
  }
  const capabilities = (config.capability_map as Record<string, unknown>).capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
  const image = (capabilities as Record<string, unknown>)['image.generate'];
  if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
  const models = (image as Record<string, unknown>).models;
  if (!Array.isArray(models)) return null;
  const entry = models.find(
    (candidate) =>
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).model === model,
  );
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const fields = (entry as Record<string, unknown>).allowed_advanced_fields;
  return Array.isArray(fields)
    ? new Set(fields.filter((field): field is string => typeof field === 'string'))
    : null;
}

async function resolveTarget(
  dependencies: ModuleImageDependencies,
  claims: ModuleServiceCapabilityClaimsV1 & { actorUserId: string },
  modelId: string,
): Promise<CapabilityTarget> {
  if (!MODEL_ID_PATTERN.test(modelId)) {
    throw new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400);
  }
  const decoded = decodeModelId(modelId, claims, dependencies.estimateSigningSecret);
  if (!decoded) throw new ModuleServiceCapabilityError('MODULE_IMAGE_INVALID', 400);
  const targets = await discoverTargets(dependencies, claims);
  const target = targets.find(
    (candidate) =>
      candidate.provider_config_id === decoded.provider_config_id && candidate.model === decoded.model,
  );
  if (!target) throw new ModuleServiceCapabilityError('MODULE_IMAGE_UNAVAILABLE', 503);
  return target;
}

function studioRequest(target: CapabilityTarget, input: OpenOpcImageGenerateInput) {
  return {
    capability: 'image.generate' as const,
    provider_config_id: target.provider_config_id,
    model: target.model,
    input: { capability: 'image.generate' as const, image: input },
  };
}

function publicModel(
  claims: ModuleServiceCapabilityClaimsV1,
  target: CapabilityTarget,
  secret: string,
  index: number,
): OpenOpcImageModel {
  const capabilities = target.imageCapabilities ?? DEFAULT_IMAGE_CAPABILITIES;
  return {
    id: encodeModelId(claims, target, secret),
    object: 'image_model',
    owned_by: 'openopc',
    name: `OpenOPC Image ${index + 1}`,
    capabilities,
  };
}

function mapJob(
  job: StudioJob,
  claims: ModuleServiceCapabilityClaimsV1,
  secret: string,
): OpenOpcImageJob {
  const input = job.input?.capability === 'image.generate' ? job.input.image : null;
  if (!input) throw new ModuleServiceCapabilityError('MODULE_IMAGE_UNAVAILABLE', 503);
  return {
    job_id: job.job_id,
    model: encodeModelId(
      claims,
      { capability_id: 'studio.image.generate', provider_config_id: job.provider_config_id, model: job.model },
      secret,
    ),
    input: OpenOpcImageGenerateInputSchema.parse(input),
    status: job.status,
    reserved_credits: job.reserved_credits,
    actual_credits: job.actual_credits,
    error_code: job.error_code,
    created_at: imageTimestamp(job.created_at),
    updated_at: imageTimestamp(job.updated_at),
    started_at: nullableImageTimestamp(job.started_at),
    completed_at: nullableImageTimestamp(job.completed_at),
    cancellable: job.status === 'queued' || job.status === 'running',
  };
}

function mapEvent(event: StudioJobEvent): OpenOpcImageJobEvent {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const progress = typeof payload.progress === 'number' && Number.isFinite(payload.progress)
    ? Math.max(0, Math.min(1, payload.progress))
    : null;
  const rawAssetIds = Array.isArray(payload.asset_ids)
    ? payload.asset_ids
    : typeof payload.asset_id === 'string'
      ? [payload.asset_id]
      : [];
  const assetIds = rawAssetIds.filter((value): value is string => typeof value === 'string' && UUID_PATTERN.test(value)).slice(0, 8);
  const errorCode = typeof payload.error_code === 'string' && /^[A-Z][A-Z0-9_.-]{0,127}$/.test(payload.error_code)
    ? payload.error_code
    : null;
  return {
    event_id: event.event_id,
    cursor: event.cursor,
    type: event.type,
    progress,
    asset_ids: assetIds,
    error_code: errorCode,
    created_at: imageTimestamp(event.created_at),
  };
}

function mapAsset(asset: import('@kortix/api-contract').StudioAsset): OpenOpcImageAsset {
  return {
    asset_id: asset.asset_id,
    source_job_id: asset.source_job_id,
    kind: 'image',
    mime_type: asset.mime_type as OpenOpcImageAsset['mime_type'],
    size_bytes: asset.size_bytes,
    width: asset.width,
    height: asset.height,
    created_at: imageTimestamp(asset.created_at),
  };
}

function imageTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ModuleServiceCapabilityError('MODULE_IMAGE_UNAVAILABLE', 503);
  }
  return new Date(timestamp).toISOString();
}

function nullableImageTimestamp(value: string | null): string | null {
  return value === null ? null : imageTimestamp(value);
}

function parseListInput(value: unknown): OpenOpcImageListInput | null {
  const parsed = OpenOpcImageListInputSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

async function readJsonBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return null;
  }
}

async function readBoundedRequestBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size <= 0) return null;
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function encodeModelId(
  claims: ModuleServiceCapabilityClaimsV1,
  target: CapabilityTarget,
  secret: string,
): string {
  const nonce = randomBytes(MODEL_NONCE_BYTES);
  const cipher = createCipheriv(
    MODEL_CIPHER_ALGORITHM,
    deriveModelKey(secret, claims),
    nonce,
  );
  cipher.setAAD(Buffer.from(modelSigningContext(claims), 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(
      JSON.stringify({
        v: 1,
        pc: target.provider_config_id,
        m: target.model,
      }),
      'utf8',
    ),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [nonce, ciphertext, tag].map(encodeBase64Url).join(':').replace(/^/, MODEL_ID_PREFIX);
}

function decodeModelId(
  value: string,
  claims: ModuleServiceCapabilityClaimsV1,
  secret: string,
): CapabilityTarget | null {
  if (!value.startsWith(MODEL_ID_PREFIX)) return null;
  const encoded = value.slice(MODEL_ID_PREFIX.length);
  const parts = encoded.split(':');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;
  let nonce: Buffer;
  let ciphertext: Buffer;
  let tag: Buffer;
  try {
    nonce = decodeBase64Bytes(parts[0]);
    ciphertext = decodeBase64Bytes(parts[1]);
    tag = decodeBase64Bytes(parts[2]);
  } catch {
    return null;
  }
  if (
    nonce.length !== MODEL_NONCE_BYTES ||
    ciphertext.length === 0 ||
    tag.length !== MODEL_TAG_BYTES
  ) {
    return null;
  }
  let parsed: unknown;
  try {
    const decipher = createDecipheriv(
      MODEL_CIPHER_ALGORITHM,
      deriveModelKey(secret, claims),
      nonce,
    );
    decipher.setAAD(Buffer.from(modelSigningContext(claims), 'utf8'));
    decipher.setAuthTag(tag);
    parsed = JSON.parse(
      Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
    );
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.pc !== 'string' ||
    !UUID_PATTERN.test(candidate.pc) ||
    typeof candidate.m !== 'string' ||
    candidate.m.length === 0 ||
    candidate.m.length > 255
  ) return null;
  return { capability_id: 'studio.image.generate', provider_config_id: candidate.pc, model: candidate.m };
}

function deriveModelKey(
  secret: string,
  claims: Pick<
    ModuleServiceCapabilityClaimsV1,
    | 'accountId'
    | 'projectId'
    | 'installationId'
    | 'installRevision'
    | 'releaseId'
    | 'actorUserId'
  >,
): Buffer {
  return createHash('sha256').update(`${MODEL_SIGNING_DOMAIN}${secret}:${modelSigningContext(claims)}`).digest();
}

function modelSigningContext(
  claims: Pick<
    ModuleServiceCapabilityClaimsV1,
    | 'accountId'
    | 'projectId'
    | 'installationId'
    | 'installRevision'
    | 'releaseId'
    | 'actorUserId'
  >,
): string {
  return [
    claims.accountId,
    claims.projectId,
    claims.installationId,
    String(claims.installRevision),
    claims.releaseId,
    claims.actorUserId ?? '',
  ].join(':');
}

function encodeBase64Url(value: string | Uint8Array): string {
  const base64 = Buffer.from(value).toString('base64').replace(/=+$/g, '');
  return base64.replace(/\+/g, '.').replace(/\//g, '-');
}

function decodeBase64Bytes(value: string): Buffer {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('Invalid model identifier encoding');
  const base64 = value.replace(/\./g, '+').replace(/-/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(base64, 'base64');
}

function studioResolutionError(resolution: { ok: false; status: number; code: string }): Response {
  if (resolution.code === 'STUDIO_CREDENTIAL_UNAVAILABLE' || resolution.code === 'STUDIO_PROVIDER_UNAVAILABLE') {
    return jsonResponse({ error: 'MODULE_IMAGE_UNAVAILABLE' }, 503);
  }
  if (resolution.code === 'STUDIO_ESTIMATE_EXPIRED' || resolution.code === 'STUDIO_PROVIDER_CONFIG_STALE' || resolution.code === 'STUDIO_PRICING_STALE') {
    return jsonResponse({ error: 'MODULE_IMAGE_ESTIMATE_EXPIRED' }, 409);
  }
  return jsonResponse({ error: 'MODULE_IMAGE_INVALID' }, 400);
}

function imageErrorResponse(error: unknown): Response {
  if (error instanceof ReleaseProfileUnavailableError) {
    return jsonResponse({ code: error.code, capability: error.capability }, error.status);
  }
  if (error instanceof ModuleServiceCapabilityError) {
    return jsonResponse({ error: error.code }, error.status);
  }
  if (error instanceof StudioStorageServiceError) {
    return jsonResponse(
      {
        error: 'MODULE_IMAGE_INVALID',
      },
      400,
    );
  }
  if (error instanceof StudioStorageUnavailableError) {
    return jsonResponse({ error: 'MODULE_IMAGE_STORAGE_UNAVAILABLE' }, 503);
  }
  if (error && typeof error === 'object' && 'studioCode' in error) {
    const code = (error as { studioCode?: string }).studioCode;
    if (code === 'STUDIO_INSUFFICIENT_CREDITS') return jsonResponse({ error: 'MODULE_IMAGE_UNAVAILABLE' }, 409);
    if (code === 'STUDIO_PROVIDER_CONFIG_STALE' || code === 'STUDIO_PRICING_STALE') {
      return jsonResponse({ error: 'MODULE_IMAGE_ESTIMATE_EXPIRED' }, 409);
    }
  }
  return jsonResponse({ error: 'MODULE_IMAGE_UNAVAILABLE' }, 503);
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
