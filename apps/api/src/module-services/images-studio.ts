import {
  OPENOPC_IMAGE_ASSET_MAX_BYTES,
  OPENOPC_IMAGE_MIME_TYPES,
  type OpenOpcImageAsset,
  type OpenOpcImageAssetDeleteResult,
  type OpenOpcImageAssetPage,
  type OpenOpcImageAssetPreview,
  type OpenOpcImageAssetThumbnail,
  type OpenOpcImageErrorCode,
  type OpenOpcImageEstimate,
  type OpenOpcImageEstimateCreateInput,
  type OpenOpcImageJob,
  type OpenOpcImageJobCreateInput,
  type OpenOpcImageJobEvent,
  type OpenOpcImageJobEventPage,
  type OpenOpcImageJobPage,
  type OpenOpcImageModel,
  type OpenOpcImageModelListResponse,
  type StudioAsset,
  type StudioErrorCode,
  type StudioEstimateResponse,
  type StudioJob,
  type StudioJobEvent,
} from '@kortix/api-contract';
import { StudioStorageUnavailableError, canonicalStudioRequestHash } from '@kortix/studio-runtime';

import {
  type UnsignedStudioEstimate,
  issueStudioEstimateToken,
  verifyStudioEstimateToken,
} from '../studio/estimate-token';
import { resolveStudioEstimate } from '../studio/estimates';
import { fakeStudioDefinitionConfig, resolveStudioProviderDefinition } from '../studio/providers';
import { type StudioStorageService, StudioStorageServiceError } from '../studio/storage';
import {
  type StudioProviderConfigRecord,
  type StudioRepository,
  isStudioRepositoryError,
} from '../studio/types';
import {
  type ModuleImageAssetDownload,
  type ModuleImageAssetListPage,
  type ModuleImageAssetUpload,
  type ModuleImageBackend,
  ModuleImageError,
  type ModuleImageJobListPage,
  type ModuleImageScope,
  type ModuleServiceAuthorization,
} from './images';

const ESTIMATE_TTL_MS = 15 * 60 * 1000;
const STUDIO_IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const STUDIO_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const MODULE_MODEL_SEPARATOR = ':';
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:/i;
const MODULE_GRANT_METADATA = 'openopc-module-grant-id';
const MODULE_FILENAME_METADATA = 'openopc-filename';
const MODULE_RETENTION_METADATA = 'openopc-retention';
const MODULE_USER_METADATA = 'openopc-user-metadata';
const MODULE_DELETION_STATE_METADATA = 'openopc-deletion-state';
const MODULE_DELETION_REQUESTED_AT_METADATA = 'openopc-deletion-requested-at';
const MODULE_DELETION_REQUESTED = 'requested';
const MAX_USER_METADATA_BYTES = 16 * 1024;

export type StudioModuleImageBackendInput = {
  repository: StudioRepository;
  storageService: StudioStorageService;
  estimateSigningSecret: string;
  credentialBindingExists?: (input: {
    accountId: string;
    projectId: string;
    binding:
      | { kind: 'none' }
      | { kind: 'secret'; identifier: string }
      | { kind: 'connector'; slug: string };
  }) => Promise<boolean>;
  loadModuleServiceAuthorization?: (grantId: string) => Promise<ModuleServiceAuthorization | null>;
  now?: () => Date;
  randomUUID?: () => string;
};

export class StudioModuleImageBackend implements ModuleImageBackend {
  private readonly now: () => Date;
  private readonly randomUUID: () => string;

  constructor(private readonly input: StudioModuleImageBackendInput) {
    this.now = input.now ?? (() => new Date());
    this.randomUUID = input.randomUUID ?? (() => crypto.randomUUID());
  }

  async listModels(scope: ModuleImageScope): Promise<OpenOpcImageModelListResponse> {
    await this.assertStorageReady();
    const providers = await this.input.repository.listProviders(scope.claims.projectId);
    const data: OpenOpcImageModel[] = [];
    for (const provider of providers) {
      if (
        provider.account_id !== scope.claims.accountId ||
        provider.project_id !== scope.claims.projectId ||
        !provider.enabled ||
        !provider.capabilities.includes('image.generate')
      ) {
        continue;
      }
      const config = await this.providerDefinitionConfig(scope, provider.provider_config_id);
      if (!config) continue;
      if (provider.credential_binding.kind !== 'none') {
        let credentialAvailable = false;
        try {
          credentialAvailable =
            (await this.input.credentialBindingExists?.({
              accountId: scope.claims.accountId,
              projectId: scope.claims.projectId,
              binding: provider.credential_binding,
            })) ?? false;
        } catch {
          credentialAvailable = false;
        }
        if (!credentialAvailable) continue;
      }
      const registration = resolveStudioProviderDefinition(provider.provider);
      if (!registration) continue;
      let descriptors: ReturnType<typeof registration.definition.capabilities>;
      try {
        descriptors = registration.definition.capabilities(config);
      } catch {
        continue;
      }
      const descriptor = descriptors.find((candidate) => candidate.capability === 'image.generate');
      if (!descriptor) continue;
      const limits = descriptor.limits;
      const minOutputs = boundedInteger(limits.min_outputs, 1, 8, 1);
      const maxOutputs = Math.max(
        minOutputs,
        boundedInteger(limits.max_outputs, minOutputs, 8, minOutputs),
      );
      const maxReferences = boundedInteger(limits.max_reference_images, 0, 8, 0);
      for (const model of descriptor.supported_models) {
        const id = moduleImageModelId(provider.provider_config_id, model);
        const name = `${provider.display_name} / ${model}`.slice(0, 512);
        data.push({
          id,
          object: 'image.model',
          owned_by: 'openopc',
          name,
          capabilities: {
            prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
            reference_images: {
              max_images: maxReferences,
              max_bytes_per_image: STUDIO_IMAGE_MAX_BYTES,
              max_total_bytes: Math.max(1, maxReferences) * STUDIO_IMAGE_MAX_BYTES,
              accepted_mime_types: [...STUDIO_IMAGE_MIME_TYPES],
            },
            output: {
              min_images: minOutputs,
              max_images: maxOutputs,
              max_bytes_per_image: STUDIO_IMAGE_MAX_BYTES,
              accepted_mime_types: [...STUDIO_IMAGE_MIME_TYPES],
              aspect_ratios: ['1:1', '4:3', '3:4', '16:9', '9:16'],
              qualities: ['standard', 'high'],
            },
          },
        });
      }
    }
    data.sort((left, right) => left.id.localeCompare(right.id));
    return { data };
  }

  async createEstimate(
    scope: ModuleImageScope,
    input: OpenOpcImageEstimateCreateInput,
  ): Promise<OpenOpcImageEstimate> {
    await this.assertStorageReady();
    const request = await this.studioRequest(scope, input.model, input.input);
    const resolution = await resolveStudioEstimate({
      repository: this.input.repository,
      accountId: scope.claims.accountId,
      projectId: scope.claims.projectId,
      request,
      credentialBindingExists: this.input.credentialBindingExists,
    });
    if (!resolution.ok) throw estimateResolutionError(resolution.code, resolution.status);
    const now = this.now();
    const unsigned: UnsignedStudioEstimate = {
      estimate_id: this.randomUUID(),
      expires_at: new Date(now.getTime() + ESTIMATE_TTL_MS).toISOString(),
      currency: 'credits',
      input_hash: canonicalStudioRequestHash(request),
      ...resolution.value.costs,
    };
    const estimate: StudioEstimateResponse = {
      ...unsigned,
      estimate_token: issueStudioEstimateToken({
        secret: this.input.estimateSigningSecret,
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        actorUserId: scope.actorUserId,
        estimate: unsigned,
        nowMs: now.getTime(),
        versionBinding: resolution.value.versionBinding,
      }),
    };
    return publicEstimate(estimate, ESTIMATE_TTL_MS);
  }

  async createJob(
    scope: ModuleImageScope,
    input: OpenOpcImageJobCreateInput,
  ): Promise<{ job: OpenOpcImageJob; created: boolean }> {
    await this.assertStorageReady();
    const request = await this.studioRequest(scope, input.model, input.input);
    const requestHash = canonicalStudioRequestHash(request);
    const replay = await this.input.repository.findJobByIdempotency(
      scope.claims.accountId,
      input.idempotency_key,
    );
    if (replay) {
      if (!(await this.isOwnedJob(scope, replay)) || replay.request_hash !== requestHash) {
        throw new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH', 409);
      }
      return { job: publicJob(replay), created: false };
    }
    const now = this.now();
    const initial = verifyStudioEstimateToken({
      token: input.estimate_token,
      secret: this.input.estimateSigningSecret,
      nowMs: now.getTime(),
    });
    if (
      !initial.valid ||
      initial.claims.version !== 2 ||
      initial.claims.account_id !== scope.claims.accountId ||
      initial.claims.project_id !== scope.claims.projectId ||
      initial.claims.actor_user_id !== scope.actorUserId ||
      initial.claims.estimate.estimate_id !== input.estimate_id
    ) {
      throw new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_EXPIRED', 409);
    }
    if (initial.claims.estimate.input_hash !== requestHash) {
      throw new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH', 409);
    }
    const expectedVersionBinding = {
      providerConfigVersion: initial.claims.provider_config_version,
      pricingCatalogId: initial.claims.pricing_catalog_id,
      pricingVersion: initial.claims.pricing_version,
    };
    const resolution = await resolveStudioEstimate({
      repository: this.input.repository,
      accountId: scope.claims.accountId,
      projectId: scope.claims.projectId,
      request,
      expectedVersionBinding,
      credentialBindingExists: this.input.credentialBindingExists,
    });
    if (!resolution.ok) throw estimateResolutionError(resolution.code, resolution.status);
    const verified = verifyStudioEstimateToken({
      token: input.estimate_token,
      secret: this.input.estimateSigningSecret,
      nowMs: now.getTime(),
      expectedVersionBinding: resolution.value.versionBinding,
    });
    if (!verified.valid || verified.claims.version !== 2) {
      throw new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INVALID', 409);
    }
    const estimate: StudioEstimateResponse = {
      ...verified.claims.estimate,
      estimate_token: input.estimate_token,
    };
    try {
      const result = await this.input.repository.createJob(
        {
          ...request,
          estimate_id: input.estimate_id,
          estimate_token: input.estimate_token,
          idempotency_key: input.idempotency_key,
          request_hash: requestHash,
          account_id: scope.claims.accountId,
          project_id: scope.claims.projectId,
          actor_user_id: scope.actorUserId,
          actor_type: 'module',
          acting_token_id: null,
          module_service_grant_id: scope.claims.grantId,
          agent_name: null,
          session_id: null,
          parent_job_id: null,
        },
        resolution.value.provider,
        estimate,
        resolution.value.productionBinding,
      );
      if (result.mismatch) {
        throw new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH', 409);
      }
      if (
        result.job.account_id !== scope.claims.accountId ||
        result.job.project_id !== scope.claims.projectId ||
        !(await this.isOwnedJob(scope, result.job))
      ) {
        throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
      }
      return { job: publicJob(result.job), created: result.created };
    } catch (error) {
      if (error instanceof ModuleImageError) throw error;
      if (isStudioRepositoryError(error)) throw repositoryError(error.studioCode);
      throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
    }
  }

  async getJob(scope: ModuleImageScope, jobId: string): Promise<OpenOpcImageJob> {
    return publicJob(await this.requireOwnedJob(scope, jobId));
  }

  async listJobs(
    scope: ModuleImageScope,
    page: ModuleImageJobListPage,
  ): Promise<OpenOpcImageJobPage> {
    const source = await this.input.repository.listJobs(
      scope.claims.projectId,
      page.limit,
      page.cursor,
      {
        account_id: scope.claims.accountId,
        actor_user_id: scope.actorUserId,
        actor_type: 'module',
        capability: 'image.generate',
        module_installation_id: scope.claims.installationId,
        status: page.status,
        created_after: page.created_after,
        created_before: page.created_before,
      },
    );
    return { items: source.items.map(publicJob), next_cursor: source.next_cursor };
  }

  async listEvents(
    scope: ModuleImageScope,
    jobId: string,
    page: { cursor: string | null; limit: number },
  ): Promise<OpenOpcImageJobEventPage> {
    await this.requireOwnedJob(scope, jobId);
    let source: Awaited<ReturnType<StudioRepository['listEvents']>>;
    try {
      source = await this.input.repository.listEvents(scope.claims.projectId, jobId, page.cursor);
    } catch (error) {
      if (studioCode(error) === 'STUDIO_EVENT_CURSOR_EXPIRED') {
        throw new ModuleImageError('OPENOPC_IMAGE_EVENT_CURSOR_EXPIRED', 410);
      }
      throw new ModuleImageError('OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE', 503);
    }
    const selected = source.items.slice(0, page.limit);
    let items: OpenOpcImageJobEvent[];
    try {
      items = selected.map((event) => publicEvent(event, jobId));
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE', 503);
    }
    return {
      items,
      next_cursor:
        source.items.length > selected.length
          ? (selected.at(-1)?.cursor ?? null)
          : source.next_cursor,
    };
  }

  async listJobOutputs(
    scope: ModuleImageScope,
    jobId: string,
    page: { cursor: string | null; limit: number },
  ): Promise<OpenOpcImageAssetPage> {
    await this.requireOwnedJob(scope, jobId);
    const source = await this.input.repository.listJobAssets(
      scope.claims.projectId,
      jobId,
      'output',
      page.limit,
      page.cursor,
    );
    const items: OpenOpcImageAsset[] = [];
    for (const asset of source.items) {
      const context = await this.assetContext(scope, asset);
      if (context) items.push(publicAsset(asset, context));
    }
    return { items, next_cursor: source.next_cursor };
  }

  async cancelJob(scope: ModuleImageScope, jobId: string): Promise<OpenOpcImageJob> {
    const current = await this.requireOwnedJob(scope, jobId);
    if (current.status !== 'queued' && current.status !== 'running') {
      throw new ModuleImageError('OPENOPC_IMAGE_JOB_NOT_CANCELLABLE', 409);
    }
    const cancelled = await this.input.repository.requestCancellation(
      scope.claims.projectId,
      jobId,
    );
    if (!cancelled || !(await this.isOwnedJob(scope, cancelled))) {
      throw new ModuleImageError('OPENOPC_IMAGE_JOB_NOT_CANCELLABLE', 409);
    }
    return publicJob(cancelled);
  }

  async createAsset(
    scope: ModuleImageScope,
    input: ModuleImageAssetUpload,
  ): Promise<OpenOpcImageAsset> {
    if (
      !STUDIO_IMAGE_MIME_TYPES.includes(input.mimeType as (typeof STUDIO_IMAGE_MIME_TYPES)[number])
    ) {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
    }
    const userMetadata = serializeUserMetadata(input.metadata);
    try {
      const asset = await this.input.storageService.createDirectAsset({
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        actorUserId: scope.actorUserId,
        bytes: input.bytes,
        mimeType: input.mimeType as (typeof STUDIO_IMAGE_MIME_TYPES)[number],
        metadata: {
          [MODULE_GRANT_METADATA]: scope.claims.grantId,
          [MODULE_FILENAME_METADATA]: input.filename,
          [MODULE_RETENTION_METADATA]: input.retention ?? 'retained',
          [MODULE_USER_METADATA]: userMetadata,
        },
      });
      return this.publicOwnedAsset(scope, asset);
    } catch (error) {
      throw storageError(error);
    }
  }

  async listAssets(
    scope: ModuleImageScope,
    page: ModuleImageAssetListPage,
  ): Promise<OpenOpcImageAssetPage> {
    const source = await this.input.repository.listAssets(
      scope.claims.projectId,
      page.limit,
      page.cursor,
      {
        source_job_id: page.source_job_id,
        source: page.source,
        created_after: page.created_after,
        created_before: page.created_before,
      },
    );
    const items: OpenOpcImageAsset[] = [];
    for (const asset of source.items) {
      const context = await this.assetContext(scope, asset);
      if (!context) continue;
      items.push(publicAsset(asset, context));
    }
    return { items, next_cursor: source.next_cursor };
  }

  async previewAsset(scope: ModuleImageScope, assetId: string): Promise<OpenOpcImageAssetPreview> {
    await this.requireReadableAsset(scope, assetId);
    let signed: Awaited<ReturnType<StudioStorageService['createDownloadUrl']>>;
    try {
      signed = await this.input.storageService.createDownloadUrl({
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        assetId,
      });
    } catch (error) {
      throw storageError(error);
    }
    if (!signed) throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    let url: URL;
    try {
      url = new URL(signed.signed_download_url);
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    }
    return { asset_id: assetId, url: url.toString(), expires_at: signed.expires_at };
  }

  async thumbnailAsset(
    scope: ModuleImageScope,
    assetId: string,
    preset: 'small' | 'medium' | 'large',
  ): Promise<OpenOpcImageAssetThumbnail> {
    await this.requireReadableAsset(scope, assetId);
    let signed: Awaited<ReturnType<StudioStorageService['createThumbnailUrl']>>;
    try {
      signed = await this.input.storageService.createThumbnailUrl({
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        assetId,
        preset,
      });
    } catch (error) {
      throw storageError(error);
    }
    if (!signed) throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    let url: URL;
    try {
      url = new URL(signed.signed_download_url);
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    }
    return {
      asset_id: assetId,
      preset,
      url: url.toString(),
      mime_type: signed.mime_type,
      width: signed.width,
      height: signed.height,
      size_bytes: signed.size_bytes,
      cache: { visibility: 'private', max_age_seconds: 15 * 60, immutable: true },
      expires_at: signed.expires_at,
    };
  }

  async downloadAsset(scope: ModuleImageScope, assetId: string): Promise<ModuleImageAssetDownload> {
    const readable = await this.requireReadableAsset(scope, assetId);
    let result: Awaited<ReturnType<StudioStorageService['readAsset']>>;
    try {
      result = await this.input.storageService.readAsset({
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        assetId,
      });
    } catch (error) {
      throw storageError(error);
    }
    if (!result || result.asset.asset_id !== readable.asset.asset_id) {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    }
    const mimeType = result.asset.mime_type;
    if (!OPENOPC_IMAGE_MIME_TYPES.includes(mimeType as ModuleImageAssetDownload['mimeType'])) {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
    }
    return {
      bytes: result.bytes,
      mimeType: mimeType as ModuleImageAssetDownload['mimeType'],
      filename: readable.filename,
    };
  }

  async deleteAsset(
    scope: ModuleImageScope,
    assetId: string,
  ): Promise<OpenOpcImageAssetDeleteResult> {
    const owned = await this.requireOwnedAsset(scope, assetId, true);
    const ownerGrantId = owned.asset.metadata[MODULE_GRANT_METADATA];
    if (owned.asset.source_job_id !== null || typeof ownerGrantId !== 'string') {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_DELETABLE', 409);
    }
    const deletionMarker = { [MODULE_DELETION_STATE_METADATA]: MODULE_DELETION_REQUESTED };
    let requested: Awaited<ReturnType<StudioRepository['requestDirectAssetDeletion']>>;
    try {
      requested = await this.input.repository.requestDirectAssetDeletion({
        account_id: scope.claims.accountId,
        project_id: scope.claims.projectId,
        asset_id: assetId,
        expected_metadata: { [MODULE_GRANT_METADATA]: ownerGrantId },
        deletion_marker: deletionMarker,
        deletion_metadata: {
          ...deletionMarker,
          [MODULE_DELETION_REQUESTED_AT_METADATA]: this.now().toISOString(),
        },
      });
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
    }
    if (requested.outcome === 'in_use') {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_DELETABLE', 409);
    }
    if (requested.outcome === 'not_found') {
      const candidate = await this.input.repository.getAsset(scope.claims.projectId, assetId);
      const context = candidate ? await this.assetContext(scope, candidate) : null;
      if (candidate && context && candidate.source_job_id !== null) {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_DELETABLE', 409);
      }
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    }

    try {
      await this.input.storageService.deleteAssetObject({
        accountId: scope.claims.accountId,
        projectId: scope.claims.projectId,
        asset: requested.asset,
      });
    } catch (error) {
      throw storageError(error);
    }
    try {
      await this.input.repository.deleteRequestedDirectAsset({
        account_id: scope.claims.accountId,
        project_id: scope.claims.projectId,
        asset_id: assetId,
        expected_metadata: {
          [MODULE_GRANT_METADATA]: ownerGrantId,
          ...deletionMarker,
        },
        object_key: requested.asset.object_key,
      });
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
    }
    return { asset_id: assetId, deleted: true };
  }

  async setAssetRetention(
    scope: ModuleImageScope,
    assetId: string,
    policy: 'temporary' | 'retained',
  ): Promise<OpenOpcImageAsset> {
    const owned = await this.requireOwnedAsset(scope, assetId);
    const ownerGrantId = owned.asset.metadata[MODULE_GRANT_METADATA];
    if (owned.asset.source_job_id !== null || typeof ownerGrantId !== 'string') {
      throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_DELETABLE', 409);
    }
    let updated: StudioAsset | null;
    try {
      updated = await this.input.repository.updateDirectAssetMetadata({
        account_id: scope.claims.accountId,
        project_id: scope.claims.projectId,
        asset_id: assetId,
        expected_metadata: { [MODULE_GRANT_METADATA]: ownerGrantId },
        metadata_patch: { [MODULE_RETENTION_METADATA]: policy },
        forbidden_metadata_key: MODULE_DELETION_STATE_METADATA,
      });
    } catch {
      throw new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
    }
    if (!updated) throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    return this.publicOwnedAsset(scope, updated);
  }

  private async studioRequest(
    scope: ModuleImageScope,
    publicModelId: string,
    image: OpenOpcImageEstimateCreateInput['input'],
  ) {
    const model = parseModuleImageModelId(publicModelId);
    await this.assertReferenceAssets(scope, image.reference_asset_ids ?? []);
    return {
      capability: 'image.generate' as const,
      provider_config_id: model.providerConfigId,
      model: model.model,
      input: {
        capability: 'image.generate' as const,
        image: {
          ...image,
          reference_asset_ids: [...(image.reference_asset_ids ?? [])],
        },
      },
    };
  }

  private async providerDefinitionConfig(
    scope: ModuleImageScope,
    providerConfigId: string,
  ): Promise<StudioProviderConfigRecord | ReturnType<typeof fakeStudioDefinitionConfig> | null> {
    const provider = await this.input.repository.getProvider(
      scope.claims.projectId,
      providerConfigId,
    );
    if (!provider || provider.account_id !== scope.claims.accountId) return null;
    if (provider.provider === 'fake') return fakeStudioDefinitionConfig({ providerConfigId });
    const record = await this.input.repository.getProviderConfigRecord(
      scope.claims.accountId,
      scope.claims.projectId,
      providerConfigId,
    );
    return record?.enabled ? record : null;
  }

  private async requireOwnedJob(scope: ModuleImageScope, jobId: string): Promise<StudioJob> {
    const job = await this.input.repository.getJob(scope.claims.projectId, jobId);
    if (!job || !(await this.isOwnedJob(scope, job))) {
      throw new ModuleImageError('OPENOPC_IMAGE_JOB_NOT_FOUND', 404);
    }
    return job;
  }

  private async isOwnedJob(scope: ModuleImageScope, job: StudioJob): Promise<boolean> {
    return (
      job.account_id === scope.claims.accountId &&
      job.project_id === scope.claims.projectId &&
      job.actor_user_id === scope.actorUserId &&
      job.actor_type === 'module' &&
      job.capability === 'image.generate' &&
      typeof job.module_service_grant_id === 'string' &&
      (await this.grantBelongsToScope(scope, job.module_service_grant_id))
    );
  }

  private async grantBelongsToScope(scope: ModuleImageScope, grantId: string): Promise<boolean> {
    if (grantId === scope.claims.grantId) return true;
    const authorization = await this.input.loadModuleServiceAuthorization?.(grantId);
    return Boolean(
      authorization &&
        authorization.grant.accountId === scope.claims.accountId &&
        authorization.grant.projectId === scope.claims.projectId &&
        authorization.grant.installationId === scope.claims.installationId &&
        authorization.grant.service === 'ai' &&
        authorization.grant.operations.includes('image.generate') &&
        authorization.consent.acceptedBy === scope.actorUserId &&
        authorization.installation.installationId === scope.claims.installationId,
    );
  }

  private async assertReferenceAssets(scope: ModuleImageScope, assetIds: readonly string[]) {
    for (const assetId of assetIds) await this.requireReadableAsset(scope, assetId);
  }

  private async requireReadableAsset(scope: ModuleImageScope, assetId: string) {
    const asset = await this.input.repository.getAsset(scope.claims.projectId, assetId);
    const context = asset ? await this.assetContext(scope, asset) : null;
    if (!asset || !context) throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    return { asset, context, filename: assetFilename(asset) };
  }

  private async requireOwnedAsset(
    scope: ModuleImageScope,
    assetId: string,
    allowDeletionRequested = false,
  ) {
    try {
      const readable = await this.requireReadableAsset(scope, assetId);
      if (!readable.context.deletable) {
        throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
      }
      return readable;
    } catch (error) {
      if (!allowDeletionRequested) throw error;
      const asset = await this.input.repository.getAsset(scope.claims.projectId, assetId);
      const grantId = asset?.metadata[MODULE_GRANT_METADATA];
      if (
        asset &&
        asset.account_id === scope.claims.accountId &&
        asset.metadata[MODULE_DELETION_STATE_METADATA] === MODULE_DELETION_REQUESTED &&
        asset.source_job_id === null &&
        typeof grantId === 'string' &&
        (await this.grantBelongsToScope(scope, grantId))
      ) {
        return {
          asset,
          context: {
            prompt: null,
            retention: 'temporary' as const,
            expiresAt: null,
            deletable: true,
            metadata: {},
          },
          filename: assetFilename(asset),
        };
      }
      throw error;
    }
  }

  private async publicOwnedAsset(scope: ModuleImageScope, asset: StudioAsset) {
    const context = await this.assetContext(scope, asset);
    if (!context) throw new ModuleImageError('OPENOPC_IMAGE_ASSET_NOT_FOUND', 404);
    return publicAsset(asset, context);
  }

  private async assetContext(
    scope: ModuleImageScope,
    asset: StudioAsset,
  ): Promise<{
    prompt: string | null;
    retention: 'temporary' | 'retained';
    expiresAt: string | null;
    deletable: boolean;
    metadata: Record<string, unknown>;
  } | null> {
    if (
      asset.account_id !== scope.claims.accountId ||
      asset.project_id !== scope.claims.projectId
    ) {
      return null;
    }
    if (asset.metadata[MODULE_DELETION_STATE_METADATA] === MODULE_DELETION_REQUESTED) return null;
    const directGrantId = asset.metadata[MODULE_GRANT_METADATA];
    const directOwner =
      typeof directGrantId === 'string' && (await this.grantBelongsToScope(scope, directGrantId));
    if (asset.source_job_id === null) {
      return {
        prompt: null,
        retention:
          asset.metadata[MODULE_RETENTION_METADATA] === 'temporary' ? 'temporary' : 'retained',
        expiresAt: null,
        deletable: directOwner,
        metadata: directOwner ? parseUserMetadata(asset.metadata[MODULE_USER_METADATA]) : {},
      };
    }
    const job = await this.input.repository.getJob(scope.claims.projectId, asset.source_job_id);
    const generatedOwner = job ? await this.isOwnedJob(scope, job) : false;
    return {
      prompt: generatedOwner && job ? job.input.image.prompt : null,
      retention: 'retained',
      expiresAt: null,
      deletable: false,
      metadata: {},
    };
  }

  private async assertStorageReady() {
    if (!(await this.input.storageService.isReady())) {
      throw new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
    }
  }
}

export function moduleImageModelId(providerConfigId: string, model: string): string {
  if (!UUID_PREFIX.test(`${providerConfigId}:`) || !model || model.length > 475) {
    throw new ModuleImageError('OPENOPC_IMAGE_MODEL_UNAVAILABLE', 400);
  }
  return `${providerConfigId}${MODULE_MODEL_SEPARATOR}${model}`;
}

function parseModuleImageModelId(value: string): { providerConfigId: string; model: string } {
  if (!UUID_PREFIX.test(value)) throw new ModuleImageError('OPENOPC_IMAGE_MODEL_UNAVAILABLE', 400);
  const separator = value.indexOf(MODULE_MODEL_SEPARATOR);
  const providerConfigId = value.slice(0, separator);
  const model = value.slice(separator + 1);
  if (!model || model.length > 475) {
    throw new ModuleImageError('OPENOPC_IMAGE_MODEL_UNAVAILABLE', 400);
  }
  return { providerConfigId, model };
}

function publicEstimate(
  estimate: StudioEstimateResponse,
  validForMs: number,
): OpenOpcImageEstimate {
  return {
    estimate_id: estimate.estimate_id,
    estimate_token: estimate.estimate_token,
    expires_at: estimate.expires_at,
    valid_for_ms: validForMs,
    retry: { on_expired: 'create-new-estimate', automatic_job_retry: false },
    currency: 'credits',
    provider_cost_credits: estimate.provider_cost_credits,
    platform_cost_credits: estimate.platform_cost_credits,
    max_approved_credits: estimate.max_approved_credits,
    quota: {
      required_credits: estimate.max_approved_credits,
      available_credits: null,
      remaining_after_estimate_credits: null,
    },
    settlement: {
      succeeded: 'settle-actual-usage',
      failed: 'settle-verified-usage',
      cancelled: 'settle-verified-usage',
      maximum_charge_credits: estimate.max_approved_credits,
    },
    input_hash: estimate.input_hash,
    line_items: estimate.line_items.map((item) => ({ ...item })),
  };
}

function publicJob(job: StudioJob): OpenOpcImageJob {
  return {
    job_id: job.job_id,
    model: moduleImageModelId(job.provider_config_id, job.model),
    input: { ...job.input.image, reference_asset_ids: [...job.input.image.reference_asset_ids] },
    status: job.status,
    attempt_count: job.attempt_count,
    reserved_credits: job.reserved_credits,
    actual_credits: job.actual_credits,
    error_code: mapStudioErrorCode(job.error_code),
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    cancellable: job.status === 'queued' || job.status === 'running',
  };
}

function publicEvent(event: StudioJobEvent, jobId: string): OpenOpcImageJobEvent {
  if (event.job_id !== jobId) throw new Error('event scope mismatch');
  const progress = finiteNumber(event.payload.progress, 0, 1);
  const retryAfterMs = boundedInteger(event.payload.retry_after_ms, 0, 24 * 60 * 60 * 1000, -1);
  const assetIds = eventAssetIds(event.payload);
  if (event.type === 'progress' && progress === null) throw new Error('progress missing');
  if (event.type === 'asset-created' && assetIds.length === 0) throw new Error('asset missing');
  return {
    event_id: event.event_id,
    job_id: event.job_id,
    cursor: event.cursor,
    type: event.type,
    ...(progress !== null ? { progress } : {}),
    ...(retryAfterMs >= 0 ? { retry_after_ms: retryAfterMs } : {}),
    ...(assetIds.length > 0 ? { asset_ids: assetIds } : {}),
    created_at: event.created_at,
  };
}

function publicAsset(
  asset: StudioAsset,
  context: {
    prompt: string | null;
    retention: 'temporary' | 'retained';
    expiresAt: string | null;
    deletable: boolean;
    metadata: Record<string, unknown>;
  },
): OpenOpcImageAsset {
  if (
    asset.kind !== 'image' ||
    !STUDIO_IMAGE_MIME_TYPES.includes(
      asset.mime_type as (typeof STUDIO_IMAGE_MIME_TYPES)[number],
    ) ||
    !/^[a-f0-9]{64}$/.test(asset.checksum_sha256) ||
    !Number.isSafeInteger(asset.size_bytes) ||
    asset.size_bytes <= 0 ||
    asset.size_bytes > OPENOPC_IMAGE_ASSET_MAX_BYTES
  ) {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
  return {
    asset_id: asset.asset_id,
    source: { job_id: asset.source_job_id, prompt: context.prompt },
    kind: 'image',
    mime_type: asset.mime_type as OpenOpcImageAsset['mime_type'],
    checksum_sha256: asset.checksum_sha256,
    size_bytes: asset.size_bytes,
    width: asset.width,
    height: asset.height,
    metadata: context.metadata,
    retention: {
      policy: context.retention,
      expires_at: context.expiresAt,
      deletable: context.deletable,
    },
    created_at: asset.created_at,
  };
}

function mapStudioErrorCode(code: StudioErrorCode | null): OpenOpcImageErrorCode | null {
  if (code === null) return null;
  const mapping: Record<StudioErrorCode, OpenOpcImageErrorCode> = {
    STUDIO_VALIDATION_ERROR: 'OPENOPC_IMAGE_VALIDATION_ERROR',
    STUDIO_PERMISSION_DENIED: 'OPENOPC_IMAGE_INTERNAL_ERROR',
    STUDIO_INSUFFICIENT_CREDITS: 'OPENOPC_IMAGE_INSUFFICIENT_CREDITS',
    STUDIO_CREDENTIAL_MISSING: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_CREDENTIAL_EXPIRED: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_CREDENTIAL_UNAVAILABLE: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_MODEL_UNSUPPORTED: 'OPENOPC_IMAGE_MODEL_UNAVAILABLE',
    STUDIO_ESTIMATE_EXPIRED: 'OPENOPC_IMAGE_ESTIMATE_EXPIRED',
    STUDIO_IDEMPOTENCY_MISMATCH: 'OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH',
    STUDIO_PROVIDER_UNAVAILABLE: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_PROVIDER_CONFIG_INVALID: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_PROVIDER_CONFIG_STALE: 'OPENOPC_IMAGE_ESTIMATE_INVALID',
    STUDIO_PROVIDER_RATE_LIMITED: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_PROVIDER_REJECTED: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_PROVIDER_TIMEOUT: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_SUBMISSION_OUTCOME_UNKNOWN: 'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED',
    STUDIO_SUBMISSION_CONFIRMED_NOT_CREATED: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_SUBMISSION_OUTCOME_UNRESOLVED_EXPIRED: 'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED',
    STUDIO_PRICING_STALE: 'OPENOPC_IMAGE_ESTIMATE_INVALID',
    STUDIO_ASSET_INVALID: 'OPENOPC_IMAGE_ASSET_INVALID',
    STUDIO_ASSET_TOO_LARGE: 'OPENOPC_IMAGE_ASSET_TOO_LARGE',
    STUDIO_UPLOAD_EXPIRED: 'OPENOPC_IMAGE_ASSET_INVALID',
    STUDIO_STORAGE_UNAVAILABLE: 'OPENOPC_IMAGE_STORAGE_UNAVAILABLE',
    STUDIO_JOB_CONFLICT: 'OPENOPC_IMAGE_INTERNAL_ERROR',
    STUDIO_RECOVERY_CONFLICT: 'OPENOPC_IMAGE_INTERNAL_ERROR',
    STUDIO_BILLING_INCIDENT_REQUIRED: 'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED',
    STUDIO_JOB_NOT_CANCELLABLE: 'OPENOPC_IMAGE_JOB_NOT_CANCELLABLE',
    STUDIO_WEBHOOK_SIGNATURE_INVALID: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_WEBHOOK_REPLAYED: 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE',
    STUDIO_EVENT_CURSOR_EXPIRED: 'OPENOPC_IMAGE_EVENT_CURSOR_EXPIRED',
    STUDIO_MODULE_SERVICE_GRANT_INVALID: 'OPENOPC_IMAGE_INTERNAL_ERROR',
    STUDIO_INTERNAL_ERROR: 'OPENOPC_IMAGE_INTERNAL_ERROR',
  };
  return mapping[code];
}

function estimateResolutionError(code: StudioErrorCode, status: number): ModuleImageError {
  switch (code) {
    case 'STUDIO_VALIDATION_ERROR':
      return new ModuleImageError('OPENOPC_IMAGE_VALIDATION_ERROR', 400);
    case 'STUDIO_MODEL_UNSUPPORTED':
      return new ModuleImageError('OPENOPC_IMAGE_MODEL_UNAVAILABLE', 400);
    case 'STUDIO_ASSET_INVALID':
      return new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
    case 'STUDIO_ASSET_TOO_LARGE':
      return new ModuleImageError('OPENOPC_IMAGE_ASSET_TOO_LARGE', 413);
    case 'STUDIO_CREDENTIAL_MISSING':
    case 'STUDIO_CREDENTIAL_EXPIRED':
    case 'STUDIO_CREDENTIAL_UNAVAILABLE':
    case 'STUDIO_PROVIDER_UNAVAILABLE':
    case 'STUDIO_PROVIDER_CONFIG_INVALID':
      return new ModuleImageError('OPENOPC_IMAGE_PROVIDER_UNAVAILABLE', status === 404 ? 404 : 503);
    case 'STUDIO_PROVIDER_CONFIG_STALE':
    case 'STUDIO_PRICING_STALE':
      return new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INVALID', 409);
    default:
      return new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
  }
}

function repositoryError(code: StudioErrorCode): ModuleImageError {
  if (code === 'STUDIO_INSUFFICIENT_CREDITS') {
    return new ModuleImageError('OPENOPC_IMAGE_INSUFFICIENT_CREDITS', 402);
  }
  if (code === 'STUDIO_MODULE_SERVICE_GRANT_INVALID') {
    return new ModuleImageError('MODULE_SERVICE_CAPABILITY_REVOKED', 403);
  }
  if (code === 'STUDIO_PROVIDER_CONFIG_STALE' || code === 'STUDIO_PRICING_STALE') {
    return new ModuleImageError('OPENOPC_IMAGE_ESTIMATE_INVALID', 409);
  }
  return new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
}

function storageError(error: unknown): ModuleImageError {
  if (error instanceof ModuleImageError) return error;
  if (error instanceof StudioStorageUnavailableError) {
    return new ModuleImageError('OPENOPC_IMAGE_STORAGE_UNAVAILABLE', 503);
  }
  if (error instanceof StudioStorageServiceError) {
    if (error.code === 'STUDIO_ASSET_TOO_LARGE') {
      return new ModuleImageError('OPENOPC_IMAGE_ASSET_TOO_LARGE', 413);
    }
    return new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
  return new ModuleImageError('OPENOPC_IMAGE_INTERNAL_ERROR', 500);
}

function eventAssetIds(payload: Record<string, unknown>): string[] {
  const values = Array.isArray(payload.asset_ids)
    ? payload.asset_ids
    : typeof payload.asset_id === 'string'
      ? [payload.asset_id]
      : [];
  const ids = values.filter(
    (value): value is string =>
      typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value),
  );
  return [...new Set(ids)].slice(0, 8);
}

function assetFilename(asset: StudioAsset): string {
  const stored = asset.metadata[MODULE_FILENAME_METADATA];
  if (typeof stored === 'string' && stored.trim() && stored.length <= 255) return stored;
  const extension =
    asset.mime_type === 'image/png' ? 'png' : asset.mime_type === 'image/webp' ? 'webp' : 'jpg';
  return `${asset.asset_id}.${extension}`;
}

function serializeUserMetadata(value: Record<string, unknown>): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_USER_METADATA_BYTES) {
    throw new ModuleImageError('OPENOPC_IMAGE_ASSET_INVALID', 400);
  }
  return serialized;
}

function parseUserMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_USER_METADATA_BYTES) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

function studioCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
