import { describe, expect, test } from 'bun:test';
import type { OpenOpcImageAsset, OpenOpcModuleClient } from '@openopc/developer-sdk';
import {
  isAbortError,
  listJobAssetIds,
  mergeImageAssets,
  mergeReferenceAssetIds,
  openOpcErrorMessage,
  resolveNextAssetCursor,
  shouldFallbackToStatusPolling,
  validateImageFile,
} from './openopc-image-service';
import {
  OpenOpcModuleProtocolError,
  OpenOpcModuleRequestError,
  OpenOpcModuleServiceError,
} from '@openopc/developer-sdk';

describe('mergeReferenceAssetIds', () => {
  test('preserves existing and uploaded order while removing duplicates', () => {
    expect(mergeReferenceAssetIds(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('enforces the image service reference limit', () => {
    const ids = Array.from({ length: 10 }, (_, index) => `asset-${index}`);
    expect(mergeReferenceAssetIds(ids.slice(0, 5), ids.slice(5))).toEqual(ids.slice(0, 8));
  });
});

describe('mergeImageAssets', () => {
  const asset = (assetId: string, sizeBytes: number): OpenOpcImageAsset => ({
    asset_id: assetId,
    source_job_id: null,
    kind: 'image',
    mime_type: 'image/png',
    size_bytes: sizeBytes,
    width: 512,
    height: 512,
    created_at: '2026-08-07T00:00:00.000Z',
  });

  test('appends new pages without duplicating assets', () => {
    const first = asset('00000000-0000-4000-8000-000000000001', 100);
    const updated = asset(first.asset_id, 200);
    const second = asset('00000000-0000-4000-8000-000000000002', 300);

    expect(mergeImageAssets([first], [updated, second])).toEqual([updated, second]);
  });

  test('stops pagination when the service repeats a requested cursor', () => {
    const requested = new Set(['cursor-a', 'cursor-b']);
    expect(resolveNextAssetCursor('cursor-c', requested)).toBe('cursor-c');
    expect(resolveNextAssetCursor('cursor-a', requested)).toBeNull();
    expect(resolveNextAssetCursor(null, requested)).toBeNull();
  });

  test('recovers job assets across pages and stops on a repeated cursor', async () => {
    const jobId = '00000000-0000-4000-8000-000000000099';
    const first = asset('00000000-0000-4000-8000-000000000011', 100);
    const second = { ...asset('00000000-0000-4000-8000-000000000012', 200), source_job_id: jobId };
    const third = { ...asset('00000000-0000-4000-8000-000000000013', 300), source_job_id: jobId };
    const pages = new Map([
      [null, { items: [first, second], next_cursor: 'page-2' }],
      ['page-2', { items: [second, third], next_cursor: 'page-2' }],
    ]);
    const client = {
      ai: {
        images: {
          assets: {
            list: async ({ cursor }: { cursor: string | null }) => {
              const page = pages.get(cursor);
              if (!page) throw new Error(`Missing asset page for cursor ${cursor ?? 'initial'}`);
              return page;
            },
          },
        },
      },
    } as unknown as OpenOpcModuleClient;

    await expect(listJobAssetIds(client, jobId)).resolves.toEqual(
      new Set([second.asset_id, third.asset_id]),
    );
  });
});

describe('abort handling', () => {
  test('recognizes SDK request cancellation as an abort', () => {
    expect(isAbortError(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'))).toBe(
      true,
    );
    expect(isAbortError(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'))).toBe(
      false,
    );
  });
});

describe('image service guards', () => {
  test('falls back for temporary or unavailable event history responses', () => {
    expect(shouldFallbackToStatusPolling(new Error('network timeout'))).toBe(false);
    expect(
      shouldFallbackToStatusPolling(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'),
      ),
    ).toBe(true);
    expect(
      shouldFallbackToStatusPolling(new OpenOpcModuleServiceError('MODULE_IMAGE_UNAVAILABLE', 404)),
    ).toBe(true);
    expect(
      shouldFallbackToStatusPolling(new OpenOpcModuleServiceError('MODULE_SERVICE_OPERATION_DENIED', 403)),
    ).toBe(false);
    expect(shouldFallbackToStatusPolling(new OpenOpcModuleProtocolError('bad event payload'))).toBe(false);
  });

  test('rejects unsupported, empty, and oversized reference files', () => {
    expect(() => validateImageFile(new File([new Uint8Array([1])], 'image.gif', { type: 'image/gif' })))
      .toThrow('PNG、JPEG 或 WebP');
    expect(() => validateImageFile(new File([], 'empty.png', { type: 'image/png' })))
      .toThrow('不能为空');
    expect(() => validateImageFile(new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' })))
      .toThrow('32 MB');
  });

  test('turns stable SDK failures into actionable user messages', () => {
    expect(
      openOpcErrorMessage(
        new OpenOpcModuleServiceError('MODULE_IMAGE_ESTIMATE_EXPIRED', 409),
        '生成失败',
      ),
    ).toContain('重新提交');
    expect(
      openOpcErrorMessage(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'),
        '生成失败',
      ),
    ).toContain('请求超时');
    expect(openOpcErrorMessage(new Error('A readable provider message'), '生成失败'))
      .toBe('A readable provider message');
    expect(openOpcErrorMessage(new OpenOpcModuleProtocolError('invalid payload'), '生成失败'))
      .toContain('无法识别');
  });
});
