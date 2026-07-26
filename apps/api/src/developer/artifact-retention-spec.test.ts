import { expect, test } from 'bun:test';

import {
  DeveloperArtifactRetentionConfigSchema,
  DeveloperArtifactRetentionTickResultSchema,
} from './artifact-retention-spec';

const validConfig = {
  ownerId: 'api-retention-test',
  leaseMs: 60_000,
  uploadBatchSize: 10,
  objectBatchSize: 10,
  orphanGraceMs: 300_000,
  maxAttempts: 5,
  retryBaseMs: 1_000,
  retryMaxMs: 60_000,
};

test('retention config schema rejects unsafe bounds and retry inversion', () => {
  expect(DeveloperArtifactRetentionConfigSchema.safeParse(validConfig).success).toBe(true);
  expect(
    DeveloperArtifactRetentionConfigSchema.safeParse({ ...validConfig, leaseMs: 1_000 }).success,
  ).toBe(false);
  expect(
    DeveloperArtifactRetentionConfigSchema.safeParse({
      ...validConfig,
      retryBaseMs: 5_000,
      retryMaxMs: 1_000,
    }).success,
  ).toBe(false);
  expect(
    DeveloperArtifactRetentionConfigSchema.safeParse({ ...validConfig, unexpected: true }).success,
  ).toBe(false);
});

test('retention tick result schema accepts only bounded success/failure contracts', () => {
  expect(
    DeveloperArtifactRetentionTickResultSchema.safeParse({
      success: true,
      data: { kind: 'idle' },
    }).success,
  ).toBe(true);
  expect(
    DeveloperArtifactRetentionTickResultSchema.safeParse({
      success: false,
      error: { code: 'RETENTION_OBJECT_STORE_FAILED', recoverable: true },
    }).success,
  ).toBe(true);
  expect(
    DeveloperArtifactRetentionTickResultSchema.safeParse({
      success: false,
      error: { code: 'RAW_S3_ERROR', recoverable: true },
    }).success,
  ).toBe(false);
});

