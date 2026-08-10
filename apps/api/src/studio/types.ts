import type {
  StudioAsset,
  StudioCreateJobRequest,
  StudioCreatePricingCatalogRequest,
  StudioCredentialBinding,
  StudioErrorCode,
  StudioEstimateResponse,
  StudioJob,
  StudioJobEvent,
  StudioPricingCatalogEntry,
  StudioProviderConfig,
  StudioUpdateProviderConfigRequest,
  StudioUpload,
} from '@kortix/api-contract';
import type { StudioPricingSnapshot, StudioProviderDefinitionConfig } from '@kortix/studio-runtime';

export type StudioLoadedProject = {
  row: {
    accountId: string;
    projectId: string;
  };
  userId: string;
};

export type StudioProviderConfigWire = StudioProviderConfig & {
  account_id: string;
};

export type StudioCreateJobInput = Omit<StudioCreateJobRequest, 'module_service_grant_id'> & {
  account_id: string;
  project_id: string;
  actor_user_id: string | null;
  actor_type: 'user' | 'agent' | 'system' | 'module';
  acting_token_id: string | null;
  module_service_grant_id?: string | null;
  agent_name: string | null;
  session_id: string | null;
  parent_job_id: string | null;
};

export type StudioCreateJobResult =
  | { job: StudioJob; created: boolean; mismatch?: false }
  | { created: false; mismatch: true };

export class StudioRepositoryError extends Error {
  constructor(
    readonly studioCode: StudioErrorCode,
    readonly httpStatus: 402 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'StudioRepositoryError';
  }
}

export function isStudioRepositoryError(
  error: unknown,
): error is Pick<StudioRepositoryError, 'studioCode' | 'httpStatus' | 'message'> {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  return (
    ((candidate.studioCode === 'STUDIO_INSUFFICIENT_CREDITS' && candidate.httpStatus === 402) ||
      ((candidate.studioCode === 'STUDIO_PROVIDER_CONFIG_STALE' ||
        candidate.studioCode === 'STUDIO_PRICING_STALE') &&
        candidate.httpStatus === 409) ||
      (candidate.studioCode === 'STUDIO_MODULE_SERVICE_GRANT_INVALID' &&
        candidate.httpStatus === 409)) &&
    typeof candidate.message === 'string'
  );
}

export type StudioCreateUploadInput = {
  account_id: string;
  project_id: string;
  actor_user_id: string | null;
  declared_mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  metadata: Record<string, unknown>;
};

export type StudioPendingUploadRecord = Omit<
  StudioUpload,
  'signed_upload_url' | 'signed_upload_headers'
> & {
  account_id: string;
  actor_user_id: string | null;
};

export type StudioCreatePendingUploadInput = Omit<StudioCreateUploadInput, 'metadata'> & {
  upload_id: string;
  object_key: string;
  expires_at: string;
};

export type StudioFinalizeUploadRecordInput = {
  account_id: string;
  project_id: string;
  upload_id: string;
  object_key: string;
  bucket: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
  checksum_sha256: string;
  size_bytes: number;
  width: number;
  height: number;
  metadata: Record<string, unknown>;
};

export type StudioFinalizeUploadRecordResult =
  | { outcome: 'finalized'; asset: StudioAsset }
  | { outcome: 'expired' | 'mismatch' | 'not_found' };

export type StudioDirectAssetMutationScope = {
  account_id: string;
  project_id: string;
  asset_id: string;
  expected_metadata: Record<string, string>;
};

export type StudioDirectAssetDeletionRequestResult =
  | { outcome: 'requested'; asset: StudioAsset }
  | { outcome: 'in_use' }
  | { outcome: 'not_found' };

export type StudioCreatePricingInput = {
  account_id: string;
  created_by_user_id: string;
  request: StudioCreatePricingCatalogRequest;
};

export interface StudioPricingRepository {
  listPricing(accountId: string): Promise<StudioPricingCatalogEntry[]>;
  getActivePricing(
    accountId: string,
    pricingCatalogId: string,
  ): Promise<StudioPricingCatalogEntry | null>;
  createPricingVersion(input: StudioCreatePricingInput): Promise<StudioPricingCatalogEntry>;
  deactivatePricing(
    accountId: string,
    pricingCatalogId: string,
  ): Promise<StudioPricingCatalogEntry | null>;
}

export type StudioProviderConfigRecord = StudioProviderDefinitionConfig & {
  account_id: string;
  project_id: string;
  display_name: string;
  credential_binding: StudioCredentialBinding;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export type StudioProviderPricingReference = {
  pricing_catalog_id: string;
  provider: string;
  model: string;
};

export type StudioProductionJobBinding = {
  provider_config_version: string;
  pricing_snapshot: StudioPricingSnapshot;
};

export type StudioCreateProviderConfigInput = Omit<
  StudioProviderConfigRecord,
  'provider_config_id' | 'version_token' | 'created_at' | 'updated_at'
>;

export type StudioProviderMutationResult =
  | { ok: true; value: StudioProviderConfigRecord }
  | { ok: false; code: 'not_found' | 'stale' | 'pricing_invalid' };

export interface StudioProviderConfigRepository {
  getProviderConfigRecord(
    accountId: string,
    projectId: string,
    providerConfigId: string,
  ): Promise<StudioProviderConfigRecord | null>;
  createProviderConfig(
    input: StudioCreateProviderConfigInput,
    pricingReferences: readonly StudioProviderPricingReference[],
  ): Promise<StudioProviderMutationResult>;
  updateProviderConfig(
    candidate: Omit<StudioProviderConfigRecord, 'version_token' | 'updated_at'>,
    expectedVersionToken: string,
    pricingReferences: readonly StudioProviderPricingReference[],
    patch: StudioUpdateProviderConfigRequest,
  ): Promise<StudioProviderMutationResult>;
  disableProviderConfig(
    accountId: string,
    projectId: string,
    providerConfigId: string,
  ): Promise<StudioProviderMutationResult>;
}

export interface StudioRepository extends StudioPricingRepository, StudioProviderConfigRepository {
  listProviders(projectId: string): Promise<StudioProviderConfigWire[]>;
  getProvider(
    projectId: string,
    providerConfigId: string,
  ): Promise<StudioProviderConfigWire | null>;
  createJob(
    input: StudioCreateJobInput,
    provider: StudioProviderConfigWire,
    estimate: StudioEstimateResponse,
    productionBinding?: StudioProductionJobBinding,
  ): Promise<StudioCreateJobResult>;
  findJobByIdempotency(accountId: string, idempotencyKey: string): Promise<StudioJob | null>;
  listJobs(
    projectId: string,
    limit: number,
    cursor?: string | null,
  ): Promise<{ items: StudioJob[]; next_cursor: string | null }>;
  getJob(projectId: string, jobId: string): Promise<StudioJob | null>;
  requestCancellation(projectId: string, jobId: string): Promise<StudioJob | null>;
  listEvents(
    projectId: string,
    jobId: string,
    afterCursor?: string | null,
  ): Promise<{ items: StudioJobEvent[]; next_cursor: string | null }>;
  createPendingUpload(input: StudioCreatePendingUploadInput): Promise<StudioPendingUploadRecord>;
  getUploadRecord(
    accountId: string,
    projectId: string,
    uploadId: string,
  ): Promise<StudioPendingUploadRecord | null>;
  finalizeUploadRecord(
    input: StudioFinalizeUploadRecordInput,
  ): Promise<StudioFinalizeUploadRecordResult>;
  listAssets(
    projectId: string,
    limit: number,
    cursor?: string | null,
    filter?: StudioAssetListFilter,
  ): Promise<{ items: StudioAsset[]; next_cursor: string | null }>;
  getAsset(projectId: string, assetId: string): Promise<StudioAsset | null>;
  updateDirectAssetMetadata(
    input: StudioDirectAssetMutationScope & {
      metadata_patch: Record<string, unknown>;
      forbidden_metadata_key: string;
    },
  ): Promise<StudioAsset | null>;
  requestDirectAssetDeletion(
    input: StudioDirectAssetMutationScope & {
      deletion_marker: Record<string, string>;
      deletion_metadata: Record<string, string>;
    },
  ): Promise<StudioDirectAssetDeletionRequestResult>;
  deleteRequestedDirectAsset(
    input: StudioDirectAssetMutationScope & { object_key: string },
  ): Promise<boolean>;
}

export type StudioAssetListFilter = {
  source_job_id?: string;
  source?: 'generated' | 'uploaded';
};
