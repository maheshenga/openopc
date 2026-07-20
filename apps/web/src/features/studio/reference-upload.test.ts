import { expect, mock, test } from 'bun:test';
import type {
  IntelligenceCreateUploadRequest,
  IntelligenceStudioAsset,
  IntelligenceStudioUpload,
} from '@kortix/sdk';
import { uploadReferenceImage } from './reference-upload';

const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '26000000-0000-4000-a000-000000000001';
const ASSET_ID = '27000000-0000-4000-a000-000000000001';

test('uploads exact bytes and signed headers before finalizing the reference asset', async () => {
  const bytes = new TextEncoder().encode('bounded-image-bytes');
  const checksum = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const order: string[] = [];
  let createInput: IntelligenceCreateUploadRequest | null = null;
  let fetchInput: { url: string; init?: RequestInit } | null = null;
  const upload: IntelligenceStudioUpload = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: `projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`,
    declared_mime_type: 'image/png',
    expected_size_bytes: bytes.byteLength,
    expected_checksum_sha256: checksum,
    signed_upload_url: 'https://objects.example.test/upload?signature=opaque',
    signed_upload_headers: {
      'content-type': 'image/png',
      'x-amz-checksum-sha256': 'opaque-checksum',
    },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };
  const asset: IntelligenceStudioAsset = {
    asset_id: ASSET_ID,
    account_id: '23000000-0000-4000-a000-000000000001',
    project_id: PROJECT_ID,
    source_job_id: null,
    kind: 'image',
    mime_type: 'image/png',
    bucket: 'private-studio',
    object_key: upload.object_key,
    checksum_sha256: checksum,
    size_bytes: bytes.byteLength,
    width: 1,
    height: 1,
    metadata: {},
    created_at: '2026-07-20T12:02:00.000Z',
  };

  const result = await uploadReferenceImage({
    file: new File([bytes], 'reference.png', { type: 'image/png' }),
    createUpload: async (input) => {
      order.push('create');
      createInput = input;
      return upload;
    },
    finalizeUpload: async (uploadId) => {
      order.push(`finalize:${uploadId}`);
      return asset;
    },
    fetch: mock(async (url: string, init?: RequestInit) => {
      order.push('put');
      fetchInput = { url, init };
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });

  expect(createInput).toMatchObject({
    declared_mime_type: 'image/png',
    expected_size_bytes: bytes.byteLength,
    expected_checksum_sha256: checksum,
  });
  expect(fetchInput?.url).toBe(upload.signed_upload_url);
  expect(fetchInput?.init?.headers).toEqual(upload.signed_upload_headers);
  expect(fetchInput?.init?.method).toBe('PUT');
  expect(fetchInput?.init?.headers).not.toHaveProperty('content-length');
  expect(fetchInput?.init?.headers).not.toHaveProperty('authorization');
  expect(new Uint8Array(fetchInput?.init?.body as ArrayBuffer)).toEqual(bytes);
  expect(order).toEqual(['create', 'put', `finalize:${UPLOAD_ID}`]);
  expect(result).toEqual(asset);
});

test('never finalizes or logs signed material after a failed PUT', async () => {
  const bytes = new TextEncoder().encode('failed-image-bytes');
  let finalizeCalls = 0;
  const messages: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values: unknown[]) => messages.push(values.map(String).join(' '));
  console.error = (...values: unknown[]) => messages.push(values.map(String).join(' '));
  try {
    await expect(
      uploadReferenceImage({
        file: new File([bytes], 'reference.png', { type: 'image/png' }),
        createUpload: async () => ({
          upload_id: UPLOAD_ID,
          project_id: PROJECT_ID,
          asset_id: null,
          object_key: 'uploads/source.png',
          declared_mime_type: 'image/png',
          expected_size_bytes: bytes.byteLength,
          expected_checksum_sha256: 'a'.repeat(64),
          signed_upload_url: 'https://objects.example.test/private?signature=secret',
          signed_upload_headers: { 'x-private-header': 'secret' },
          expires_at: '2026-07-20T12:15:00.000Z',
          status: 'pending',
        }),
        finalizeUpload: async () => {
          finalizeCalls += 1;
          throw new Error('must not finalize');
        },
        fetch: mock(async () => new Response(null, { status: 403 })) as typeof fetch,
      }),
    ).rejects.toThrow('REFERENCE_UPLOAD_FAILED_403');
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  expect(finalizeCalls).toBe(0);
  expect(messages).toEqual([]);
});

test('rejects unsupported and empty files before creating an upload', async () => {
  let createCalls = 0;
  const createUpload = async () => {
    createCalls += 1;
    throw new Error('must not create');
  };
  const finalizeUpload = async () => {
    throw new Error('must not finalize');
  };

  await expect(
    uploadReferenceImage({
      file: new File(['text'], 'reference.txt', { type: 'text/plain' }),
      createUpload,
      finalizeUpload,
    }),
  ).rejects.toThrow('REFERENCE_IMAGE_TYPE_UNSUPPORTED');
  await expect(
    uploadReferenceImage({
      file: new File([], 'empty.png', { type: 'image/png' }),
      createUpload,
      finalizeUpload,
    }),
  ).rejects.toThrow('REFERENCE_IMAGE_SIZE_INVALID');
  expect(createCalls).toBe(0);
});
