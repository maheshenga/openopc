import type {
  StudioAsset,
  StudioCreateJobRequest,
  StudioEstimateRequest,
  StudioEstimateResponse,
  StudioJob,
  StudioJobEvent,
  StudioProviderConfig,
  StudioUpload,
} from '@kortix/api-contract';

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

export type StudioCreateJobInput = StudioCreateJobRequest & {
  account_id: string;
  project_id: string;
  actor_user_id: string | null;
  actor_type: 'user' | 'agent' | 'system';
};

export type StudioCreateJobResult = {
  job: StudioJob;
  created: boolean;
  mismatch?: boolean;
};

export type StudioCreateUploadInput = {
  account_id: string;
  project_id: string;
  actor_user_id: string | null;
  declared_mime_type: string;
  expected_size_bytes: number;
  expected_checksum_sha256: string;
  metadata: Record<string, unknown>;
};

export interface StudioRepository {
  listProviders(projectId: string): Promise<StudioProviderConfigWire[]>;
  getProvider(projectId: string, providerConfigId: string): Promise<StudioProviderConfigWire | null>;
  saveEstimate(input: StudioEstimateRequest, estimate: StudioEstimateResponse): Promise<void>;
  getEstimate(estimateId: string): Promise<StudioEstimateResponse | null>;
  createJob(input: StudioCreateJobInput, provider: StudioProviderConfigWire, estimate: StudioEstimateResponse): Promise<StudioCreateJobResult>;
  listJobs(projectId: string, limit: number, cursor?: string | null): Promise<{ items: StudioJob[]; next_cursor: string | null }>;
  getJob(projectId: string, jobId: string): Promise<StudioJob | null>;
  cancelQueuedJob(projectId: string, jobId: string): Promise<StudioJob | null>;
  listEvents(projectId: string, jobId: string, afterCursor?: string | null): Promise<{ items: StudioJobEvent[]; next_cursor: string | null }>;
  createUpload(input: StudioCreateUploadInput): Promise<StudioUpload>;
  finalizeUpload(projectId: string, uploadId: string): Promise<StudioAsset | null>;
  listAssets(projectId: string, limit: number, cursor?: string | null): Promise<{ items: StudioAsset[]; next_cursor: string | null }>;
  getAsset(projectId: string, assetId: string): Promise<StudioAsset | null>;
}
