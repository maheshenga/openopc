import type {
  StudioAsset,
  StudioJob,
  StudioJobEvent,
  StudioPricingCatalogEntry,
} from '@kortix/api-contract';
import { toStudioProviderConfigWire } from '../providers';
import { StudioRepositoryError } from '../types';
import type {
  StudioCreateJobInput,
  StudioCreateJobResult,
  StudioPendingUploadRecord,
  StudioProductionJobBinding,
  StudioProviderConfigRecord,
  StudioProviderConfigWire,
  StudioRepository,
} from '../types';

type MemoryStudioRepositoryInput = {
  providers?: StudioProviderConfigWire[];
  pricing?: StudioPricingCatalogEntry[];
  now?: () => string;
};

function isoNow() {
  return new Date().toISOString();
}

export function createMemoryStudioRepository(
  input: MemoryStudioRepositoryInput = {},
): StudioRepository {
  const providers = new Map(
    input.providers?.map((provider) => [provider.provider_config_id, provider]) ?? [],
  );
  const pricing = new Map(input.pricing?.map((entry) => [entry.pricing_catalog_id, entry]) ?? []);
  const providerRecords = new Map<string, StudioProviderConfigRecord>();
  const jobs = new Map<string, StudioJob>();
  const events = new Map<string, StudioJobEvent[]>();
  const uploads = new Map<string, StudioPendingUploadRecord>();
  const assets = new Map<string, StudioAsset>();
  const now = input.now ?? isoNow;

  const appendEvent = (
    jobId: string,
    type: StudioJobEvent['type'],
    payload: Record<string, unknown>,
  ) => {
    const list = events.get(jobId) ?? [];
    const cursor = String(list.length + 1);
    list.push({
      event_id: crypto.randomUUID(),
      job_id: jobId,
      cursor,
      type,
      payload,
      created_at: now(),
    });
    events.set(jobId, list);
  };

  return {
    async listPricing(accountId) {
      return [...pricing.values()].filter((entry) => entry.account_id === accountId);
    },

    async getActivePricing(accountId, pricingCatalogId) {
      const entry = pricing.get(pricingCatalogId);
      return entry?.account_id === accountId && entry.active ? entry : null;
    },

    async createPricingVersion({ account_id, created_by_user_id, request }) {
      const version =
        Math.max(
          0,
          ...[...pricing.values()]
            .filter(
              (entry) =>
                entry.account_id === account_id &&
                entry.provider === request.provider &&
                entry.model === request.model,
            )
            .map((entry) => entry.version),
        ) + 1;
      const entry: StudioPricingCatalogEntry = {
        pricing_catalog_id: crypto.randomUUID(),
        account_id,
        ...request,
        version,
        active: true,
        created_by_user_id,
        created_at: now(),
      };
      pricing.set(entry.pricing_catalog_id, entry);
      return entry;
    },

    async deactivatePricing(accountId, pricingCatalogId) {
      const entry = pricing.get(pricingCatalogId);
      if (!entry || entry.account_id !== accountId) return null;
      if (!entry.active) return entry;
      const deactivated = { ...entry, active: false };
      pricing.set(pricingCatalogId, deactivated);
      return deactivated;
    },

    async createProviderConfig(provider, pricingReferences) {
      const pricesValid = pricingReferences.every((reference) => {
        const entry = pricing.get(reference.pricing_catalog_id);
        return (
          entry?.active === true &&
          entry.account_id === provider.account_id &&
          entry.provider === reference.provider &&
          entry.model === reference.model
        );
      });
      if (!pricesValid) return { ok: false as const, code: 'pricing_invalid' as const };
      const createdAt = now();
      const record: StudioProviderConfigRecord = {
        ...provider,
        provider_config_id: crypto.randomUUID(),
        version_token: `memory:${crypto.randomUUID()}`,
        created_at: createdAt,
        updated_at: createdAt,
      };
      providerRecords.set(record.provider_config_id, record);
      return { ok: true as const, value: record };
    },

    async getProviderConfigRecord(accountId, projectId, providerConfigId) {
      const record = providerRecords.get(providerConfigId);
      return record?.account_id === accountId && record.project_id === projectId ? record : null;
    },

    async updateProviderConfig(candidate, expectedVersionToken, pricingReferences, patch) {
      const current = providerRecords.get(candidate.provider_config_id);
      if (
        !current ||
        current.account_id !== candidate.account_id ||
        current.project_id !== candidate.project_id
      ) {
        return { ok: false as const, code: 'not_found' as const };
      }
      if (current.version_token !== expectedVersionToken) {
        return { ok: false as const, code: 'stale' as const };
      }
      const pricesValid = pricingReferences.every((reference) => {
        const entry = pricing.get(reference.pricing_catalog_id);
        return (
          entry?.active === true &&
          entry.account_id === candidate.account_id &&
          entry.provider === reference.provider &&
          entry.model === reference.model
        );
      });
      if (!pricesValid) return { ok: false as const, code: 'pricing_invalid' as const };
      const operationalChange =
        patch.base_url !== undefined ||
        patch.region !== undefined ||
        patch.credential_binding !== undefined ||
        patch.capability_map !== undefined ||
        patch.enabled !== undefined;
      const updated: StudioProviderConfigRecord = {
        ...current,
        ...(patch.display_name !== undefined ? { display_name: candidate.display_name } : {}),
        ...(patch.base_url !== undefined ? { base_url: candidate.base_url } : {}),
        ...(patch.region !== undefined ? { region: candidate.region } : {}),
        ...(patch.credential_binding !== undefined
          ? { credential_binding: candidate.credential_binding }
          : {}),
        ...(patch.capability_map !== undefined ? { capability_map: candidate.capability_map } : {}),
        ...(patch.enabled !== undefined ? { enabled: candidate.enabled } : {}),
        version_token: operationalChange ? `memory:${crypto.randomUUID()}` : current.version_token,
        updated_at: now(),
      };
      providerRecords.set(updated.provider_config_id, updated);
      return { ok: true as const, value: updated };
    },

    async disableProviderConfig(accountId, projectId, providerConfigId) {
      const current = providerRecords.get(providerConfigId);
      if (!current || current.account_id !== accountId || current.project_id !== projectId) {
        return { ok: false as const, code: 'not_found' as const };
      }
      if (!current.enabled) return { ok: true as const, value: current };
      const updated: StudioProviderConfigRecord = {
        ...current,
        enabled: false,
        version_token: `memory:${crypto.randomUUID()}`,
        updated_at: now(),
      };
      providerRecords.set(providerConfigId, updated);
      return { ok: true as const, value: updated };
    },

    async listProviders(projectId) {
      return [
        ...[...providers.values()].filter(
          (provider) => provider.project_id === projectId && provider.enabled,
        ),
        ...[...providerRecords.values()]
          .filter((provider) => provider.project_id === projectId && provider.enabled)
          .map(toStudioProviderConfigWire),
      ];
    },

    async getProvider(projectId, providerConfigId) {
      const provider = providers.get(providerConfigId);
      if (provider?.project_id === projectId && provider.enabled) return provider;
      const record = providerRecords.get(providerConfigId);
      return record?.project_id === projectId && record.enabled
        ? toStudioProviderConfigWire(record)
        : null;
    },

    async createJob(input, provider, estimate, productionBinding): Promise<StudioCreateJobResult> {
      const existing = [...jobs.values()].find(
        (job) =>
          job.account_id === input.account_id && job.idempotency_key === input.idempotency_key,
      );
      if (existing) {
        if (
          existing.project_id !== input.project_id ||
          existing.request_hash !== input.request_hash ||
          (existing.module_service_grant_id ?? null) !== (input.module_service_grant_id ?? null)
        ) {
          return { created: false, mismatch: true };
        }
        return {
          job: existing,
          created: false,
        };
      }

      if (productionBinding) {
        assertCurrentProductionBinding(input, providerRecords, pricing, productionBinding);
      }

      const createdAt = now();
      const job: StudioJob = {
        job_id: crypto.randomUUID(),
        account_id: input.account_id,
        project_id: input.project_id,
        actor_user_id: input.actor_user_id,
        actor_type: input.actor_type,
        module_service_grant_id: input.module_service_grant_id ?? null,
        capability: input.capability,
        provider_config_id: input.provider_config_id,
        provider: provider.provider,
        model: input.model,
        input: input.input,
        status: 'queued',
        idempotency_key: input.idempotency_key,
        request_hash: input.request_hash,
        attempt_count: 0,
        reserved_credits: estimate.max_approved_credits,
        actual_credits: null,
        error_code: null,
        error_message: null,
        created_at: createdAt,
        updated_at: createdAt,
        started_at: null,
        completed_at: null,
      };
      jobs.set(job.job_id, job);
      appendEvent(job.job_id, 'queued', {
        capability: job.capability,
        provider_config_id: job.provider_config_id,
        model: job.model,
      });
      return { job, created: true };
    },

    async findJobByIdempotency(accountId, idempotencyKey) {
      return (
        [...jobs.values()].find(
          (job) => job.account_id === accountId && job.idempotency_key === idempotencyKey,
        ) ?? null
      );
    },

    async listJobs(projectId, limit, cursor) {
      const after = cursor ? Number(cursor) : 0;
      const all = [...jobs.values()]
        .filter((job) => job.project_id === projectId)
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const page = all.slice(after, after + limit);
      const next = after + page.length < all.length ? String(after + page.length) : null;
      return { items: page, next_cursor: next };
    },

    async getJob(projectId, jobId) {
      const job = jobs.get(jobId);
      return job?.project_id === projectId ? job : null;
    },

    async requestCancellation(projectId, jobId) {
      const job = jobs.get(jobId);
      if (!job || job.project_id !== projectId || !['queued', 'running'].includes(job.status))
        return null;
      if (job.status === 'running') {
        const updated = { ...job, updated_at: now() };
        jobs.set(jobId, updated);
        return updated;
      }
      const updated: StudioJob = {
        ...job,
        status: 'cancelled',
        updated_at: now(),
        completed_at: now(),
      };
      jobs.set(jobId, updated);
      appendEvent(jobId, 'cancelled', { reason: 'user_cancelled' });
      return updated;
    },

    async listEvents(projectId, jobId, afterCursor) {
      const job = jobs.get(jobId);
      if (!job || job.project_id !== projectId) return { items: [], next_cursor: null };
      const after = afterCursor ? Number(afterCursor) : 0;
      const page = (events.get(jobId) ?? []).filter((event) => Number(event.cursor) > after);
      return { items: page, next_cursor: null };
    },

    async createPendingUpload(input) {
      const record: StudioPendingUploadRecord = {
        upload_id: input.upload_id,
        account_id: input.account_id,
        project_id: input.project_id,
        actor_user_id: input.actor_user_id,
        asset_id: null,
        object_key: input.object_key,
        declared_mime_type: input.declared_mime_type,
        expected_size_bytes: input.expected_size_bytes,
        expected_checksum_sha256: input.expected_checksum_sha256,
        expires_at: input.expires_at,
        status: 'pending',
      };
      uploads.set(record.upload_id, record);
      return record;
    },

    async getUploadRecord(accountId, projectId, uploadId) {
      const upload = uploads.get(uploadId);
      if (!upload || upload.account_id !== accountId || upload.project_id !== projectId) {
        return null;
      }
      return upload;
    },

    async finalizeUploadRecord(input) {
      const upload = uploads.get(input.upload_id);
      if (
        !upload ||
        upload.account_id !== input.account_id ||
        upload.project_id !== input.project_id ||
        upload.object_key !== input.object_key
      ) {
        return { outcome: 'not_found' as const };
      }
      if (upload.status === 'finalized' && upload.asset_id) {
        const asset = assets.get(upload.asset_id);
        return asset ? { outcome: 'finalized' as const, asset } : { outcome: 'not_found' as const };
      }
      if (upload.status !== 'pending') return { outcome: 'not_found' as const };
      const expiresAt = Date.parse(upload.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(now())) {
        return { outcome: 'expired' as const };
      }
      if (
        upload.declared_mime_type !== input.mime_type ||
        upload.expected_size_bytes !== input.size_bytes ||
        upload.expected_checksum_sha256 !== input.checksum_sha256
      ) {
        return { outcome: 'mismatch' as const };
      }
      const assetId = crypto.randomUUID();
      const asset: StudioAsset = {
        asset_id: assetId,
        account_id: upload.account_id,
        project_id: upload.project_id,
        source_job_id: null,
        kind: 'image',
        mime_type: input.mime_type,
        bucket: input.bucket,
        object_key: upload.object_key,
        checksum_sha256: input.checksum_sha256,
        size_bytes: input.size_bytes,
        width: input.width,
        height: input.height,
        metadata: input.metadata,
        created_at: now(),
      };
      assets.set(assetId, asset);
      uploads.set(input.upload_id, {
        ...upload,
        asset_id: assetId,
        status: 'finalized',
      });
      return { outcome: 'finalized' as const, asset };
    },

    async listAssets(projectId, limit, cursor, filter) {
      const after = cursor ? Number(cursor) : 0;
      const all = [...assets.values()]
        .filter((asset) => asset.project_id === projectId)
        .filter(
          (asset) =>
            filter?.source_job_id === undefined || asset.source_job_id === filter.source_job_id,
        )
        .filter(
          (asset) =>
            filter?.source === undefined ||
            (filter.source === 'generated'
              ? asset.source_job_id !== null
              : asset.source_job_id === null),
        )
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const page = all.slice(after, after + limit);
      return {
        items: page,
        next_cursor: after + page.length < all.length ? String(after + page.length) : null,
      };
    },

    async getAsset(projectId, assetId) {
      const asset = assets.get(assetId);
      return asset?.project_id === projectId ? asset : null;
    },

    async updateDirectAssetMetadata(input) {
      const asset = assets.get(input.asset_id);
      if (
        !asset ||
        asset.account_id !== input.account_id ||
        asset.project_id !== input.project_id ||
        asset.source_job_id !== null ||
        !metadataIncludes(asset.metadata, input.expected_metadata) ||
        Object.hasOwn(asset.metadata, input.forbidden_metadata_key)
      ) {
        return null;
      }
      const updated = { ...asset, metadata: { ...asset.metadata, ...input.metadata_patch } };
      assets.set(asset.asset_id, updated);
      return updated;
    },

    async requestDirectAssetDeletion(input) {
      const asset = assets.get(input.asset_id);
      if (
        !asset ||
        asset.account_id !== input.account_id ||
        asset.project_id !== input.project_id ||
        asset.source_job_id !== null ||
        !metadataIncludes(asset.metadata, input.expected_metadata)
      ) {
        return { outcome: 'not_found' as const };
      }
      const alreadyRequested = metadataIncludes(asset.metadata, input.deletion_marker);
      if (
        !alreadyRequested &&
        [...jobs.values()].some(
          (job) =>
            job.account_id === input.account_id &&
            job.project_id === input.project_id &&
            (job.status === 'queued' || job.status === 'running') &&
            job.input.image.reference_asset_ids.includes(input.asset_id),
        )
      ) {
        return { outcome: 'in_use' as const };
      }
      const updated = alreadyRequested
        ? asset
        : { ...asset, metadata: { ...asset.metadata, ...input.deletion_metadata } };
      assets.set(asset.asset_id, updated);
      return { outcome: 'requested' as const, asset: updated };
    },

    async deleteRequestedDirectAsset(input) {
      const asset = assets.get(input.asset_id);
      if (
        !asset ||
        asset.account_id !== input.account_id ||
        asset.project_id !== input.project_id ||
        asset.source_job_id !== null ||
        asset.object_key !== input.object_key ||
        !metadataIncludes(asset.metadata, input.expected_metadata)
      ) {
        return false;
      }
      assets.delete(asset.asset_id);
      for (const [uploadId, upload] of uploads) {
        if (upload.asset_id === asset.asset_id)
          uploads.set(uploadId, { ...upload, asset_id: null });
      }
      return true;
    },
  };
}

function metadataIncludes(
  metadata: Record<string, unknown>,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(([key, value]) => metadata[key] === value);
}

function assertCurrentProductionBinding(
  input: StudioCreateJobInput,
  providerRecords: Map<string, StudioProviderConfigRecord>,
  pricing: Map<string, StudioPricingCatalogEntry>,
  binding: StudioProductionJobBinding,
): void {
  const provider = providerRecords.get(input.provider_config_id);
  if (
    !provider ||
    provider.account_id !== input.account_id ||
    provider.project_id !== input.project_id ||
    provider.enabled !== true ||
    provider.version_token !== binding.provider_config_version
  ) {
    throw new StudioRepositoryError(
      'STUDIO_PROVIDER_CONFIG_STALE',
      409,
      'Studio provider configuration is stale',
    );
  }
  const snapshot = binding.pricing_snapshot;
  const price = pricing.get(snapshot.pricing_catalog_id);
  const currentSnapshot =
    price?.active && price.account_id === input.account_id
      ? {
          pricing_catalog_id: price.pricing_catalog_id,
          version: price.version,
          provider: price.provider,
          model: price.model,
          unit: price.unit,
          rate_credits: price.rate_data.rate_credits,
          max_provider_credits: price.maximum_cost_rule.max_provider_credits,
          markup_credits: price.markup_rule.markup_credits,
        }
      : null;
  if (!currentSnapshot || JSON.stringify(currentSnapshot) !== JSON.stringify(snapshot)) {
    throw new StudioRepositoryError('STUDIO_PRICING_STALE', 409, 'Studio pricing is stale');
  }
}
