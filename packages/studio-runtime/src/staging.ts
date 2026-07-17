import type { StudioPricingSnapshot } from './provider';
import { z } from 'zod';

const checksumSchema = z.string().regex(/^[a-f0-9]{64}$/);
const studioStagingManifestSchema = z
  .object({
    version: z.literal(1),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    job_id: z.string().uuid(),
    attempt_id: z.string().uuid(),
    submission_key_hash: checksumSchema,
    provider_config_id: z.string().uuid(),
    provider_config_version: z.string().min(1).max(1024),
    pricing_catalog_id: z.string().uuid(),
    pricing_version: z.number().int().positive(),
    assets: z
      .array(
        z
          .object({
            kind: z.literal('image'),
            key: z.string().min(1).max(1024),
            filename: z.string().trim().min(1).max(255),
            mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
            size_bytes: z.number().int().positive(),
            checksum_sha256: checksumSchema,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    usage: z.record(z.string(), z.number().finite().nonnegative()),
  })
  .strict();

export interface StudioStagingManifest {
  version: 1;
  account_id: string;
  project_id: string;
  job_id: string;
  attempt_id: string;
  submission_key_hash: string;
  provider_config_id: string;
  provider_config_version: string;
  pricing_catalog_id: string;
  pricing_version: number;
  assets: Array<{
    kind: 'image';
    key: string;
    filename: string;
    mime_type: 'image/png' | 'image/jpeg' | 'image/webp';
    size_bytes: number;
    checksum_sha256: string;
  }>;
  usage: Record<string, number>;
}

export function parseStudioStagingManifest(_value: unknown): StudioStagingManifest {
  const parsed = studioStagingManifestSchema.safeParse(_value);
  if (!parsed.success) throw new Error('Invalid Studio staging manifest');
  return parsed.data;
}

export function studioSubmissionKeyHash(_submissionKey: string): string {
  if (!_submissionKey || _submissionKey.length > 4096) throw stagingError();
  return new Bun.CryptoHasher('sha256').update(_submissionKey).digest('hex');
}

export function studioStagingPrefix(_input: {
  accountId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  submissionKeyHash: string;
}): string {
  const segments = [
    _input.accountId,
    _input.projectId,
    _input.jobId,
    _input.attemptId,
    _input.submissionKeyHash,
  ];
  if (
    segments.some((value) => !safeSegment(value)) ||
    !/^[a-f0-9]{64}$/.test(_input.submissionKeyHash)
  ) {
    throw stagingError();
  }
  return (
    `accounts/${_input.accountId}/projects/${_input.projectId}/jobs/${_input.jobId}` +
    `/attempts/${_input.attemptId}/submissions/${_input.submissionKeyHash}/`
  );
}

export function studioStagingManifestKey(
  input: Parameters<typeof studioStagingPrefix>[0],
): string {
  return `${studioStagingPrefix(input)}manifest.json`;
}

export function calculateStudioImageUsageCredits(_input: {
  pricing: StudioPricingSnapshot;
  outputCount: number;
}): {
  usage: { output_count: number };
  upstream_cost_credits: number;
  output_markup_credits: number;
} {
  if (!Number.isInteger(_input.outputCount) || _input.outputCount < 1 || _input.outputCount > 16) {
    throw pricingError();
  }
  const rate = scaledCredits(_input.pricing.rate_credits);
  const maximum = scaledCredits(_input.pricing.max_provider_credits);
  const markup = scaledCredits(_input.pricing.markup_credits);
  const upstream = rate * _input.outputCount;
  const outputMarkup = markup * _input.outputCount;
  if (
    !Number.isSafeInteger(upstream) ||
    !Number.isSafeInteger(outputMarkup) ||
    upstream > maximum
  ) {
    throw pricingError();
  }
  return {
    usage: { output_count: _input.outputCount },
    upstream_cost_credits: upstream / 10_000,
    output_markup_credits: outputMarkup / 10_000,
  };
}

export function addStudioCreditAmounts(_values: readonly number[]): number {
  let total = 0;
  for (const value of _values) {
    total += scaledCredits(value);
    if (!Number.isSafeInteger(total) || total > 999_999_999_999) throw pricingError();
  }
  return total / 10_000;
}

function scaledCredits(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 99_999_999.9999) throw pricingError();
  const scaled = Math.round(value * 10_000);
  if (!Number.isSafeInteger(scaled) || Math.abs(scaled / 10_000 - value) > 1e-9) {
    throw pricingError();
  }
  return scaled;
}

function safeSegment(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\\/]/.test(value) && value !== '.' && value !== '..';
}

function stagingError(): Error {
  return new Error('Invalid Studio staging identity');
}

function pricingError(): Error {
  return new Error('Invalid Studio image usage pricing');
}
