import type { StudioJobEvent, StudioJobInput, StudioJobState } from '@kortix/api-contract';
import type {
  StudioProviderAsset,
  StudioProviderDefinitionConfig,
  StudioProviderHandle,
  StudioRetryClassification,
} from '@kortix/studio-runtime';
import { z } from 'zod';

export const StudioWorkerConfigSchema = z
  .object({
    workerId: z.string().min(1),
    leaseMs: z
      .number()
      .int()
      .positive()
      .max(15 * 60_000),
    pollIntervalMs: z
      .number()
      .int()
      .nonnegative()
      .max(15 * 60_000),
    unknownOutcomeTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60_000),
  })
  .strict();

export type StudioWorkerConfig = z.infer<typeof StudioWorkerConfigSchema>;

export type StudioWorkerJob = {
  jobId: string;
  accountId: string;
  projectId: string;
  actorUserId: string | null;
  actorType: 'user' | 'agent' | 'system';
  actingTokenId: string | null;
  agentName: string | null;
  sessionId: string | null;
  capability: 'image.generate';
  providerConfigId: string;
  providerEnabled: boolean;
  provider: string;
  model: string;
  input: StudioJobInput;
  status: Extract<StudioJobState, 'queued' | 'running'>;
  attemptCount: number;
  providerHandle: StudioProviderHandle | null;
  cancellationRequestedAt: Date | null;
  reservedCredits: number;
  actualCredits: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  availableAt: Date;
  createdAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  credentialBinding: Record<string, unknown>;
};

export type StudioWorkerAttemptStatus =
  | 'created'
  | 'submitting'
  | 'submitted'
  | 'polling'
  | 'reconciling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type StudioWorkerAttempt = {
  attemptId: string;
  jobId: string;
  attemptNumber: number;
  submissionKey: string;
  status: StudioWorkerAttemptStatus;
  providerHandle: StudioProviderHandle | null;
  retryClassification: StudioRetryClassification | null;
  startedAt: Date;
  endedAt: Date | null;
};

export type StudioWorkerProviderConfig = {
  providerConfigId: string;
  accountId: string;
  projectId: string;
  provider: string;
  enabled: boolean;
  baseUrl: string | null;
  region: string | null;
  definitionId: string;
  credentialBinding: Record<string, unknown>;
  capabilityMap: StudioProviderDefinitionConfig['capability_map'];
  versionToken: string;
};

export type StudioWorkerEvent = {
  type: StudioJobEvent['type'];
  payload: Record<string, unknown>;
  createdAt: Date;
};

export type StoredStudioAsset = {
  assetId?: string;
  kind: 'image';
  mimeType: string;
  bucket: string;
  objectKey: string;
  checksumSha256: string;
  sizeBytes: number;
  filename: string;
};

export interface StudioWorkerRepository {
  claimNextJob(input: {
    processRole: 'studio-worker';
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<StudioWorkerJob | null>;
  heartbeatLease(input: {
    jobId: string;
    workerId: string;
    now: Date;
    leaseMs: number;
  }): Promise<boolean>;
  isCancellationRequested(input: { jobId: string; workerId: string }): Promise<boolean>;
  loadProviderConfigForSubmission(input: {
    jobId: string;
    workerId: string;
  }): Promise<StudioWorkerProviderConfig | null>;
  getLatestAttempt(jobId: string): Promise<StudioWorkerAttempt | null>;
  prepareAttempt(input: {
    jobId: string;
    workerId: string;
    submissionKey: string;
    adapterVersion: string;
    providerConfigVersion: string;
    now: Date;
  }): Promise<StudioWorkerAttempt | null>;
  markSubmitted(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    handle: StudioProviderHandle;
    now: Date;
  }): Promise<void>;
  markReconciling(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    availableAt: Date;
    message: string;
    now: Date;
  }): Promise<void>;
  schedulePoll(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    availableAt: Date;
    progress?: number;
    now: Date;
  }): Promise<void>;
  scheduleContinuation(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    phase: 'polling' | 'reconciling';
    classification: StudioRetryClassification;
    availableAt: Date;
    code: string;
    message: string;
    now: Date;
  }): Promise<void>;
  scheduleRetry(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    classification: StudioRetryClassification;
    availableAt: Date;
    message: string;
    now: Date;
  }): Promise<void>;
  finalizeSuccess(input: {
    jobId: string;
    attemptId: string;
    workerId: string;
    actualCredits: number;
    assets: StoredStudioAsset[];
    now: Date;
  }): Promise<'succeeded' | 'cancelled'>;
  markFailed(input: {
    jobId: string;
    attemptId?: string;
    workerId: string;
    code: string;
    message: string;
    classification?: StudioRetryClassification;
    now: Date;
  }): Promise<void>;
  markCancelled(input: {
    jobId: string;
    attemptId?: string;
    workerId: string;
    reason: string;
    code?: string;
    message?: string;
    now: Date;
  }): Promise<void>;
  abandonLease(input: {
    jobId: string;
    workerId: string;
    availableAt: Date;
  }): Promise<void>;
}

export interface StudioAssetWriter {
  persist(input: {
    job: StudioWorkerJob;
    attempt: StudioWorkerAttempt;
    assets: StudioProviderAsset[];
  }): Promise<StoredStudioAsset[]>;
}

export type StudioWorkerTickResult =
  | { kind: 'idle' }
  | { kind: 'processed'; jobId: string; status: StudioJobState }
  | { kind: 'error'; jobId?: string; code: string; message: string };
