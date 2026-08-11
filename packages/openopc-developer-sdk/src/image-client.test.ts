import { describe, expect, test } from 'bun:test';

import {
  type OpenOpcImageAsset,
  type OpenOpcImageEstimate,
  OpenOpcImageEventHistoryError,
  type OpenOpcImageJob,
  OpenOpcImagePaginationError,
  OpenOpcModuleProtocolError,
  createOpenOpcModuleClient,
} from './index';

const MODEL_ID = 'image-model';
const JOB_ID = '70000000-0000-4000-8000-000000000001';
const ASSET_ID = '80000000-0000-4000-8000-000000000001';
const EVENT_ID = '90000000-0000-4000-8000-000000000001';
const ESTIMATE_ID = 'a0000000-0000-4000-8000-000000000001';
const ESTIMATE_TOKEN = 'estimate-token-000001';

const IMAGE_INPUT = {
  prompt: 'A small red house under a clear sky',
  aspect_ratio: '1:1' as const,
  quality: 'standard' as const,
  output_count: 1,
};

const IMAGE_MODEL = {
  id: MODEL_ID,
  object: 'image.model' as const,
  owned_by: 'platform-image',
  name: 'Platform Image',
  capabilities: {
    prompt: { max_characters: 8000, max_negative_prompt_characters: 4000 },
    reference_images: {
      max_images: 4,
      max_bytes_per_image: 50 * 1024 * 1024,
      max_total_bytes: 100 * 1024 * 1024,
      accepted_mime_types: ['image/png', 'image/jpeg'] as const,
    },
    output: {
      min_images: 1,
      max_images: 4,
      max_bytes_per_image: 50 * 1024 * 1024,
      accepted_mime_types: ['image/png', 'image/jpeg'] as const,
      aspect_ratios: ['1:1', '4:3'] as const,
      qualities: ['standard', 'high'] as const,
    },
  },
};

const ESTIMATE: OpenOpcImageEstimate = {
  estimate_id: ESTIMATE_ID,
  estimate_token: ESTIMATE_TOKEN,
  expires_at: '2099-08-01T00:05:00.000Z',
  valid_for_ms: 300_000,
  retry: { on_expired: 'create-new-estimate', automatic_job_retry: false },
  currency: 'credits',
  provider_cost_credits: 2,
  platform_cost_credits: 1,
  max_approved_credits: 3,
  quota: {
    required_credits: 3,
    available_credits: 20,
    remaining_after_estimate_credits: 17,
  },
  settlement: {
    succeeded: 'settle-actual-usage',
    failed: 'release-reservation',
    cancelled: 'release-reservation',
    maximum_charge_credits: 3,
  },
  input_hash: 'input-hash-000001',
  line_items: [{ label: 'generation', credits: 3 }],
};

function job(status: OpenOpcImageJob['status']): OpenOpcImageJob {
  return {
    job_id: JOB_ID,
    model: MODEL_ID,
    input: IMAGE_INPUT,
    status,
    attempt_count: status === 'queued' ? 0 : 1,
    reserved_credits: 3,
    actual_credits: status === 'succeeded' ? 2 : null,
    error_code: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:01.000Z',
    started_at: status === 'queued' ? null : '2026-08-01T00:00:01.000Z',
    completed_at: ['succeeded', 'failed', 'cancelled'].includes(status)
      ? '2026-08-01T00:00:02.000Z'
      : null,
    cancellable: !['succeeded', 'failed', 'cancelled'].includes(status),
  };
}

const ASSET: OpenOpcImageAsset = {
  asset_id: ASSET_ID,
  source: { job_id: JOB_ID, prompt: IMAGE_INPUT.prompt },
  kind: 'image',
  mime_type: 'image/png',
  checksum_sha256: 'a'.repeat(64),
  size_bytes: 3,
  width: 1,
  height: 1,
  metadata: { filename: 'house.png' },
  retention: { policy: 'temporary', expires_at: '2099-08-01T01:00:00.000Z', deletable: true },
  created_at: '2026-08-01T00:00:02.000Z',
};

function createImageClient(
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  const capabilities: unknown[] = [];
  const client = createOpenOpcModuleClient({
    baseUrl: 'https://platform.example.com',
    async getCapabilityToken(input) {
      capabilities.push(input);
      return 'v4.public.module-token';
    },
    fetch,
  });
  return { client, capabilities };
}

describe('OpenOPC image SDK', () => {
  test('uses the image.generate capability and parses image model, estimate, and job responses', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { client, capabilities } = createImageClient(async (input, init) => {
      requests.push({ url: String(input), init });
      const url = String(input);
      if (url.endsWith('/images/models'))
        return new Response(JSON.stringify({ data: [IMAGE_MODEL] }));
      if (url.endsWith('/estimates')) return new Response(JSON.stringify(ESTIMATE));
      if (url.endsWith('/jobs') && init?.method === 'POST')
        return new Response(JSON.stringify(job('queued')));
      return new Response(JSON.stringify(job('running')));
    });

    await expect(client.ai.images.models.list()).resolves.toEqual({ data: [IMAGE_MODEL] });
    await expect(
      client.ai.images.estimates.create({ model: MODEL_ID, input: IMAGE_INPUT }),
    ).resolves.toEqual(ESTIMATE);
    await expect(
      client.ai.images.jobs.create({
        model: MODEL_ID,
        input: IMAGE_INPUT,
        estimate_id: ESTIMATE_ID,
        estimate_token: ESTIMATE_TOKEN,
        idempotency_key: 'image-job-00000001',
      }),
    ).resolves.toEqual(job('queued'));

    expect(capabilities).toEqual([
      { service: 'ai', operation: 'image.generate' },
      { service: 'ai', operation: 'image.generate' },
      { service: 'ai', operation: 'image.generate' },
    ]);
    expect(requests[0]?.url).toBe(
      'https://platform.example.com/v1/module-services/ai/images/models',
    );
    expect(requests[2]?.init?.headers).toBeDefined();
    expect(new Headers(requests[2]?.init?.headers).get('idempotency-key')).toBe(
      'image-job-00000001',
    );
    expect(new Headers(requests[2]?.init?.headers).get('authorization')).toBe(
      'Bearer v4.public.module-token',
    );
  });

  test('lists module-owned jobs through the dedicated paginated endpoint', async () => {
    const requests: string[] = [];
    const { client } = createImageClient(async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ items: [job('running')], next_cursor: 'next-job' }));
    });

    await expect(
      client.ai.images.jobs.list({
        cursor: 'previous-job',
        limit: 20,
        status: 'running',
        created_after: '2026-08-07T00:00:00.000Z',
        created_before: '2026-08-08T00:00:00.000Z',
      }),
    ).resolves.toEqual({ items: [job('running')], next_cursor: 'next-job' });
    expect(requests).toEqual([
      'https://platform.example.com/v1/module-services/ai/images/jobs?cursor=previous-job&limit=20&status=running&created_after=2026-08-07T00%3A00%3A00.000Z&created_before=2026-08-08T00%3A00%3A00.000Z',
    ]);
  });

  test('waits with a cursor, emits progress and retry updates, and returns a terminal job', async () => {
    const requests: string[] = [];
    let reads = 0;
    const updates: Array<{
      event?: string;
      progress?: number;
      retryAfterMs?: number;
      status: string;
    }> = [];
    const events = [
      {
        event_id: EVENT_ID,
        job_id: JOB_ID,
        cursor: 'cursor-1',
        type: 'progress' as const,
        progress: 0.4,
        created_at: '2026-08-01T00:00:01.000Z',
      },
      {
        event_id: '90000000-0000-4000-8000-000000000002',
        job_id: JOB_ID,
        cursor: 'cursor-2',
        type: 'retry-scheduled' as const,
        retry_after_ms: 50,
        created_at: '2026-08-01T00:00:01.500Z',
      },
    ];
    const { client } = createImageClient(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/events?cursor=seed&limit=100')) {
        return new Response(JSON.stringify({ items: events, next_cursor: null }));
      }
      if (url.includes('/events?cursor=cursor-2')) {
        return new Response(JSON.stringify({ items: [], next_cursor: null }));
      }
      reads += 1;
      return new Response(JSON.stringify(job(reads >= 3 ? 'succeeded' : 'running')));
    });

    const result = await client.ai.images.jobs.waitForTerminal(JOB_ID, {
      cursor: 'seed',
      pollIntervalMs: 50,
      onUpdate(update) {
        updates.push({
          event: update.event?.type,
          progress: update.progress,
          retryAfterMs: update.retryAfterMs,
          status: update.job.status,
        });
      },
    });

    expect(result.status).toBe('succeeded');
    expect(requests.some((url) => url.includes('cursor=seed'))).toBe(true);
    expect(requests.some((url) => url.includes('cursor=cursor-2'))).toBe(true);
    expect(updates).toContainEqual({
      event: 'progress',
      progress: 0.4,
      retryAfterMs: undefined,
      status: 'running',
    });
    expect(updates).toContainEqual({
      event: 'retry-scheduled',
      progress: undefined,
      retryAfterMs: 50,
      status: 'running',
    });
  });

  test('subscribes from an initial page and falls back to status polling when event history is unavailable', async () => {
    let statusReads = 0;
    let eventReads = 0;
    const updates: Array<{
      event?: string;
      eventHistory: string;
      eventErrorCode?: string;
      terminal: boolean;
    }> = [];
    const initialEventPage = {
      items: [
        {
          event_id: EVENT_ID,
          job_id: JOB_ID,
          cursor: 'initial-cursor',
          type: 'progress' as const,
          progress: 0.25,
          created_at: '2026-08-01T00:00:01.000Z',
        },
        {
          event_id: '90000000-0000-4000-8000-000000000002',
          job_id: JOB_ID,
          cursor: 'terminal-cursor',
          type: 'succeeded' as const,
          created_at: '2026-08-01T00:00:02.000Z',
        },
      ],
      next_cursor: 'terminal-cursor',
    };
    const { client } = createImageClient(async (input) => {
      if (String(input).includes('/events')) {
        eventReads += 1;
        return new Response(JSON.stringify({ error: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE' }), {
          status: 503,
        });
      }
      statusReads += 1;
      return new Response(JSON.stringify(job(statusReads >= 3 ? 'succeeded' : 'running')));
    });

    for await (const update of client.ai.images.jobs.subscribe(JOB_ID, {
      initialEventPage,
      pollIntervalMs: 50,
      onUpdate(value) {
        updates.push({
          event: value.event?.type,
          eventHistory: value.eventHistory,
          eventErrorCode: value.eventErrorCode,
          terminal: value.terminal,
        });
      },
    })) {
      if (update.terminal && update.job.status === 'succeeded') break;
    }

    expect(eventReads).toBe(1);
    expect(statusReads).toBe(3);
    expect(updates).toContainEqual({
      event: 'progress',
      eventHistory: 'available',
      eventErrorCode: undefined,
      terminal: false,
    });
    expect(updates).toContainEqual({
      event: 'succeeded',
      eventHistory: 'available',
      eventErrorCode: undefined,
      terminal: true,
    });
    expect(updates).toContainEqual({
      event: undefined,
      eventHistory: 'unavailable',
      eventErrorCode: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE',
      terminal: false,
    });
  });

  test('can make event history failure explicit without exposing transport details', async () => {
    const { client } = createImageClient(async (input) => {
      if (String(input).includes('/events')) {
        return new Response(JSON.stringify({ error: 'OPENOPC_IMAGE_EVENT_CURSOR_EXPIRED' }), {
          status: 409,
        });
      }
      return new Response(JSON.stringify(job('running')));
    });

    await expect(
      client.ai.images.jobs.waitForTerminal(JOB_ID, {
        eventFailureMode: 'error',
        timeoutMs: 500,
        pollIntervalMs: 50,
      }),
    ).rejects.toBeInstanceOf(OpenOpcImageEventHistoryError);
  });

  test('aborts immediately after event history falls back to status polling', async () => {
    let notifyEventAttempted: () => void = () => undefined;
    const eventAttempted = new Promise<void>((resolve) => {
      notifyEventAttempted = resolve;
    });
    let statusReads = 0;
    const { client } = createImageClient(async (input) => {
      if (String(input).includes('/events')) {
        notifyEventAttempted();
        return new Response(JSON.stringify({ error: 'OPENOPC_IMAGE_EVENT_HISTORY_UNAVAILABLE' }), {
          status: 503,
        });
      }
      statusReads += 1;
      if (statusReads === 1) return new Response(JSON.stringify(job('running')));
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const pending = client.ai.images.jobs.waitForTerminal(JOB_ID, {
      signal: controller.signal,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });

    await eventAttempted;
    await Promise.resolve();
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_ABORTED',
    });
  });

  test('paginates assets, creates multipart uploads, and exposes preview/retention/delete/download helpers', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const { client } = createImageClient(async (input, init) => {
      requests.push({ url: String(input), init });
      const url = String(input);
      if (url.includes(`/jobs/${JOB_ID}/outputs`)) {
        return new Response(JSON.stringify({ items: [ASSET], next_cursor: null }));
      }
      if (url.includes('source_job_id=')) {
        return new Response(JSON.stringify({ items: [ASSET], next_cursor: null }));
      }
      if (url.endsWith('/assets?limit=1')) {
        return new Response(JSON.stringify({ items: [ASSET], next_cursor: 'asset-cursor' }));
      }
      if (url.includes('/assets?cursor=asset-cursor')) {
        return new Response(
          JSON.stringify({
            items: [ASSET, { ...ASSET, asset_id: '80000000-0000-4000-8000-000000000002' }],
            next_cursor: null,
          }),
        );
      }
      if (url.endsWith('/preview-url')) {
        return new Response(
          JSON.stringify({
            asset_id: ASSET_ID,
            url: 'https://cdn.example.com/short-lived/asset',
            expires_at: '2099-08-01T01:00:00.000Z',
          }),
        );
      }
      if (url.endsWith('/thumbnail-url?preset=small')) {
        return new Response(
          JSON.stringify({
            asset_id: ASSET_ID,
            preset: 'small',
            url: 'https://cdn.example.com/short-lived/thumb.webp',
            mime_type: 'image/webp',
            width: 1,
            height: 1,
            size_bytes: 42,
            cache: { visibility: 'private', max_age_seconds: 900, immutable: true },
            expires_at: '2099-08-01T01:00:00.000Z',
          }),
        );
      }
      if (url.endsWith('/download')) return new Response(new Blob(['png'], { type: 'image/png' }));
      if (url.endsWith('/delete'))
        return new Response(JSON.stringify({ asset_id: ASSET_ID, deleted: true }));
      if (url.endsWith('/retention')) return new Response(JSON.stringify(ASSET));
      return new Response(JSON.stringify(ASSET));
    });

    const all = await client.ai.images.assets.listAll({ limit: 1 });
    expect(all).toHaveLength(2);
    expect(new Set(all.map((asset) => asset.asset_id)).size).toBe(2);
    await expect(client.ai.images.assets.listAll({ limit: 1, maxItems: 1 })).resolves.toEqual([
      ASSET,
    ]);
    const uploaded = await client.ai.images.assets.create(
      new Blob(['png'], { type: 'image/png' }),
      {
        filename: 'house.png',
        retention: 'retained',
      },
    );
    expect(uploaded).toEqual(ASSET);
    const preview = await client.ai.images.assets.preview(ASSET_ID);
    expect(preview.asset_id).toBe(ASSET_ID);
    const filtered = await client.ai.images.assets.list({
      limit: 1,
      source: 'generated',
      source_job_id: JOB_ID,
      created_after: '2026-08-07T00:00:00.000Z',
      created_before: '2026-08-08T00:00:00.000Z',
    });
    expect(filtered.items).toEqual([ASSET]);
    const outputPage = await client.ai.images.jobs.outputs(JOB_ID, { limit: 1 });
    expect(outputPage.items).toEqual([ASSET]);
    const thumbnail = await client.ai.images.assets.thumbnail(ASSET_ID, { preset: 'small' });
    expect(thumbnail).toMatchObject({
      asset_id: ASSET_ID,
      preset: 'small',
      mime_type: 'image/webp',
    });
    await expect(client.ai.images.assets.download(ASSET_ID)).resolves.toBeInstanceOf(Blob);
    await expect(client.ai.images.assets.delete(ASSET_ID)).resolves.toEqual({
      asset_id: ASSET_ID,
      deleted: true,
    });
    await expect(client.ai.images.assets.setRetention(ASSET_ID, 'retained')).resolves.toEqual(
      ASSET,
    );

    const upload = requests.find((request) => request.init?.body instanceof FormData);
    expect(upload).toBeDefined();
    expect((upload?.init?.body as FormData).get('filename')).toBe('house.png');
    expect(requests.some((request) => request.url.includes('cursor=asset-cursor'))).toBe(true);
    const filteredRequest = requests.find((request) => request.url.includes('source_job_id='));
    expect(filteredRequest).toBeDefined();
    const filteredUrl = new URL(filteredRequest?.url ?? 'https://invalid.test');
    expect(filteredUrl.searchParams.get('source_job_id')).toBe(JOB_ID);
    expect(filteredUrl.searchParams.get('source')).toBe('generated');
    expect(filteredUrl.searchParams.get('created_after')).toBe('2026-08-07T00:00:00.000Z');
    expect(filteredUrl.searchParams.get('created_before')).toBe('2026-08-08T00:00:00.000Z');
  });

  test('rejects a repeated asset cursor instead of looping forever', async () => {
    const { client } = createImageClient(async (input) => {
      const url = String(input);
      if (url.endsWith('/assets')) {
        return new Response(JSON.stringify({ items: [], next_cursor: 'loop-cursor' }));
      }
      return new Response(JSON.stringify({ items: [], next_cursor: 'loop-cursor' }));
    });

    const pages = client.ai.images.assets.pages();
    await expect(
      (async () => {
        for await (const _page of pages) {
          // Consume until the iterator detects the repeated cursor.
        }
      })(),
    ).rejects.toBeInstanceOf(OpenOpcImagePaginationError);
  });

  test('rejects oversized or non-image downloads and maps wait timeout without provider details', async () => {
    const { client } = createImageClient(async (input) => {
      if (String(input).endsWith('/download'))
        return new Response(new Blob(['text'], { type: 'text/plain' }));
      return new Promise<Response>(() => undefined);
    });

    await expect(client.ai.images.assets.download(ASSET_ID)).rejects.toBeInstanceOf(
      OpenOpcModuleProtocolError,
    );
    await expect(
      client.ai.images.assets.create(new Blob(['text'], { type: 'text/plain' })),
    ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    await expect(
      client.ai.images.assets.create(new Blob([], { type: 'image/png' })),
    ).rejects.toBeInstanceOf(OpenOpcModuleProtocolError);
    await expect(
      client.ai.images.jobs.waitForTerminal(JOB_ID, { timeoutMs: 50, pollIntervalMs: 50 }),
    ).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_TIMEOUT',
    });
    expect(() =>
      client.ai.images.estimates.isExpired({ ...ESTIMATE, expires_at: 'not-a-date' }),
    ).not.toThrow();
    expect(client.ai.images.estimates.retryGuidance('OPENOPC_IMAGE_ESTIMATE_EXPIRED')).toEqual({
      action: 'create-new-estimate',
      can_reestimate: true,
      retry_same_estimate: false,
    });

    const preAbortedController = new AbortController();
    preAbortedController.abort();
    await expect(
      client.ai.images.jobs.waitForTerminal(JOB_ID, {
        signal: preAbortedController.signal,
        timeoutMs: 500,
        pollIntervalMs: 50,
      }),
    ).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_ABORTED',
    });

    const abortClient = createImageClient(
      async () => new Promise<Response>(() => undefined),
    ).client;
    const controller = new AbortController();
    const pending = abortClient.ai.images.jobs.waitForTerminal(JOB_ID, {
      signal: controller.signal,
      timeoutMs: 500,
      pollIntervalMs: 50,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: 'OpenOpcModuleRequestError',
      code: 'OPENOPC_MODULE_REQUEST_ABORTED',
    });

    const errorClient = createImageClient(
      async () =>
        new Response(JSON.stringify({ error: 'OPENOPC_IMAGE_JOB_NOT_FOUND' }), { status: 404 }),
    ).client;
    await expect(errorClient.ai.images.jobs.get(JOB_ID)).rejects.toMatchObject({
      name: 'OpenOpcModuleServiceError',
      code: 'OPENOPC_IMAGE_JOB_NOT_FOUND',
    });
  });
});
