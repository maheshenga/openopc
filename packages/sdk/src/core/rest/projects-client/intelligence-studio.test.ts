import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  cancelIntelligenceJob,
  createIntelligenceAssetDownloadUrl,
  createIntelligenceUpload,
  estimateIntelligenceImage,
  finalizeIntelligenceUpload,
  getIntelligenceAsset,
  getIntelligenceJob,
  getIntelligenceJobEvents,
  listIntelligenceAssets,
  listIntelligenceJobs,
} from './intelligence-studio';

const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const ESTIMATE_ID = '21000000-0000-4000-a000-000000000001';
const JOB_ID = '22000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '23000000-0000-4000-a000-000000000001';
const USER_ID = '24000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '26000000-0000-4000-a000-000000000001';
const ASSET_ID = '27000000-0000-4000-a000-000000000001';

const estimateRequest = {
  capability: 'image.generate' as const,
  provider_config_id: PROVIDER_CONFIG_ID,
  model: 'fake/image-v1',
  input: {
    capability: 'image.generate' as const,
    image: {
      prompt: 'A precise product photograph',
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    },
  },
};

function jobResponse(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_user_id: USER_ID,
    actor_type: 'user',
    capability: 'image.generate',
    provider_config_id: PROVIDER_CONFIG_ID,
    provider: 'fake',
    model: 'fake/image-v1',
    input: estimateRequest.input,
    status: 'running',
    idempotency_key: 'intelligence-job-idempotency-key',
    request_hash: `sha256:${'b'.repeat(64)}`,
    attempt_count: 1,
    reserved_credits: 2.5,
    actual_credits: null,
    error_code: null,
    error_message: null,
    created_at: '2026-07-20T12:00:00.000Z',
    updated_at: '2026-07-20T12:01:00.000Z',
    started_at: '2026-07-20T12:00:10.000Z',
    completed_at: null,
    ...overrides,
  };
}

function uploadResponse(overrides: Record<string, unknown> = {}) {
  return {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: 'uploads/source.png',
    declared_mime_type: 'image/png',
    expected_size_bytes: 1,
    expected_checksum_sha256: 'c'.repeat(64),
    signed_upload_url: 'https://objects.example.test/upload',
    signed_upload_headers: { 'content-type': 'image/png' },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
    ...overrides,
  };
}

function assetResponse(overrides: Record<string, unknown> = {}) {
  return {
    asset_id: ASSET_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_job_id: JOB_ID,
    kind: 'image',
    mime_type: 'image/png',
    bucket: 'private-studio',
    object_key: 'assets/result.png',
    checksum_sha256: 'd'.repeat(64),
    size_bytes: 1,
    width: 1,
    height: 1,
    metadata: {},
    created_at: '2026-07-20T12:03:00.000Z',
    ...overrides,
  };
}

let requests: Array<{ url: string; method: string; body?: unknown }> = [];
let nextBody: unknown;
let nextStatus = 200;

beforeEach(() => {
  requests = [];
  nextBody = {};
  nextStatus = 200;
  globalThis.fetch = mock(async (url: unknown, options: RequestInit = {}) => {
    requests.push({
      url: String(url),
      method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? JSON.parse(options.body) : options.body,
    });
    return new Response(JSON.stringify(nextBody), {
      status: nextStatus,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({
  backendUrl: 'http://test.local/v1',
  getToken: async () => 'tok',
});

test('estimates an image through the project Studio route', async () => {
  nextBody = {
    estimate_id: ESTIMATE_ID,
    estimate_token: 'studio-estimate-v2.payload.signature',
    expires_at: '2026-07-20T12:15:00.000Z',
    currency: 'credits',
    provider_cost_credits: 2,
    platform_cost_credits: 0.5,
    max_approved_credits: 2.5,
    input_hash: `sha256:${'a'.repeat(64)}`,
    line_items: [
      { label: 'Provider image generation', credits: 2 },
      { label: 'Studio platform fee', credits: 0.5 },
    ],
  };

  const estimate = await estimateIntelligenceImage(PROJECT_ID, estimateRequest);

  expect(estimate.estimate_id).toBe(ESTIMATE_ID);
  expect(requests).toEqual([
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/studio/estimates`,
      method: 'POST',
      body: estimateRequest,
    },
  ]);
});

test('binds list, get, events, and cancel to project-scoped Studio jobs', async () => {
  const job = {
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_user_id: USER_ID,
    actor_type: 'user',
    capability: 'image.generate',
    provider_config_id: PROVIDER_CONFIG_ID,
    provider: 'fake',
    model: 'fake/image-v1',
    input: estimateRequest.input,
    status: 'running',
    idempotency_key: 'intelligence-job-idempotency-key',
    request_hash: `sha256:${'b'.repeat(64)}`,
    attempt_count: 1,
    reserved_credits: 2.5,
    actual_credits: null,
    error_code: null,
    error_message: null,
    created_at: '2026-07-20T12:00:00.000Z',
    updated_at: '2026-07-20T12:01:00.000Z',
    started_at: '2026-07-20T12:00:10.000Z',
    completed_at: null,
  };

  nextBody = { items: [job], next_cursor: 'job-next' };
  const listed = await listIntelligenceJobs(PROJECT_ID, 'job cursor/1');
  nextBody = { ...job, cancellable: true };
  const loaded = await getIntelligenceJob(PROJECT_ID, JOB_ID);
  nextBody = {
    items: [
      {
        event_id: '25000000-0000-4000-a000-000000000001',
        job_id: JOB_ID,
        cursor: '1',
        type: 'progress',
        payload: { progress: 0.5 },
        created_at: '2026-07-20T12:01:00.000Z',
      },
    ],
    next_cursor: 'event-next',
  };
  const events = await getIntelligenceJobEvents(PROJECT_ID, JOB_ID, 'event cursor/1');
  nextBody = { ...job, status: 'cancelled' };
  const cancelled = await cancelIntelligenceJob(PROJECT_ID, JOB_ID);

  expect(listed.items[0]?.job_id).toBe(JOB_ID);
  expect(loaded.cancellable).toBe(true);
  expect(events.items[0]?.type).toBe('progress');
  expect(cancelled.status).toBe('cancelled');
  expect(requests.slice(0, 4).map(({ url, method }) => [url, method])).toEqual([
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/jobs?cursor=job%20cursor%2F1`, 'GET'],
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}`, 'GET'],
    [
      `http://test.local/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/events?cursor=event%20cursor%2F1`,
      'GET',
    ],
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/jobs/${JOB_ID}/cancel`, 'POST'],
  ]);
});

test('creates and finalizes a browser-safe project image upload', async () => {
  const uploadRequest = {
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'c'.repeat(64),
    metadata: { filename: 'reference.png' },
  };
  nextBody = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`,
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'c'.repeat(64),
    signed_upload_url: 'https://objects.example.test/upload?signature=opaque',
    signed_upload_headers: {
      'content-type': 'image/png',
      'x-amz-checksum-sha256': 'Y2hlY2tzdW0=',
    },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };
  const upload = await createIntelligenceUpload(PROJECT_ID, uploadRequest);

  const asset = {
    asset_id: ASSET_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_job_id: null,
    kind: 'image',
    mime_type: 'image/png',
    bucket: 'private-studio',
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`,
    checksum_sha256: 'c'.repeat(64),
    size_bytes: 2048,
    width: 1024,
    height: 1024,
    metadata: { filename: 'reference.png' },
    created_at: '2026-07-20T12:02:00.000Z',
  };
  nextBody = asset;
  const finalized = await finalizeIntelligenceUpload(PROJECT_ID, UPLOAD_ID);

  expect(upload.signed_upload_headers['content-type']).toBe('image/png');
  expect(finalized.asset_id).toBe(ASSET_ID);
  expect(requests.slice(0, 2)).toEqual([
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/studio/uploads`,
      method: 'POST',
      body: uploadRequest,
    },
    {
      url: `http://test.local/v1/projects/${PROJECT_ID}/studio/uploads/${UPLOAD_ID}/finalize`,
      method: 'POST',
      body: {},
    },
  ]);
});

test('lists, gets, and downloads project-owned image assets', async () => {
  const asset = {
    asset_id: ASSET_ID,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_job_id: JOB_ID,
    kind: 'image',
    mime_type: 'image/webp',
    bucket: 'private-studio',
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/jobs/${JOB_ID}/result.webp`,
    checksum_sha256: 'd'.repeat(64),
    size_bytes: 4096,
    width: 1280,
    height: 720,
    metadata: { variant: 1 },
    created_at: '2026-07-20T12:03:00.000Z',
  };

  nextBody = { items: [asset], next_cursor: 'asset-next' };
  const listed = await listIntelligenceAssets(PROJECT_ID, 'asset cursor/1');
  nextBody = asset;
  const loaded = await getIntelligenceAsset(PROJECT_ID, ASSET_ID);
  nextBody = {
    asset_id: ASSET_ID,
    signed_download_url: 'https://objects.example.test/download?signature=opaque',
    expires_at: '2026-07-20T12:18:00.000Z',
  };
  const download = await createIntelligenceAssetDownloadUrl(PROJECT_ID, ASSET_ID);

  expect(listed.items[0]?.source_job_id).toBe(JOB_ID);
  expect(loaded.asset_id).toBe(ASSET_ID);
  expect(download.signed_download_url).toStartWith('https://objects.example.test/');
  expect(requests.slice(0, 3).map(({ url, method }) => [url, method])).toEqual([
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/assets?cursor=asset%20cursor%2F1`, 'GET'],
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/assets/${ASSET_ID}`, 'GET'],
    [`http://test.local/v1/projects/${PROJECT_ID}/studio/assets/${ASSET_ID}/download-url`, 'POST'],
  ]);
});

test('rejects a malformed upload checksum before returning it to consumers', async () => {
  nextBody = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`,
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'z'.repeat(64),
    signed_upload_url: 'https://objects.example.test/upload?signature=opaque',
    signed_upload_headers: { 'content-type': 'image/png' },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };

  await expect(
    createIntelligenceUpload(PROJECT_ID, {
      declared_mime_type: 'image/png',
      expected_size_bytes: 2048,
      expected_checksum_sha256: 'c'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'INTELLIGENCE_PROTOCOL_ERROR' });
});

test('fails closed on extra fields, cross-project data, unsafe headers, and unsafe URLs', async () => {
  const validUpload = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/source.png`,
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'c'.repeat(64),
    signed_upload_url: 'https://objects.example.test/upload?signature=opaque',
    signed_upload_headers: { 'content-type': 'image/png' },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };
  const request = {
    declared_mime_type: 'image/png',
    expected_size_bytes: 2048,
    expected_checksum_sha256: 'c'.repeat(64),
  };
  const invalidBodies = [
    { ...validUpload, extra: true },
    { ...validUpload, project_id: '12000000-0000-4000-a000-000000000099' },
    { ...validUpload, signed_upload_headers: { authorization: 'Bearer private' } },
    { ...validUpload, signed_upload_url: 'http://storage.example.test/private?token=secret' },
    { ...validUpload, signed_upload_url: 'ftp://storage.example.test/private' },
    { ...validUpload, signed_upload_url: 'file:///private/upload' },
    { ...validUpload, signed_upload_url: 'data:text/plain,private' },
  ];

  for (const body of invalidBodies) {
    nextBody = body;
    let thrown: unknown;
    try {
      await createIntelligenceUpload(PROJECT_ID, request);
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string } | undefined)?.code).toBe('INTELLIGENCE_PROTOCOL_ERROR');
    expect(String(thrown)).not.toContain('storage.example.test');
    expect(String(thrown)).not.toContain('Bearer private');
  }
});

test('rejects zero-sized uploads before exposing a parsed response', async () => {
  nextBody = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: 'uploads/source.png',
    declared_mime_type: 'image/png',
    expected_size_bytes: 0,
    expected_checksum_sha256: 'c'.repeat(64),
    signed_upload_url: 'https://objects.example.test/upload?signature=opaque',
    signed_upload_headers: { 'content-type': 'image/png' },
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };

  await expect(
    createIntelligenceUpload(PROJECT_ID, {
      declared_mime_type: 'image/png',
      expected_size_bytes: 1,
      expected_checksum_sha256: 'c'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'INTELLIGENCE_PROTOCOL_ERROR' });
});

test('preserves stable Studio error codes while redacting response details', async () => {
  nextStatus = 429;
  nextBody = {
    error: 'provider response contains https://private.example.test/token=secret',
    code: 'STUDIO_PROVIDER_RATE_LIMITED',
  };

  let thrown: unknown;
  try {
    await estimateIntelligenceImage(PROJECT_ID, estimateRequest);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ code: 'STUDIO_PROVIDER_RATE_LIMITED', status: 429 });
  expect(String(thrown)).not.toContain('private.example.test');
  expect(String(thrown)).not.toContain('token=secret');
});

test('preserves stable Studio codes wrapped by the shared billing error at HTTP 402', async () => {
  nextStatus = 402;
  nextBody = {
    error: 'credits unavailable',
    code: 'STUDIO_INSUFFICIENT_CREDITS',
  };

  await expect(estimateIntelligenceImage(PROJECT_ID, estimateRequest)).rejects.toMatchObject({
    code: 'STUDIO_INSUFFICIENT_CREDITS',
    status: 402,
  });
});

test('accepts only safe upload headers and loopback HTTP signed URLs', async () => {
  const base = {
    upload_id: UPLOAD_ID,
    project_id: PROJECT_ID,
    asset_id: null,
    object_key: 'uploads/source.png',
    declared_mime_type: 'image/png',
    expected_size_bytes: 1,
    expected_checksum_sha256: 'c'.repeat(64),
    expires_at: '2026-07-20T12:15:00.000Z',
    status: 'pending',
  };

  for (const host of ['localhost', '127.0.0.1', '127.255.255.254', '[::1]']) {
    nextBody = {
      ...base,
      signed_upload_url: `http://${host}/upload`,
      signed_upload_headers: {
        'content-type': 'image/png',
        'x-test-header': 'safe',
      },
    };
    const upload = await createIntelligenceUpload(PROJECT_ID, {
      declared_mime_type: 'image/png',
      expected_size_bytes: 1,
      expected_checksum_sha256: 'c'.repeat(64),
    });
    expect(upload.signed_upload_url).toStartWith(`http://${host}/`);
  }

  for (const headers of [
    { authorization: 'Bearer secret' },
    { cookie: 'session=secret' },
    { host: 'objects.example.test' },
    { 'content-length': '1' },
    { 'x-test-header\n': 'safe' },
    { 'x-test-header\r': 'safe' },
    { 'x-test-header\0': 'safe' },
    { 'x-test-header': 'line\rbreak' },
    { 'x-test-header': 'line\nbreak' },
    { 'x-test-header': 'nul\0break' },
    { 'x-test-header': `x${'a'.repeat(2048)}` },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`x-test-${index}`, 'safe'])),
  ]) {
    nextBody = {
      ...base,
      signed_upload_url: 'https://objects.example.test/upload',
      signed_upload_headers: headers,
    };
    await expect(
      createIntelligenceUpload(PROJECT_ID, {
        declared_mime_type: 'image/png',
        expected_size_bytes: 1,
        expected_checksum_sha256: 'c'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'INTELLIGENCE_PROTOCOL_ERROR' });
  }
});

test('rejects malformed UUIDs in every Studio response family', async () => {
  const cases: Array<{ body: unknown; request: () => Promise<unknown> }> = [
    {
      body: {
        estimate_id: 'not-a-uuid',
        estimate_token: 'studio-estimate-v2.payload.signature',
        expires_at: '2026-07-20T12:15:00.000Z',
        currency: 'credits',
        provider_cost_credits: 1,
        platform_cost_credits: 0,
        max_approved_credits: 1,
        input_hash: `sha256:${'a'.repeat(64)}`,
        line_items: [],
      },
      request: () => estimateIntelligenceImage(PROJECT_ID, estimateRequest),
    },
    {
      body: jobResponse({ job_id: 'not-a-uuid' }),
      request: () => getIntelligenceJob(PROJECT_ID, JOB_ID),
    },
    {
      body: {
        items: [
          {
            event_id: 'not-a-uuid',
            job_id: JOB_ID,
            cursor: '1',
            type: 'queued',
            payload: {},
            created_at: '2026-07-20T12:00:00.000Z',
          },
        ],
        next_cursor: null,
      },
      request: () => getIntelligenceJobEvents(PROJECT_ID, JOB_ID),
    },
    {
      body: uploadResponse({ upload_id: 'not-a-uuid' }),
      request: () =>
        createIntelligenceUpload(PROJECT_ID, {
          declared_mime_type: 'image/png',
          expected_size_bytes: 1,
          expected_checksum_sha256: 'c'.repeat(64),
        }),
    },
    {
      body: assetResponse({ asset_id: 'not-a-uuid' }),
      request: () => getIntelligenceAsset(PROJECT_ID, ASSET_ID),
    },
    {
      body: {
        asset_id: 'not-a-uuid',
        signed_download_url: 'https://objects.example.test/download',
        expires_at: '2026-07-20T12:15:00.000Z',
      },
      request: () => createIntelligenceAssetDownloadUrl(PROJECT_ID, ASSET_ID),
    },
  ];

  for (const scenario of cases) {
    nextBody = scenario.body;
    await expect(scenario.request()).rejects.toMatchObject({
      code: 'INTELLIGENCE_PROTOCOL_ERROR',
    });
  }
});

test('encodes every project, resource, and cursor value in Studio request URLs', async () => {
  const segment = 'id /?#% ü';
  const encoded = encodeURIComponent(segment);
  nextStatus = 404;
  nextBody = { error: 'not found', code: 'STUDIO_VALIDATION_ERROR' };
  const operations = [
    () => estimateIntelligenceImage(segment, estimateRequest),
    () => listIntelligenceJobs(segment, segment),
    () => getIntelligenceJob(segment, segment),
    () => getIntelligenceJobEvents(segment, segment, segment),
    () => cancelIntelligenceJob(segment, segment),
    () =>
      createIntelligenceUpload(segment, {
        declared_mime_type: 'image/png',
        expected_size_bytes: 1,
        expected_checksum_sha256: 'c'.repeat(64),
      }),
    () => finalizeIntelligenceUpload(segment, segment),
    () => listIntelligenceAssets(segment, segment),
    () => getIntelligenceAsset(segment, segment),
    () => createIntelligenceAssetDownloadUrl(segment, segment),
  ];

  for (const operation of operations) {
    try {
      await operation();
    } catch {
      // The 404 is intentional; this test observes only the outbound URL contract.
    }
  }

  expect(requests.map(({ url }) => url)).toEqual([
    `http://test.local/v1/projects/${encoded}/studio/estimates`,
    `http://test.local/v1/projects/${encoded}/studio/jobs?cursor=${encoded}`,
    `http://test.local/v1/projects/${encoded}/studio/jobs/${encoded}`,
    `http://test.local/v1/projects/${encoded}/studio/jobs/${encoded}/events?cursor=${encoded}`,
    `http://test.local/v1/projects/${encoded}/studio/jobs/${encoded}/cancel`,
    `http://test.local/v1/projects/${encoded}/studio/uploads`,
    `http://test.local/v1/projects/${encoded}/studio/uploads/${encoded}/finalize`,
    `http://test.local/v1/projects/${encoded}/studio/assets?cursor=${encoded}`,
    `http://test.local/v1/projects/${encoded}/studio/assets/${encoded}`,
    `http://test.local/v1/projects/${encoded}/studio/assets/${encoded}/download-url`,
  ]);
});

test('maps unrecognized backend error codes to the stable Intelligence fallback', async () => {
  nextStatus = 500;
  nextBody = {
    error: 'secret backend detail',
    code: 'STUDIO_UNPUBLISHED_INTERNAL_CODE',
  };

  await expect(estimateIntelligenceImage(PROJECT_ID, estimateRequest)).rejects.toMatchObject({
    code: 'INTELLIGENCE_REQUEST_FAILED',
    status: 500,
  });
});

test('rejects unpublished Studio job error codes in successful responses', async () => {
  nextBody = jobResponse({
    status: 'failed',
    error_code: 'STUDIO_UNPUBLISHED_INTERNAL_CODE',
    error_message: 'sanitized failure',
  });

  await expect(getIntelligenceJob(PROJECT_ID, JOB_ID)).rejects.toMatchObject({
    code: 'INTELLIGENCE_PROTOCOL_ERROR',
  });
});

test('rejects camel-case provider payload keys in parsed metadata', async () => {
  nextBody = assetResponse({
    metadata: { rawProviderBody: { value: 'hidden' } },
  });

  await expect(getIntelligenceAsset(PROJECT_ID, ASSET_ID)).rejects.toMatchObject({
    code: 'INTELLIGENCE_PROTOCOL_ERROR',
  });
});
