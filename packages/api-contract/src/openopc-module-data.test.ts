import { describe, expect, test } from 'bun:test';
import * as Contracts from './index';

type Schema = { safeParse(value: unknown): { success: boolean }; parse(value: unknown): unknown };

function schema(name: string): Schema | undefined {
  return (Contracts as unknown as Record<string, Schema | undefined>)[name];
}

describe('OpenOPC module data contracts', () => {
  test('accepts a bounded versioned canvas document and rejects unsafe keys', () => {
    const writeSchema = schema('OpenOpcModuleDocumentWriteInputSchema');
    expect(writeSchema).toBeDefined();
    if (!writeSchema) return;

    expect(
      writeSchema.safeParse({
        key: 'canvases/catalog/home',
        expected_revision: 7,
        value: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
      }).success,
    ).toBe(true);

    for (const value of [
      { key: '../escape', expected_revision: 7, value: {} },
      { key: '/absolute', expected_revision: 7, value: {} },
      { key: 'canvases//home', expected_revision: 7, value: {} },
      { key: 'canvases/home', expected_revision: 0, value: {} },
      { key: 'canvases/home', expected_revision: 7, value: {}, api_key: 'secret' },
      { key: 'canvases/home', expected_revision: 7, value: { notes: 'x'.repeat(2_100_000) } },
    ]) {
      expect(writeSchema.safeParse(value).success).toBe(false);
    }
  });

  test('parses strict document pages and asset metadata without provider fields', () => {
    const pageSchema = schema('OpenOpcModuleDocumentPageSchema');
    const assetInputSchema = schema('OpenOpcModuleAssetCreateInputSchema');
    expect(pageSchema).toBeDefined();
    expect(assetInputSchema).toBeDefined();
    if (!pageSchema || !assetInputSchema) return;

    expect(
      pageSchema.safeParse({
        data: [
          {
            key: 'canvases/home',
            revision: 8,
            etag: '"rev-8"',
            value: { nodes: [], edges: [] },
            updated_at: '2026-08-11T08:00:00.000Z',
          },
        ],
        next_cursor: null,
      }).success,
    ).toBe(true);

    expect(
      assetInputSchema.safeParse({
        filename: 'reference.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        sha256: `sha256:${'a'.repeat(64)}`,
      }).success,
    ).toBe(true);
    expect(
      assetInputSchema.safeParse({
        filename: 'reference.exe',
        mime_type: 'application/x-msdownload',
        size_bytes: 1024,
        sha256: `sha256:${'a'.repeat(64)}`,
      }).success,
    ).toBe(false);
    expect(
      assetInputSchema.safeParse({
        filename: 'reference.png',
        mime_type: 'image/png',
        size_bytes: 1024,
        sha256: `sha256:${'a'.repeat(64)}`,
        provider_url: 'https://storage.example.com',
      }).success,
    ).toBe(false);
  });
});
