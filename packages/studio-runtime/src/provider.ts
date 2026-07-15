import type { StudioCapabilityDescriptor, StudioJobInput } from '@kortix/api-contract';
import { studioPhase1Capabilities } from '@kortix/api-contract';

export const STUDIO_MAX_PROVIDER_ATTEMPTS = 3;

export type StudioRetryClassification =
  | 'retryable'
  | 'terminal'
  | 'rate_limited'
  | 'unknown_outcome';

export interface StudioProviderContext {
  correlationId: string;
}

export interface StudioCostEstimate {
  max_credits: number;
  provider_credits: number;
  platform_credits: number;
}

export interface StudioProviderHandle {
  provider: string;
  id: string;
  submission_key: string;
}

export interface StudioProviderStatus {
  status: 'submitted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  progress?: number;
}

export interface StudioProviderAsset {
  kind: 'image';
  mime_type: string;
  bytes: Uint8Array;
  filename: string;
}

export interface StudioProviderResult {
  assets: StudioProviderAsset[];
  usage?: Record<string, unknown>;
}

export interface StudioProviderAdapter {
  readonly id: string;
  capabilities(): readonly StudioCapabilityDescriptor[];
  validate(input: StudioJobInput): StudioValidationResult;
  estimate(ctx: StudioProviderContext, input: StudioJobInput): Promise<StudioCostEstimate>;
  submit(ctx: StudioProviderContext, input: StudioJobInput): Promise<StudioProviderHandle>;
  poll(ctx: StudioProviderContext, handle: StudioProviderHandle): Promise<StudioProviderStatus>;
  cancel(ctx: StudioProviderContext, handle: StudioProviderHandle): Promise<void>;
  reconcile?(
    ctx: StudioProviderContext,
    submissionKey: string,
  ): Promise<StudioProviderHandle | 'not-found' | 'unknown'>;
  fetchResult(
    ctx: StudioProviderContext,
    handle: StudioProviderHandle,
  ): Promise<StudioProviderResult>;
}

export type StudioValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface RetryClassificationInput {
  status?: number;
  retryAfter?: string | null;
  outcomeUnknown?: boolean;
  now?: Date;
}

export interface RetryClassificationResult {
  classification: StudioRetryClassification;
  retryable: boolean;
  retry_after_ms?: number;
}

export function parseRetryAfterMs(value: string | null | undefined, now = new Date()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }
  return Math.max(0, timestamp - now.getTime());
}

export function classifyProviderRetry(input: RetryClassificationInput): RetryClassificationResult {
  if (input.outcomeUnknown) {
    return { classification: 'unknown_outcome', retryable: false };
  }
  if (input.status === 429) {
    const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now ?? new Date(0));
    return {
      classification: 'rate_limited',
      retryable: true,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    };
  }
  if (
    input.status === 408 ||
    input.status === 409 ||
    input.status === 425 ||
    (typeof input.status === 'number' && input.status >= 500)
  ) {
    return { classification: 'retryable', retryable: true };
  }
  return { classification: 'terminal', retryable: false };
}

export function createFakeStudioProvider(): StudioProviderAdapter {
  return {
    id: 'fake',
    capabilities() {
      return studioPhase1Capabilities;
    },
    validate(input) {
      return input.capability === 'image.generate'
        ? { ok: true }
        : { ok: false, code: 'STUDIO_MODEL_UNSUPPORTED', message: 'Unsupported capability' };
    },
    async estimate() {
      return {
        max_credits: 1,
        provider_credits: 0,
        platform_credits: 1,
      };
    },
    async submit(_ctx, input) {
      return {
        provider: 'fake',
        id: `fake-${input.capability}`,
        submission_key: 'fake-submission-key',
      };
    },
    async poll() {
      return { status: 'succeeded', progress: 1 };
    },
    async cancel() {},
    async reconcile() {
      return 'unknown';
    },
    async fetchResult() {
      return {
        assets: [
          {
            kind: 'image',
            mime_type: 'image/png',
            bytes: new Uint8Array([137, 80, 78, 71]),
            filename: 'fake-studio-image.png',
          },
        ],
      };
    },
  };
}
