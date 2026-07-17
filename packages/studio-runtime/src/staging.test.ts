import { describe, expect, test } from 'bun:test';
import {
  addStudioCreditAmounts,
  calculateStudioImageUsageCredits,
  parseStudioStagingManifest,
  studioStagingManifestKey,
  studioStagingPrefix,
  studioSubmissionKeyHash,
} from './staging';

const identities = {
  accountId: '10000000-0000-4000-a000-000000000001',
  projectId: '20000000-0000-4000-a000-000000000001',
  jobId: '30000000-0000-4000-a000-000000000001',
  attemptId: '40000000-0000-4000-a000-000000000001',
  submissionKeyHash: 'a'.repeat(64),
};

describe('Studio staging contract', () => {
  test('derives a stable SHA-256 identity and exact tenant submission prefix', () => {
    expect(studioSubmissionKeyHash('durable-submission-key')).toBe(
      '9990ca1fad63a77eb0df9cdc1a2ad564d78657fde5c03d009be0a37e286394a8',
    );
    expect(studioStagingPrefix(identities)).toBe(
      `accounts/${identities.accountId}/projects/${identities.projectId}/jobs/${identities.jobId}` +
        `/attempts/${identities.attemptId}/submissions/${identities.submissionKeyHash}/`,
    );
    expect(studioStagingManifestKey(identities)).toBe(`${studioStagingPrefix(identities)}manifest.json`);
  });

  test('prices image usage with exact four-decimal inputs and rejects estimate overflow', () => {
    expect(
      calculateStudioImageUsageCredits({
        pricing: {
          pricing_catalog_id: '50000000-0000-4000-a000-000000000001',
          version: 1,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
          unit: 'image',
          rate_credits: 0.1,
          max_provider_credits: 0.3,
          markup_credits: 0.025,
        },
        outputCount: 3,
      }),
    ).toEqual({
      usage: { output_count: 3 },
      upstream_cost_credits: 0.3,
      output_markup_credits: 0.075,
    });
    expect(() =>
      calculateStudioImageUsageCredits({
        pricing: {
          pricing_catalog_id: '50000000-0000-4000-a000-000000000001',
          version: 1,
          provider: 'openai-compatible',
          model: 'gpt-image-1',
          unit: 'image',
          rate_credits: 1,
          max_provider_credits: 1,
          markup_credits: 0,
        },
        outputCount: 2,
      }),
    ).toThrow('Invalid Studio image usage pricing');
    expect(addStudioCreditAmounts([0.1, 0.2, 0.075])).toBe(0.375);
  });

  test('parses only the strict versioned staging manifest shape', () => {
    const manifest = {
      version: 1 as const,
      account_id: identities.accountId,
      project_id: identities.projectId,
      job_id: identities.jobId,
      attempt_id: identities.attemptId,
      submission_key_hash: identities.submissionKeyHash,
      provider_config_id: '50000000-0000-4000-a000-000000000001',
      provider_config_version: 'provider-version-1',
      pricing_catalog_id: '60000000-0000-4000-a000-000000000001',
      pricing_version: 1,
      assets: [
        {
          kind: 'image' as const,
          key: `${studioStagingPrefix(identities)}assets/image-1.png`,
          filename: 'image-1.png',
          mime_type: 'image/png' as const,
          size_bytes: 4,
          checksum_sha256: 'b'.repeat(64),
        },
      ],
      usage: { output_count: 1 },
    };
    expect(parseStudioStagingManifest(manifest)).toEqual(manifest);
    expect(() => parseStudioStagingManifest({ ...manifest, unexpected: true })).toThrow(
      'Invalid Studio staging manifest',
    );
    expect(() =>
      parseStudioStagingManifest({ ...manifest, usage: { output_count: -1 } }),
    ).toThrow('Invalid Studio staging manifest');
  });
});
