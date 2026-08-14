import { describe, expect, test } from 'bun:test';
import * as Contracts from './index';

type Schema = { safeParse(value: unknown): { success: boolean }; parse(value: unknown): unknown };

function schema(name: string): Schema | undefined {
  return (Contracts as unknown as Record<string, Schema | undefined>)[name];
}

describe('OpenOPC module settings contracts', () => {
  test('accepts only bounded non-sensitive setting keys and scalar values', () => {
    const keySchema = schema('OpenOpcModuleSettingKeySchema');
    const effectiveSchema = schema('OpenOpcEffectiveModuleSettingsSchema');
    expect(keySchema).toBeDefined();
    expect(effectiveSchema).toBeDefined();
    if (!keySchema || !effectiveSchema) return;

    for (const key of [
      'default_image_model',
      'canvas.autosave',
      'limits.concurrent_jobs',
      'storage.retention_days',
    ]) {
      expect(keySchema.safeParse(key).success).toBe(true);
    }
    for (const key of [
      'api_key',
      'provider',
      'provider.base_url',
      'auth_token',
      'storage.secret',
      'UPPER_CASE',
    ]) {
      expect(keySchema.safeParse(key).success).toBe(false);
    }

    expect(
      effectiveSchema.safeParse({
        schema_version: 1,
        revision: 3,
        values: {
          default_image_model: 'platform/image-default',
          'canvas.autosave': true,
          'limits.concurrent_jobs': 2,
          'storage.retention_days': null,
        },
        loaded_at: '2026-08-11T08:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  test('rejects credential-like, nested, oversized, and unprojected settings', () => {
    const effectiveSchema = schema('OpenOpcEffectiveModuleSettingsSchema');
    expect(effectiveSchema).toBeDefined();
    if (!effectiveSchema) return;

    for (const value of [
      {
        schema_version: 1,
        revision: 1,
        values: { api_key: 'secret' },
        loaded_at: '2026-08-11T08:00:00.000Z',
      },
      {
        schema_version: 1,
        revision: 1,
        values: { canvas: { autosave: true } },
        loaded_at: '2026-08-11T08:00:00.000Z',
      },
      {
        schema_version: 1,
        revision: 1,
        values: { system_prompt: 'x'.repeat(65_537) },
        loaded_at: '2026-08-11T08:00:00.000Z',
      },
      {
        schema_version: 1,
        revision: 1,
        values: {},
        loaded_at: '2026-08-11T08:00:00.000Z',
        provider_config: {},
      },
    ]) {
      expect(effectiveSchema.safeParse(value).success).toBe(false);
    }
  });

  test('validates whole-setting replacement with optimistic concurrency', () => {
    const putSchema = schema('OpenOpcModuleSettingsPutInputSchema');
    expect(putSchema).toBeDefined();
    if (!putSchema) return;

    expect(
      putSchema.safeParse({
        expected_revision: 2,
        values: { 'canvas.autosave': true, 'canvas.snap_size': 20 },
      }).success,
    ).toBe(true);
    expect(
      putSchema.safeParse({
        expected_revision: -1,
        values: { api_key: 'not-allowed' },
      }).success,
    ).toBe(false);
    expect(
      putSchema.safeParse({ expected_revision: 0, values: {}, account_id: 'injected' }).success,
    ).toBe(false);
  });
});
