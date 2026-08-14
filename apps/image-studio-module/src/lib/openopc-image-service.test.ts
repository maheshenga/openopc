import { describe, expect, test } from 'bun:test';
import type {
  OpenOpcImageAsset,
  OpenOpcImageJob,
  OpenOpcModuleClient,
} from '@openopc/developer-sdk';
import {
  OpenOpcModuleProtocolError,
  OpenOpcModuleRequestError,
  OpenOpcModuleServiceError,
} from '@openopc/developer-sdk';
import {
  copyImageBlob,
  filterImageAssets,
  generateImage,
  imageFileExtension,
  isAbortError,
  isUnknownImageSubmissionError,
  listImageJobPage,
  listJobAssetIds,
  mergeImageAssets,
  mergeImageJobs,
  mergeLatestImageJobs,
  mergeReferenceAssetIds,
  openOpcErrorMessage,
  resetOpenOpcClientForTest,
  retainedImageRetryKey,
  resolveNextAssetCursor,
  resolveNextJobCursor,
  setOpenOpcClientForTest,
  shouldFallbackToStatusPolling,
  shouldRetryImagePoll,
  validateImageFile,
} from './openopc-image-service';
import {
  acquireResultPreviewUrl,
  ResultGrid,
  invokeResultAction,
} from '../components/generated-results';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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
    source: { prompt: null, job_id: null },
    kind: 'image',
    mime_type: 'image/png',
    checksum_sha256: '0000000000000000000000000000000000000000000000000000000000000000',
    size_bytes: sizeBytes,
    width: 512,
    height: 512,
    metadata: {},
    retention: { policy: 'temporary', expires_at: null, deletable: true },
    created_at: '2026-08-07T00:00:00.000Z',
  });

  test('appends new pages without duplicating assets', () => {
    const first = asset('00000000-0000-4000-8000-000000000001', 100);
    const updated = asset(first.asset_id, 200);
    const second = asset('00000000-0000-4000-8000-000000000002', 300);

    expect(mergeImageAssets([first], [updated, second])).toEqual([updated, second]);
  });

  test('filters loaded assets by generated and uploaded source', () => {
    const uploaded = asset('00000000-0000-4000-8000-000000000003', 100);
    const generated = {
      ...asset('00000000-0000-4000-8000-000000000004', 200),
      source: { prompt: null, job_id: '00000000-0000-4000-8000-000000000099' },
    };

    expect(filterImageAssets([uploaded, generated], 'all')).toEqual([uploaded, generated]);
    expect(filterImageAssets([uploaded, generated], 'generated')).toEqual([generated]);
    expect(filterImageAssets([uploaded, generated], 'uploaded')).toEqual([uploaded]);
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
    const second = {
      ...asset('00000000-0000-4000-8000-000000000012', 200),
      source: { prompt: null, job_id: jobId },
    };
    const third = {
      ...asset('00000000-0000-4000-8000-000000000013', 300),
      source: { prompt: null, job_id: jobId },
    };
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

describe('mergeImageJobs', () => {
  const job = (jobId: string, status: OpenOpcImageJob['status']): OpenOpcImageJob => ({
    job_id: jobId,
    model: 'openopc-image-v1',
    input: {
      prompt: 'A quiet workspace',
      reference_asset_ids: [],
      aspect_ratio: '1:1',
      quality: 'standard',
      output_count: 1,
    },
    status,
    attempt_count: 0,
    reserved_credits: 2,
    actual_credits: status === 'succeeded' ? 1.5 : null,
    error_code: null,
    created_at: '2026-08-07T00:00:00.000Z',
    updated_at: '2026-08-07T00:00:00.000Z',
    started_at: status === 'queued' ? null : '2026-08-07T00:00:01.000Z',
    completed_at: status === 'succeeded' ? '2026-08-07T00:00:05.000Z' : null,
    cancellable: status === 'queued' || status === 'running',
  });

  test('appends pages and replaces jobs whose status changed', () => {
    const first = job('00000000-0000-4000-8000-000000000021', 'queued');
    const updated = job(first.job_id, 'running');
    const second = job('00000000-0000-4000-8000-000000000022', 'succeeded');

    expect(mergeImageJobs([first], [updated, second])).toEqual([updated, second]);
  });

  test('refreshes the latest page without dropping already loaded older jobs', () => {
    const first = job('00000000-0000-4000-8000-000000000021', 'running');
    const updated = job(first.job_id, 'succeeded');
    const older = job('00000000-0000-4000-8000-000000000023', 'failed');
    const newest = job('00000000-0000-4000-8000-000000000024', 'queued');

    expect(mergeLatestImageJobs([first, older], [newest, updated])).toEqual([
      newest,
      updated,
      older,
    ]);
  });

  test('stops job pagination when the service repeats a requested cursor', () => {
    const requested = new Set(['cursor-a']);
    expect(resolveNextJobCursor('cursor-b', requested)).toBe('cursor-b');
    expect(resolveNextJobCursor('cursor-a', requested)).toBeNull();
    expect(resolveNextJobCursor(null, requested)).toBeNull();
  });

  test('loads a cursor page through the injected OpenOPC client', async () => {
    const expected = job('00000000-0000-4000-8000-000000000025', 'succeeded');
    const requests: unknown[] = [];
    const client = {
      ai: {
        images: {
          jobs: {
            list: async (input: unknown) => {
              requests.push(input);
              return { items: [expected], next_cursor: 'cursor-next' };
            },
          },
        },
      },
    } as unknown as OpenOpcModuleClient;

    setOpenOpcClientForTest(client);
    try {
      await expect(listImageJobPage('cursor-current')).resolves.toEqual({
        items: [expected],
        nextCursor: 'cursor-next',
      });
      expect(requests).toEqual([{ cursor: 'cursor-current', limit: 100 }]);
    } finally {
      resetOpenOpcClientForTest();
    }
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

describe('generated image actions', () => {
  test('maps supported image MIME types to safe filename extensions', () => {
    expect(imageFileExtension('image/png')).toBe('png');
    expect(imageFileExtension('image/jpeg')).toBe('jpg');
    expect(imageFileExtension('image/webp')).toBe('webp');
    expect(imageFileExtension('image/gif')).toBe('png');
  });

  test('classifies only unknown transport outcomes as reconcilable submissions', () => {
    expect(
      isUnknownImageSubmissionError(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'),
      ),
    ).toBe(true);
    expect(
      isUnknownImageSubmissionError(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED'),
      ),
    ).toBe(true);
    expect(
      isUnknownImageSubmissionError(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'),
      ),
    ).toBe(false);
    expect(
      isUnknownImageSubmissionError(
        new OpenOpcModuleServiceError('OPENOPC_IMAGE_PROVIDER_UNAVAILABLE', 503),
      ),
    ).toBe(false);
  });

  test('retains an unknown submission key once and clears it after reconciliation or terminal failure', () => {
    const unknown = new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT');
    const terminal = new OpenOpcModuleServiceError('OPENOPC_IMAGE_PROVIDER_UNAVAILABLE', 503);

    expect(retainedImageRetryKey(unknown, 'retained-key', false)).toBe('retained-key');
    expect(retainedImageRetryKey(unknown, 'retained-key', true)).toBeUndefined();
    expect(retainedImageRetryKey(terminal, 'retained-key', false)).toBeUndefined();
    expect(retainedImageRetryKey(unknown, undefined, false)).toBeUndefined();
  });

  test('returns unavailable when image clipboard APIs are absent', async () => {
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    try {
      await expect(copyImageBlob(new Blob(['image'], { type: 'image/png' }))).resolves.toBe(false);
    } finally {
      if (clipboardItemDescriptor) {
        Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'ClipboardItem');
      }
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  test('writes an image ClipboardItem when browser support is available', async () => {
    const clipboardItemDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const writes: unknown[][] = [];
    class TestClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', {
      configurable: true,
      value: TestClipboardItem,
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { write: async (items: unknown[]) => writes.push(items) } },
    });
    const blob = new Blob(['image'], { type: 'image/webp' });
    try {
      await expect(copyImageBlob(blob)).resolves.toBe(true);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.[0]).toBeInstanceOf(TestClipboardItem);
      expect((writes[0]?.[0] as TestClipboardItem).items).toEqual({ 'image/webp': blob });
    } finally {
      if (clipboardItemDescriptor) {
        Object.defineProperty(globalThis, 'ClipboardItem', clipboardItemDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'ClipboardItem');
      }
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  test('passes the selected generated image to a result callback', async () => {
    const result = {
      assetId: '00000000-0000-4000-8000-000000000031',
      blob: new Blob(['image'], { type: 'image/png' }),
      url: 'blob:selected-result',
    };
    const received: unknown[] = [];

    await invokeResultAction(result, async (selected) => {
      received.push(selected);
    });

    expect(received).toEqual([result]);
  });

  test('releases only preview-owned object URLs', () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const urlApi = {
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:preview-owned';
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    };
    const blob = new Blob(['image'], { type: 'image/png' });

    const listOwned = acquireResultPreviewUrl(
      { assetId: 'asset-list', blob, url: 'blob:list-owned' },
      urlApi,
    );
    listOwned.release();
    expect(listOwned.url).toBe('blob:list-owned');
    expect(created).toHaveLength(0);
    expect(revoked).toHaveLength(0);

    const previewOwned = acquireResultPreviewUrl(
      { assetId: 'asset-preview', blob, url: '' },
      urlApi,
    );
    previewOwned.release();
    expect(previewOwned.url).toBe('blob:preview-owned');
    expect(created).toEqual([blob]);
    expect(revoked).toEqual(['blob:preview-owned']);
  });

  test('renders MIME-safe downloads and an inline unavailable clipboard status', () => {
    const result = {
      assetId: '00000000-0000-4000-8000-000000000032',
      blob: new Blob(['image'], { type: 'image/jpeg' }),
      url: 'blob:jpeg-result',
    };
    const html = renderToStaticMarkup(
      createElement(ResultGrid, {
        results: [result],
        alt: '生成结果',
        downloadPrefix: 'image',
        onCopy: async () => undefined,
      }),
    );

    expect(html).toContain('download="image-00000000.jpg"');
    expect(html).toContain('当前浏览器不支持复制图片');
  });

  test('passes the caller key to job creation and reports that exact key first', async () => {
    const job = {
      job_id: '00000000-0000-4000-8000-000000000041',
      model: 'openopc-image-v1',
      input: {
        prompt: 'A calm studio',
        reference_asset_ids: [],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
      status: 'succeeded',
      attempt_count: 1,
      reserved_credits: 1,
      actual_credits: 1,
      error_code: null,
      created_at: '2026-08-12T00:00:00.000Z',
      updated_at: '2026-08-12T00:00:01.000Z',
      started_at: '2026-08-12T00:00:00.000Z',
      completed_at: '2026-08-12T00:00:01.000Z',
      cancellable: false,
    } satisfies OpenOpcImageJob;
    const reportedKeys: string[] = [];
    const createdKeys: string[] = [];
    const keyTimeline: string[] = [];
    const client = {
      ai: {
        images: {
          estimates: {
            create: async () => ({
              estimate_id: 'estimate-1',
              estimate_token: 'estimate-token',
              max_approved_credits: 1,
            }),
          },
          jobs: {
            create: async (input: { idempotency_key: string }) => {
              createdKeys.push(input.idempotency_key);
              keyTimeline.push(`create:${input.idempotency_key}`);
              return job;
            },
            events: async () => ({
              items: [
                {
                  cursor: 'event-1',
                  job_id: job.job_id,
                  status: 'succeeded',
                  progress: 1,
                  asset_ids: ['00000000-0000-4000-8000-000000000042'],
                  created_at: '2026-08-12T00:00:01.000Z',
                },
              ],
              next_cursor: null,
            }),
          },
          assets: {
            download: async () => new Blob(['image'], { type: 'image/png' }),
          },
        },
      },
    } as unknown as OpenOpcModuleClient;

    setOpenOpcClientForTest(client);
    try {
      const generated = await generateImage({
        model: job.model,
        ...job.input,
        idempotencyKey: 'image-studio-retained-key',
        onIdempotencyKey: (key) => {
          reportedKeys.push(key);
          keyTimeline.push(`callback:${key}`);
        },
      });
      expect(reportedKeys).toEqual(['image-studio-retained-key']);
      expect(createdKeys).toEqual(['image-studio-retained-key']);
      expect(keyTimeline).toEqual([
        'callback:image-studio-retained-key',
        'create:image-studio-retained-key',
      ]);
      generated.forEach((result) => URL.revokeObjectURL(result.url));
    } finally {
      resetOpenOpcClientForTest();
    }
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
      shouldFallbackToStatusPolling(
        new OpenOpcModuleServiceError('OPENOPC_IMAGE_PROVIDER_UNAVAILABLE', 404),
      ),
    ).toBe(true);
    expect(
      shouldFallbackToStatusPolling(
        new OpenOpcModuleServiceError('MODULE_SERVICE_OPERATION_DENIED', 403),
      ),
    ).toBe(false);
    expect(shouldFallbackToStatusPolling(new OpenOpcModuleProtocolError('bad event payload'))).toBe(
      false,
    );
  });

  test('backs off only for transient job polling failures', () => {
    expect(shouldRetryImagePoll(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'))).toBe(
      true,
    );
    expect(shouldRetryImagePoll(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_FAILED'))).toBe(
      true,
    );
    expect(shouldRetryImagePoll(new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED'))).toBe(
      false,
    );
    expect(shouldRetryImagePoll(new OpenOpcModuleServiceError('MODULE_SERVICE_UNAVAILABLE', 429))).toBe(
      true,
    );
    expect(shouldRetryImagePoll(new OpenOpcModuleServiceError('MODULE_SERVICE_UNAVAILABLE', 503))).toBe(
      true,
    );
    expect(
      shouldRetryImagePoll(new OpenOpcModuleServiceError('MODULE_SERVICE_OPERATION_DENIED', 403)),
    ).toBe(false);
    expect(shouldRetryImagePoll(new Error('local validation'))).toBe(false);
  });

  test('rejects unsupported, empty, and oversized reference files', () => {
    expect(() =>
      validateImageFile(new File([new Uint8Array([1])], 'image.gif', { type: 'image/gif' })),
    ).toThrow('PNG、JPEG 或 WebP');
    expect(() => validateImageFile(new File([], 'empty.png', { type: 'image/png' }))).toThrow(
      '不能为空',
    );
    expect(() =>
      validateImageFile(
        new File([new Uint8Array(32 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
      ),
    ).toThrow('32 MB');
  });

  test('turns stable SDK failures into actionable user messages', () => {
    expect(
      openOpcErrorMessage(
        new OpenOpcModuleServiceError('OPENOPC_IMAGE_ESTIMATE_EXPIRED', 409),
        '生成失败',
      ),
    ).toContain('重新提交');
    expect(
      openOpcErrorMessage(
        new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_TIMEOUT'),
        '生成失败',
      ),
    ).toContain('请求超时');
    expect(openOpcErrorMessage(new Error('A readable provider message'), '生成失败')).toBe(
      'A readable provider message',
    );
    expect(
      openOpcErrorMessage(new OpenOpcModuleProtocolError('invalid payload'), '生成失败'),
    ).toContain('无法识别');
  });
});
