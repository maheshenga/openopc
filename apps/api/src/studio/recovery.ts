import type {
  StudioErrorCode,
  StudioRecoveryRequest,
  StudioRecoveryResponse,
} from '@kortix/api-contract';
import {
  addStudioCreditAmounts,
  calculateStudioImageUsageCredits,
  parseStudioStagingManifest,
  StudioObjectStoreError,
  type StudioObjectMetadata,
  type StudioObjectStore,
  type StudioPricingSnapshot,
  studioStagingManifestKey,
  studioStagingPrefix,
  studioSubmissionKeyHash,
  StudioStorageUnavailableError,
} from '@kortix/studio-runtime';
import { canonicalStudioRequestHash } from '../../../../packages/studio-runtime/src/idempotency';
import type { StudioTelemetry } from './metrics';

const MAX_MANIFEST_BYTES = 1024 * 1024;

export class StudioRecoveryServiceError extends Error {
  constructor(
    readonly code: StudioErrorCode,
    readonly status: 400 | 404 | 409 | 500 | 503,
  ) {
    super(code);
    this.name = 'StudioRecoveryServiceError';
  }
}

export type StudioRecoveryLockedContext = {
  account_id: string;
  project_id: string;
  job_id: string;
  attempt_id: string;
  job_status: string;
  attempt_status: string;
  reservation_status: string;
  reservation_created_at: string;
  reservation_expires_at: string;
  job_available_at: string | null;
  cancellation_requested_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  submission_key: string;
  provider_request_id: string | null;
  provider_config_id: string;
  provider_config_version: string;
  attempt_provider_config_version: string;
  pricing_catalog_id: string;
  pricing_version: number;
  pricing_snapshot: StudioPricingSnapshot;
  staging_manifest_key: string | null;
  staging_manifest_checksum: string | null;
  current_attempt_usage: Record<string, unknown>;
  current_attempt_cost_credits: number | null;
  current_attempt_cost_recorded_at: string | null;
  current_attempt_cost_outcome: string | null;
  verified_attempt_cost_total: number;
};

export type StudioRecoveryPreparedInput = {
  evidence: Record<string, unknown>;
  result_assets: Array<Record<string, unknown>> | null;
  actual_credits: number | null;
  keep_unknown_until: string | null;
};

export type StudioRecoveryRepositoryInput = {
  account_id: string;
  project_id: string;
  job_id: string;
  actor_user_id: string;
  actor_type: 'user' | 'agent' | 'system';
  acting_token_id: string | null;
  decision: StudioRecoveryRequest['decision'];
  idempotency_key: string;
  request_hash: string;
  reason: string;
  recovered_at: string;
};

export interface StudioRecoveryRepository {
  recoverLocked(
    input: StudioRecoveryRepositoryInput,
    prepare: (context: StudioRecoveryLockedContext) => Promise<StudioRecoveryPreparedInput>,
  ): Promise<StudioRecoveryResponse>;
}

export class StudioRecoveryService {
  constructor(
    private readonly input: {
      repository: StudioRecoveryRepository;
      store: StudioObjectStore;
      now?: () => Date;
      telemetry?: StudioTelemetry;
    },
  ) {}

  async recover(input: {
    accountId: string;
    projectId: string;
    jobId: string;
    actorUserId: string;
    actorType: 'user' | 'agent' | 'system';
    actingTokenId: string | null;
    request: StudioRecoveryRequest;
  }): Promise<StudioRecoveryResponse> {
    const recoveredAt = (this.input.now ?? (() => new Date()))();
    const request = input.request;
    let prepared = false;
    try {
      const result = await this.input.repository.recoverLocked(
        {
          account_id: input.accountId,
          project_id: input.projectId,
          job_id: input.jobId,
          actor_user_id: input.actorUserId,
          actor_type: input.actorType,
          acting_token_id: input.actingTokenId,
          decision: request.decision,
          idempotency_key: request.idempotency_key,
          request_hash: canonicalStudioRequestHash({
            decision: request.decision,
            reason: request.reason,
            evidence: request.evidence,
          }),
          reason: request.reason,
          recovered_at: recoveredAt.toISOString(),
        },
        async (context) => {
          prepared = true;
          if (
            request.evidence.provider_request_id !== undefined &&
            request.evidence.provider_request_id !== context.provider_request_id
          ) {
            throw invalidEvidence();
          }
          if (request.decision === 'confirm_succeeded') {
            return this.prepareConfirmedSuccess(
              context,
              request as StudioRecoveryRequest & { decision: 'confirm_succeeded' },
            );
          }
          if (request.decision === 'keep_unknown') {
            return {
              evidence: request.evidence,
              result_assets: null,
              actual_credits: null,
              keep_unknown_until: keepUnknownUntil(context, recoveredAt),
            };
          }
          return {
            evidence: request.evidence,
            result_assets: null,
            actual_credits: null,
            keep_unknown_until: null,
          };
        },
      );
      this.emitRecoveryDecision(request.decision, prepared ? 'applied' : 'replayed');
      return result;
    } catch (error) {
      this.emitRecoveryDecision(request.decision, 'rejected');
      throw error;
    }
  }

  private emitRecoveryDecision(
    decision: StudioRecoveryRequest['decision'],
    outcome: 'applied' | 'replayed' | 'rejected',
  ): void {
    try {
      this.input.telemetry?.recoveryDecision({ decision, outcome });
    } catch {
      // Telemetry must never change recovery semantics.
    }
  }

  private async prepareConfirmedSuccess(
    context: StudioRecoveryLockedContext,
    request: StudioRecoveryRequest & { decision: 'confirm_succeeded' },
  ): Promise<StudioRecoveryPreparedInput> {
    const manifestKey = request.evidence.staging_manifest_key;
    const manifestChecksum = request.evidence.staging_manifest_checksum;
    const submissionHash = studioSubmissionKeyHash(context.submission_key);
    const stagingIdentity = {
      accountId: context.account_id,
      projectId: context.project_id,
      jobId: context.job_id,
      attemptId: context.attempt_id,
      submissionKeyHash: submissionHash,
    };
    const prefix = studioStagingPrefix(stagingIdentity);
    const expectedManifestKey = studioStagingManifestKey(stagingIdentity);
    if (
      !manifestKey ||
      !manifestChecksum ||
      manifestKey !== expectedManifestKey ||
      manifestKey !== context.staging_manifest_key ||
      manifestChecksum !== context.staging_manifest_checksum
    ) {
      throw invalidEvidence();
    }

    await this.assertStoreReady();
    const manifestHead = await this.headObject(manifestKey);
    if (
      !matchesObjectIdentity(this.input.store, manifestHead, manifestKey) ||
      manifestHead.content_type !== 'application/json' ||
      manifestHead.checksum_sha256 !== manifestChecksum ||
      !Number.isSafeInteger(manifestHead.size_bytes) ||
      manifestHead.size_bytes <= 0 ||
      manifestHead.size_bytes > MAX_MANIFEST_BYTES ||
      !matchesRequiredEncryption(this.input.store, manifestHead)
    ) {
      throw invalidEvidence();
    }

    let storedManifest: Awaited<ReturnType<StudioObjectStore['getObject']>>;
    try {
      storedManifest = await this.input.store.getObject({ key: manifestKey });
    } catch (error) {
      throw storageReadError(error);
    }
    if (
      !matchesObjectIdentity(this.input.store, storedManifest, manifestKey) ||
      storedManifest.content_type !== manifestHead.content_type ||
      storedManifest.size_bytes !== manifestHead.size_bytes ||
      storedManifest.checksum_sha256 !== manifestHead.checksum_sha256 ||
      !matchesRequiredEncryption(this.input.store, storedManifest)
    ) {
      throw invalidEvidence();
    }
    const manifestBytes = await readBoundedBody(storedManifest.body, manifestHead.size_bytes);
    if (new Bun.CryptoHasher('sha256').update(manifestBytes).digest('hex') !== manifestChecksum) {
      throw invalidEvidence();
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    } catch {
      throw invalidEvidence();
    }
    let manifest: ReturnType<typeof parseStudioStagingManifest>;
    try {
      manifest = parseStudioStagingManifest(decoded);
    } catch {
      throw invalidEvidence();
    }
    if (
      manifest.account_id !== context.account_id ||
      manifest.project_id !== context.project_id ||
      manifest.job_id !== context.job_id ||
      manifest.attempt_id !== context.attempt_id ||
      manifest.submission_key_hash !== submissionHash ||
      manifest.provider_config_id !== context.provider_config_id ||
      manifest.provider_config_version !== context.provider_config_version ||
      manifest.provider_config_version !== context.attempt_provider_config_version ||
      manifest.pricing_catalog_id !== context.pricing_catalog_id ||
      manifest.pricing_version !== context.pricing_version ||
      context.pricing_snapshot.pricing_catalog_id !== context.pricing_catalog_id ||
      context.pricing_snapshot.version !== context.pricing_version
    ) {
      throw invalidEvidence();
    }
    if (
      Object.keys(manifest.usage).some((key) => key !== 'output_count') ||
      (manifest.usage.output_count !== undefined &&
        manifest.usage.output_count !== manifest.assets.length)
    ) {
      throw invalidEvidence();
    }
    const uniqueKeys = new Set<string>();
    for (const asset of manifest.assets) {
      if (
        asset.key === manifestKey ||
        !safeObjectKeyUnderPrefix(asset.key, prefix) ||
        uniqueKeys.has(asset.key)
      ) {
        throw invalidEvidence();
      }
      uniqueKeys.add(asset.key);
      const head = await this.headObject(asset.key);
      if (
        !matchesObjectIdentity(this.input.store, head, asset.key) ||
        head.content_type !== asset.mime_type ||
        head.size_bytes !== asset.size_bytes ||
        head.checksum_sha256 !== asset.checksum_sha256 ||
        !matchesRequiredEncryption(this.input.store, head)
      ) {
        throw invalidEvidence();
      }
    }

    let priced: ReturnType<typeof calculateStudioImageUsageCredits>;
    try {
      priced = calculateStudioImageUsageCredits({
        pricing: context.pricing_snapshot,
        outputCount: manifest.assets.length,
      });
    } catch {
      throw invalidEvidence();
    }
    let verifiedProviderCredits: number;
    try {
      if (context.current_attempt_cost_recorded_at) {
        if (
          context.current_attempt_cost_outcome !== 'unknown' ||
          context.current_attempt_cost_credits !== priced.upstream_cost_credits ||
          canonicalStudioRequestHash(context.current_attempt_usage) !==
            canonicalStudioRequestHash(priced.usage)
        ) {
          throw invalidEvidence();
        }
        verifiedProviderCredits = context.verified_attempt_cost_total;
      } else {
        if (context.current_attempt_cost_credits !== null) throw invalidEvidence();
        verifiedProviderCredits = addStudioCreditAmounts([
          context.verified_attempt_cost_total,
          priced.upstream_cost_credits,
        ]);
      }
    } catch (error) {
      if (error instanceof StudioRecoveryServiceError) throw error;
      throw invalidEvidence();
    }
    return {
      evidence: {
        ...request.evidence,
        upstream_usage: priced.usage,
        upstream_cost_credits: priced.upstream_cost_credits,
      },
      result_assets: manifest.assets.map((asset) => ({
        kind: asset.kind,
        filename: asset.filename,
        mimeType: asset.mime_type,
        bucket: this.input.store.namespace,
        objectKey: asset.key,
        checksumSha256: asset.checksum_sha256,
        sizeBytes: asset.size_bytes,
      })),
      actual_credits: addStudioCreditAmounts([
        verifiedProviderCredits,
        priced.output_markup_credits,
      ]),
      keep_unknown_until: null,
    };
  }

  private async assertStoreReady(): Promise<void> {
    try {
      await this.input.store.assertReady();
    } catch {
      throw new StudioRecoveryServiceError('STUDIO_STORAGE_UNAVAILABLE', 503);
    }
  }

  private async headObject(key: string): Promise<StudioObjectMetadata> {
    try {
      return await this.input.store.headObject({ key });
    } catch (error) {
      throw storageReadError(error);
    }
  }
}

function keepUnknownUntil(context: StudioRecoveryLockedContext, recoveredAt: Date): string {
  const cumulativeCap = Date.parse(context.reservation_created_at) + 30 * 24 * 60 * 60_000;
  const requestCap = recoveredAt.getTime() + 24 * 60 * 60_000;
  if (!Number.isFinite(cumulativeCap) || !Number.isFinite(requestCap)) {
    throw new Error('Studio recovery hold time is invalid');
  }
  return new Date(Math.min(cumulativeCap, requestCap)).toISOString();
}

function safeObjectKeyUnderPrefix(key: string, prefix: string): boolean {
  if (!key.startsWith(prefix) || key.length <= prefix.length || key.includes('\\')) return false;
  return key.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function matchesRequiredEncryption(
  store: StudioObjectStore,
  metadata: StudioObjectMetadata,
): boolean {
  const required = store.required_server_side_encryption;
  if (!required || metadata.server_side_encryption !== required) return false;
  return required === 'aws:kms'
    ? !!store.required_sse_kms_key_id &&
        metadata.sse_kms_key_id === store.required_sse_kms_key_id
    : metadata.sse_kms_key_id === null;
}

function matchesObjectIdentity(
  store: StudioObjectStore,
  metadata: StudioObjectMetadata,
  key: string,
): boolean {
  return metadata.namespace === store.namespace && metadata.key === key;
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  expectedSize: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > expectedSize || size > MAX_MANIFEST_BYTES) {
        await reader.cancel();
        throw invalidEvidence();
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof StudioRecoveryServiceError) throw error;
    throw new StudioRecoveryServiceError('STUDIO_STORAGE_UNAVAILABLE', 503);
  } finally {
    reader.releaseLock();
  }
  if (size !== expectedSize) throw invalidEvidence();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function invalidEvidence(): StudioRecoveryServiceError {
  return new StudioRecoveryServiceError('STUDIO_ASSET_INVALID', 400);
}

function storageReadError(error: unknown): StudioRecoveryServiceError {
  if (error instanceof StudioObjectStoreError && error.code === 'NOT_FOUND') {
    return invalidEvidence();
  }
  if (error instanceof StudioRecoveryServiceError) return error;
  if (error instanceof StudioStorageUnavailableError || error instanceof StudioObjectStoreError) {
    return new StudioRecoveryServiceError('STUDIO_STORAGE_UNAVAILABLE', 503);
  }
  return new StudioRecoveryServiceError('STUDIO_STORAGE_UNAVAILABLE', 503);
}
