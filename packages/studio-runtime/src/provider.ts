import type { StudioCapabilityDescriptor, StudioJobInput } from '@kortix/api-contract';

export const STUDIO_MAX_PROVIDER_ATTEMPTS = 3;

export type StudioRetryClassification =
  | 'retryable'
  | 'terminal'
  | 'rate_limited'
  | 'unknown_outcome';

export interface StudioProviderContext {
  correlationId: string;
  /** Stable, worker-committed idempotency key. It exists before provider I/O. */
  submissionKey: string;
}

export interface StudioCostEstimate {
  max_credits: number;
  provider_credits: number;
  platform_credits: number;
}

export interface StudioPricingSnapshot {
  pricing_catalog_id: string;
  version: number;
  provider: string;
  model: string;
  unit: 'image';
  rate_credits: number;
  max_provider_credits: number;
  markup_credits: number;
}

export interface StudioProviderDefinitionConfig {
  provider_config_id: string;
  provider: string;
  base_url: string | null;
  region: string | null;
  capability_map: Record<string, unknown>;
  version_token: string;
}

export interface StudioProviderDefinition {
  readonly id: string;
  capabilities(config: StudioProviderDefinitionConfig): readonly StudioCapabilityDescriptor[];
  validate(
    config: StudioProviderDefinitionConfig,
    model: string,
    input: StudioJobInput,
  ): StudioValidationResult;
  estimate(
    config: StudioProviderDefinitionConfig,
    pricing: StudioPricingSnapshot,
    input: StudioJobInput,
  ): StudioCostEstimate;
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
  filename: string;
  mime_type: string;
  size_bytes: number;
  replayable_within_attempt: boolean;
  openBody(): Promise<ReadableStream<Uint8Array>>;
}

export interface StudioReferenceAssetResolver {
  resolve(input: {
    projectId: string;
    assetIds: readonly string[];
  }): Promise<readonly StudioProviderAsset[]>;
}

export interface StudioProviderResult {
  assets: StudioProviderAsset[];
  usage?: Record<string, unknown>;
}

export type StudioProviderSubmission =
  | {
      kind: 'completed';
      provider: string;
      submission_key: string;
      result: StudioProviderResult;
    }
  | { kind: 'async'; handle: StudioProviderHandle };

export class StudioProviderCallError extends Error {
  constructor(
    readonly classification: StudioRetryClassification,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'StudioProviderCallError';
  }
}

export interface StudioProviderAdapter {
  readonly id: string;
  submit(ctx: StudioProviderContext, input: StudioJobInput): Promise<StudioProviderSubmission>;
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

export type StudioValidationResult = { ok: true } | { ok: false; code: string; message: string };

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

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = new Date(),
): number | undefined {
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
    const retryAfterMs = parseRetryAfterMs(input.retryAfter, input.now ?? new Date());
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
    async submit(_ctx, input) {
      return {
        kind: 'async',
        handle: {
          provider: 'fake',
          id: `fake-${input.capability}-outputs-${input.image.output_count}`,
          submission_key: _ctx.submissionKey,
        },
      };
    },
    async poll() {
      return { status: 'succeeded', progress: 1 };
    },
    async cancel() {},
    async reconcile() {
      return 'unknown';
    },
    async fetchResult(_ctx, handle) {
      const outputCountMatch = /^fake-image\.generate-outputs-([1-8])$/.exec(handle.id);
      const outputCount = Number(outputCountMatch?.[1] ?? 1);
      return {
        assets: Array.from({ length: outputCount }, (_, index) => {
          const bytes = fakePngBytes();
          return {
            kind: 'image',
            filename: `fake-studio-image-${index + 1}.png`,
            mime_type: 'image/png',
            size_bytes: bytes.byteLength,
            replayable_within_attempt: true,
            async openBody() {
              return byteStream(bytes);
            },
          };
        }),
      };
    },
  };
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fakePngBytes(): Uint8Array {
  return new Uint8Array(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
}
