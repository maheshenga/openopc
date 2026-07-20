#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { chromium, type Page, type Route } from 'playwright';

type EstimateMode = 'success' | 'insufficient' | 'permission';

const baseUrl = process.env.E2E_BASE_URL || 'http://localhost:3300';
const resultsDir = fileURLToPath(new URL('../../test-results/', import.meta.url));

const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const USER_ID = '11500000-0000-4000-a000-000000000001';
const PROVIDER_CONFIG_ID = '14000000-0000-4000-a000-000000000001';
const ESTIMATE_ID = '15000000-0000-4000-a000-000000000001';
const TASK_ID = '16000000-0000-4000-a000-000000000001';
const CANCEL_TASK_ID = '16000000-0000-4000-a000-000000000002';
const JOB_ID = '17000000-0000-4000-a000-000000000001';
const CANCEL_JOB_ID = '17000000-0000-4000-a000-000000000002';
const ASSET_ID = '18000000-0000-4000-a000-000000000001';
const UPLOAD_ID = '19000000-0000-4000-a000-000000000001';
const REFERENCE_ASSET_ID = '1a000000-0000-4000-a000-000000000001';
const CARD_HASH = 'a'.repeat(64);
const ESTIMATE_TOKEN = 'studio-estimate-v2.debug-payload.debug-signature';
const NOW = '2026-07-20T12:00:00.000Z';
const REFERENCE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const PREVIEW_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="960" viewBox="0 0 960 960">
  <rect width="960" height="960" fill="#f4f3ef"/>
  <rect x="84" y="84" width="792" height="792" rx="24" fill="#161616"/>
  <circle cx="294" cy="304" r="116" fill="#77d8a8"/>
  <path d="M160 694 390 450l142 142 116-128 152 230Z" fill="#f8f8f5"/>
  <text x="480" y="804" text-anchor="middle" font-family="Arial, sans-serif" font-size="44" fill="#f8f8f5">KORTIX IMAGE</text>
</svg>`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function json(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

function taskEvent(
  eventId: string,
  taskId: string,
  jobId: string,
  sequence: number,
  type: 'created' | 'progress' | 'asset_created' | 'succeeded' | 'cancelled',
  status: 'queued' | 'running' | 'succeeded' | 'cancelled',
  extra: Record<string, unknown> = {},
) {
  return {
    protocol_version: 'intelligence.v1',
    event_id: eventId,
    task_id: taskId,
    job_id: jobId,
    sequence,
    type,
    status,
    created_at: NOW,
    ...extra,
  };
}

function asset(assetId: string, sourceJobId: string | null) {
  return {
    asset_id: assetId,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_job_id: sourceJobId,
    kind: 'image',
    mime_type: 'image/png',
    bucket: 'debug-studio-assets',
    object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/assets/${assetId}.png`,
    checksum_sha256: 'b'.repeat(64),
    size_bytes: 4096,
    width: 960,
    height: 960,
    metadata: { fixture: 'image-studio-smoke' },
    created_at: NOW,
  };
}

function studioJob(jobId: string, status: 'running' | 'cancelled') {
  return {
    job_id: jobId,
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    actor_user_id: USER_ID,
    actor_type: 'user',
    capability: 'image.generate',
    provider_config_id: PROVIDER_CONFIG_ID,
    provider: 'fake',
    model: 'fake/image-v1',
    input: {
      capability: 'image.generate',
      image: {
        prompt: 'A clean editorial product image',
        negative_prompt: '',
        reference_asset_ids: [REFERENCE_ASSET_ID],
        aspect_ratio: '1:1',
        quality: 'standard',
        output_count: 1,
      },
    },
    status,
    idempotency_key: 'debug-image-studio-cancel',
    request_hash: `sha256:${'c'.repeat(64)}`,
    attempt_count: 1,
    reserved_credits: 2.5,
    actual_credits: status === 'cancelled' ? 0 : null,
    error_code: null,
    error_message: null,
    created_at: NOW,
    updated_at: NOW,
    started_at: NOW,
    completed_at: status === 'cancelled' ? NOW : null,
    cancellable: status === 'running',
  };
}

async function waitFor(
  description: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function installRoutes(page: Page) {
  let estimateMode: EstimateMode = 'success';
  let estimateCalls = 0;
  let taskCalls = 0;
  let uploadCreateCalls = 0;
  let uploadPutCalls = 0;
  let uploadFinalizeCalls = 0;
  let cancelCalls = 0;
  let downloadUrlCalls = 0;
  let lastEstimateRequest: Record<string, unknown> | null = null;
  let uploadChecksum = 'd'.repeat(64);
  const taskPayloads: Array<Record<string, unknown>> = [];

  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const projectPrefix = `/v1/projects/${PROJECT_ID}`;

    if (url.pathname === '/debug/image-studio-upload') {
      uploadPutCalls += 1;
      assert(request.method() === 'PUT', 'signed upload should use PUT');
      const headers = await request.allHeaders();
      assert(headers['content-type'] === 'image/png', 'signed upload content-type mismatch');
      assert(
        headers['x-amz-checksum-sha256'] === 'debug-checksum-base64',
        'signed upload checksum header mismatch',
      );
      assert(
        headers['x-amz-meta-studio-checksum-sha256'] === uploadChecksum,
        'signed upload metadata checksum mismatch',
      );
      assert(headers.authorization === undefined, 'signed upload must not carry Authorization');
      assert(
        request.postDataBuffer()?.equals(REFERENCE_PNG) === true,
        'signed upload bytes should match the selected file',
      );
      await route.fulfill({ status: 200, body: '' });
      return;
    }

    if (url.pathname === '/debug/image-studio-preview') {
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PREVIEW_SVG });
      return;
    }

    if (url.pathname === '/api/maintenance') {
      await json(route, 200, {
        level: 'none',
        title: '',
        message: '',
        updatedAt: NOW,
      });
      return;
    }

    if (!url.pathname.startsWith(projectPrefix)) {
      if (url.pathname.startsWith('/v1/projects/')) {
        throw new Error(`Unexpected project request: ${request.method()} ${url.pathname}`);
      }
      await route.continue();
      return;
    }

    assert(
      request.headers().authorization === 'Bearer debug-image-studio-token',
      `missing debug auth for ${request.method()} ${url.pathname}`,
    );

    if (url.pathname === `${projectPrefix}/intelligence/capabilities`) {
      await json(route, 200, {
        protocol_version: 'intelligence.v1',
        items: [
          {
            id: 'studio.image.generate',
            version: '1.0.0',
            modality: 'image',
            operation: 'generate',
            input_schema: { type: 'object', name: 'StudioImageGenerateInput' },
            output_schema: { type: 'array', asset_kinds: ['image'] },
            execution: 'async',
            risk: 'write',
            provenance_required: true,
          },
        ],
        execution_targets: [
          {
            capability_id: 'studio.image.generate',
            provider_config_id: PROVIDER_CONFIG_ID,
            model: 'fake/image-v1',
          },
        ],
        next_cursor: null,
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/intelligence/agent-card`) {
      await json(route, 200, {
        id: 'debug-image-agent',
        version: '1.0.0',
        display_name: 'Debug Image Agent',
        capabilities: ['studio.image.generate'],
        protocols: ['mcp', 'a2a'],
        auth: { kind: 'kortix-project-token' },
        trust_tier: 'project',
        limits: { concurrency: 1, max_task_seconds: 900 },
        card_hash: CARD_HASH,
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/studio/estimates`) {
      estimateCalls += 1;
      lastEstimateRequest = request.postDataJSON() as Record<string, unknown>;
      if (estimateMode === 'insufficient') {
        await json(route, 402, {
          error: 'Insufficient credits',
          code: 'STUDIO_INSUFFICIENT_CREDITS',
        });
        return;
      }
      if (estimateMode === 'permission') {
        await json(route, 403, { error: 'Forbidden', code: 'STUDIO_PERMISSION_DENIED' });
        return;
      }
      await json(route, 200, {
        estimate_id: ESTIMATE_ID,
        estimate_token: ESTIMATE_TOKEN,
        expires_at: '2030-07-20T12:15:00.000Z',
        currency: 'credits',
        provider_cost_credits: 2,
        platform_cost_credits: 0.5,
        max_approved_credits: 2.5,
        input_hash: `sha256:${'e'.repeat(64)}`,
        line_items: [
          { label: 'Provider image generation', credits: 2 },
          { label: 'Studio platform fee', credits: 0.5 },
        ],
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/intelligence/tasks`) {
      taskCalls += 1;
      const payload = request.postDataJSON() as Record<string, unknown>;
      taskPayloads.push(payload);
      if (taskCalls === 1) {
        await json(route, 503, {
          error: 'Task executor unavailable',
          code: 'INTELLIGENCE_TASK_EXECUTOR_UNAVAILABLE',
        });
        return;
      }
      const cancelling = taskCalls > 2;
      await json(route, 200, {
        protocol_version: 'intelligence.v1',
        task_id: cancelling ? CANCEL_TASK_ID : TASK_ID,
        job_id: cancelling ? CANCEL_JOB_ID : JOB_ID,
        created: taskCalls !== 2,
      });
      return;
    }

    const taskEventsMatch = url.pathname.match(
      new RegExp(`^${projectPrefix}/intelligence/tasks/([^/]+)/events$`),
    );
    if (taskEventsMatch) {
      const taskId = taskEventsMatch[1];
      if (taskId === CANCEL_TASK_ID) {
        await json(route, 200, {
          protocol_version: 'intelligence.v1',
          task_id: CANCEL_TASK_ID,
          items: [
            taskEvent(
              '31000000-0000-4000-a000-000000000001',
              CANCEL_TASK_ID,
              CANCEL_JOB_ID,
              1,
              'created',
              'queued',
            ),
            taskEvent(
              '31000000-0000-4000-a000-000000000002',
              CANCEL_TASK_ID,
              CANCEL_JOB_ID,
              2,
              'progress',
              'running',
              { progress: 0.35 },
            ),
          ],
          next_cursor: null,
        });
        return;
      }
      if (url.searchParams.get('cursor')) {
        await json(route, 200, {
          protocol_version: 'intelligence.v1',
          task_id: TASK_ID,
          items: [
            taskEvent(
              '30000000-0000-4000-a000-000000000003',
              TASK_ID,
              JOB_ID,
              3,
              'asset_created',
              'running',
              { progress: 0.9, asset_ids: [ASSET_ID] },
            ),
            taskEvent(
              '30000000-0000-4000-a000-000000000004',
              TASK_ID,
              JOB_ID,
              4,
              'succeeded',
              'succeeded',
              { progress: 1, asset_ids: [ASSET_ID] },
            ),
          ],
          next_cursor: null,
        });
        return;
      }
      await json(route, 200, {
        protocol_version: 'intelligence.v1',
        task_id: TASK_ID,
        items: [
          taskEvent(
            '30000000-0000-4000-a000-000000000001',
            TASK_ID,
            JOB_ID,
            1,
            'created',
            'queued',
          ),
          taskEvent(
            '30000000-0000-4000-a000-000000000002',
            TASK_ID,
            JOB_ID,
            2,
            'progress',
            'running',
            { progress: 0.55 },
          ),
        ],
        next_cursor: 'debug-event-cursor-2',
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/studio/uploads`) {
      uploadCreateCalls += 1;
      const payload = request.postDataJSON() as { expected_checksum_sha256: string };
      uploadChecksum = payload.expected_checksum_sha256;
      await json(route, 200, {
        upload_id: UPLOAD_ID,
        project_id: PROJECT_ID,
        asset_id: null,
        object_key: `accounts/${ACCOUNT_ID}/projects/${PROJECT_ID}/uploads/${UPLOAD_ID}/reference.png`,
        declared_mime_type: 'image/png',
        expected_size_bytes: REFERENCE_PNG.length,
        expected_checksum_sha256: uploadChecksum,
        signed_upload_url: `${baseUrl}/debug/image-studio-upload?signature=opaque`,
        signed_upload_headers: {
          'content-type': 'image/png',
          'x-amz-checksum-sha256': 'debug-checksum-base64',
          'x-amz-meta-studio-checksum-sha256': uploadChecksum,
        },
        expires_at: '2030-07-20T12:15:00.000Z',
        status: 'pending',
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/studio/uploads/${UPLOAD_ID}/finalize`) {
      uploadFinalizeCalls += 1;
      await json(route, 200, asset(REFERENCE_ASSET_ID, null));
      return;
    }

    if (url.pathname === `${projectPrefix}/studio/assets`) {
      await json(route, 200, {
        items: [asset(ASSET_ID, JOB_ID), asset(REFERENCE_ASSET_ID, null)],
        next_cursor: null,
      });
      return;
    }

    const downloadMatch = url.pathname.match(
      new RegExp(`^${projectPrefix}/studio/assets/([^/]+)/download-url$`),
    );
    if (downloadMatch) {
      downloadUrlCalls += 1;
      await json(route, 200, {
        asset_id: downloadMatch[1],
        signed_download_url: `${baseUrl}/debug/image-studio-preview?signature=opaque`,
        expires_at: '2030-07-20T12:18:00.000Z',
      });
      return;
    }

    if (url.pathname === `${projectPrefix}/studio/jobs/${CANCEL_JOB_ID}/cancel`) {
      cancelCalls += 1;
      await json(route, 200, studioJob(CANCEL_JOB_ID, 'cancelled'));
      return;
    }

    throw new Error(`Unmocked project request: ${request.method()} ${url.pathname}`);
  });

  return {
    setEstimateMode(mode: EstimateMode) {
      estimateMode = mode;
    },
    estimateCalls: () => estimateCalls,
    taskCalls: () => taskCalls,
    uploadCreateCalls: () => uploadCreateCalls,
    uploadPutCalls: () => uploadPutCalls,
    uploadFinalizeCalls: () => uploadFinalizeCalls,
    cancelCalls: () => cancelCalls,
    downloadUrlCalls: () => downloadUrlCalls,
    lastEstimateRequest: () => lastEstimateRequest,
    taskPayloads: () => taskPayloads,
  };
}

async function assertLayout(page: Page, viewport: 'desktop' | 'mobile') {
  const surface = page.getByTestId('image-studio-accepted');
  const form = surface.locator('form').first();
  const results = surface.locator('section[aria-label="Results"]');
  const toolbar = results.locator('header');
  const tile = results.locator('article').first();
  const [formBox, resultsBox, toolbarBox, tileBox] = await Promise.all([
    form.boundingBox(),
    results.boundingBox(),
    toolbar.boundingBox(),
    tile.boundingBox(),
  ]);
  assert(formBox && resultsBox && toolbarBox && tileBox, 'expected stable Studio layout boxes');
  if (viewport === 'desktop') {
    assert(formBox.x + formBox.width <= resultsBox.x + 1, 'desktop form overlaps results');
  } else {
    assert(formBox.y + formBox.height <= resultsBox.y + 1, 'mobile form overlaps results');
  }
  assert(toolbarBox.y + toolbarBox.height <= tileBox.y + 1, 'results toolbar overlaps image grid');
  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  assert(horizontalOverflow <= 1, `${viewport} page has horizontal overflow`);
}

async function screenshotAndAssertPixels(page: Page, outputPath: string) {
  const screenshot = await page.screenshot({ path: outputPath, fullPage: false });
  const pixels = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const context = canvas.getContext('2d');
    if (!context) return { opaque: 0, unique: 0 };
    context.drawImage(image, 0, 0, 64, 64);
    const data = context.getImageData(0, 0, 64, 64).data;
    const colors = new Set<string>();
    let opaque = 0;
    for (let index = 0; index < data.length; index += 4) {
      if ((data[index + 3] ?? 0) > 0) opaque += 1;
      colors.add(`${data[index]}:${data[index + 1]}:${data[index + 2]}:${data[index + 3]}`);
    }
    return { opaque, unique: colors.size };
  }, screenshot.toString('base64'));
  assert(pixels.opaque > 3_500, `screenshot ${outputPath} is mostly transparent`);
  assert(pixels.unique > 16, `screenshot ${outputPath} appears blank`);
}

async function main() {
  await mkdir(resultsDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => consoleMessages.push(message.text()));
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const routes = await installRoutes(page);

    await page.goto(`${baseUrl}/debug/image-studio`, { waitUntil: 'domcontentloaded' });
    const accepted = page.getByTestId('image-studio-accepted');
    try {
      await accepted.waitFor({ state: 'visible', timeout: 30_000 });
    } catch (error) {
      const bodyText = (await page.locator('body').innerText()).slice(0, 2_000);
      throw new Error(
        [
          'Image Studio did not reach its accepted ready state.',
          `Body: ${bodyText}`,
          `Console: ${consoleMessages.join(' | ')}`,
          `Page errors: ${pageErrors.join(' | ')}`,
        ].join('\n'),
        { cause: error },
      );
    }
    await page
      .getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('A clean editorial product image');
    await page.getByLabel('Add reference image').setInputFiles({
      name: 'reference.png',
      mimeType: 'image/png',
      buffer: REFERENCE_PNG,
    });
    await waitFor(
      'the complete signed reference upload flow',
      () =>
        routes.uploadCreateCalls() === 1 &&
        routes.uploadPutCalls() === 1 &&
        routes.uploadFinalizeCalls() === 1,
    );
    await page.getByText('2.5 credits', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.getByRole('img', { name: 'Generated image 1' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });

    assert(routes.taskCalls() === 2, 'task creation should replay exactly once after 503');
    const [firstTask, replayedTask] = routes.taskPayloads();
    assert(firstTask && replayedTask, 'expected two task payloads');
    assert(
      firstTask.idempotency_key === replayedTask.idempotency_key,
      'task retry must preserve the idempotency key',
    );
    const approval = replayedTask.estimate_approval as Record<string, unknown>;
    assert(approval.estimate_id === ESTIMATE_ID, 'task estimate id mismatch');
    assert(approval.estimate_token === ESTIMATE_TOKEN, 'task estimate token mismatch');
    assert(approval.max_approved_credits === 2.5, 'task estimate limit mismatch');
    const estimateRequest = routes.lastEstimateRequest();
    assert(estimateRequest !== null, 'expected the estimate request before task creation');
    const taskInput = replayedTask.input as Record<string, unknown>;
    assert(
      replayedTask.provider_config_id === estimateRequest.provider_config_id,
      'task provider config must match the approved estimate',
    );
    assert(replayedTask.provider_config_id === PROVIDER_CONFIG_ID, 'task provider mismatch');
    assert(
      replayedTask.model === estimateRequest.model,
      'task model must match the approved estimate',
    );
    assert(replayedTask.model === 'fake/image-v1', 'task model mismatch');
    assert(
      isDeepStrictEqual(taskInput, estimateRequest.input),
      'task input must match the approved estimate input',
    );
    await page.waitForURL((url) => url.searchParams.get('task') === TASK_ID, { timeout: 30_000 });
    assert(new URL(page.url()).searchParams.get('task') === TASK_ID, 'task URL was not durable');
    assert((await page.locator('body').innerText()).includes('Completed'), 'task did not complete');
    for (const cancelled of [
      'Video Studio',
      'Voice Studio',
      '3D Studio',
      'Digital Human',
      'Batch Remix',
    ]) {
      assert(
        !(await page.locator('body').innerText()).includes(cancelled),
        `${cancelled} must stay absent`,
      );
    }

    await assertLayout(page, 'desktop');
    await screenshotAndAssertPixels(page, `${resultsDir}/image-studio-desktop.png`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('section[aria-label="Results"]').scrollIntoViewIfNeeded();
    await assertLayout(page, 'mobile');
    await screenshotAndAssertPixels(page, `${resultsDir}/image-studio-mobile.png`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('img', { name: 'Generated image 1' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    });
    assert(new URL(page.url()).searchParams.get('task') === TASK_ID, 'reload lost task recovery');
    const downloadBefore = routes.downloadUrlCalls();
    await page.getByRole('button', { name: 'Reuse as reference' }).click();
    await page
      .getByRole('button', { name: 'Remove reference image' })
      .waitFor({ state: 'visible' });
    assert(routes.uploadCreateCalls() === 1, 'reuse should not upload the generated asset');
    await page.getByRole('button', { name: 'Download image' }).click();
    await waitFor(
      'explicit generated image download',
      () => routes.downloadUrlCalls() > downloadBefore,
    );

    routes.setEstimateMode('success');
    await page
      .getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('A cancellable image task');
    await page.getByText('2.5 credits', { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Generate', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel generation' }).waitFor({ state: 'visible' });
    const cancellationTask = routes.taskPayloads()[2];
    const cancellationEstimate = routes.lastEstimateRequest();
    assert(cancellationTask && cancellationEstimate, 'expected the cancellable task estimate pair');
    const cancellationInput = cancellationTask.input as Record<string, unknown>;
    assert(
      isDeepStrictEqual(cancellationInput, cancellationEstimate.input),
      'cancellable task input must match its approved estimate',
    );
    const cancellationImage = cancellationInput.image as Record<string, unknown>;
    const cancellationReferences = cancellationImage.reference_asset_ids;
    assert(
      Array.isArray(cancellationReferences) && cancellationReferences.includes(ASSET_ID),
      'reused generated asset must be included in the next task input',
    );
    await page.getByRole('button', { name: 'Cancel generation' }).click();
    await waitFor('bound Studio job cancellation', () => routes.cancelCalls() === 1);
    try {
      await page.locator('output', { hasText: 'Cancelled' }).waitFor({ state: 'visible' });
    } catch (error) {
      throw new Error(
        `Cancellation did not render. Body: ${await page.locator('body').innerText()}`,
        {
          cause: error,
        },
      );
    }
    assert(routes.cancelCalls() === 1, 'cancel should call the bound Studio job once');

    const estimatesBeforeCredits = routes.estimateCalls();
    routes.setEstimateMode('insufficient');
    await page
      .getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('An image without enough credits');
    await waitFor(
      'insufficient credit estimate',
      () => routes.estimateCalls() > estimatesBeforeCredits,
    );
    await page.getByText(/Insufficient credits/i).waitFor({ state: 'visible' });

    const estimatesBeforePermission = routes.estimateCalls();
    routes.setEstimateMode('permission');
    await page
      .getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('An image without permission');
    await waitFor(
      'permission denied estimate',
      () => routes.estimateCalls() > estimatesBeforePermission,
    );
    await page.getByText(/do not have permission/i).waitFor({ state: 'visible' });

    await page.getByTestId('debug-studio-assets').click();
    const generatedAsset = page.locator(`[data-asset-id="${ASSET_ID}"]`);
    await generatedAsset.waitFor({ state: 'visible', timeout: 30_000 });
    const sourceHref = await generatedAsset
      .getByRole('link', { name: 'Open source job' })
      .getAttribute('href');
    const reuseHref = await generatedAsset
      .getByRole('link', { name: 'Reuse in Image Studio' })
      .getAttribute('href');
    assert(sourceHref?.endsWith(`?job=${JOB_ID}`), 'asset source job link mismatch');
    assert(reuseHref?.endsWith(`?reference=${ASSET_ID}`), 'asset reuse link mismatch');
    const downloadsBeforePreview = routes.downloadUrlCalls();
    await generatedAsset.getByRole('button', { name: 'Preview' }).click();
    await page.getByRole('dialog', { name: 'Asset preview' }).waitFor({ state: 'visible' });
    await page
      .getByRole('dialog', { name: 'Asset preview' })
      .getByRole('img', { name: 'Image asset' })
      .waitFor({ state: 'visible' });
    assert(
      routes.downloadUrlCalls() > downloadsBeforePreview,
      'preview should request a one-shot URL',
    );
    await page
      .getByRole('dialog', { name: 'Asset preview' })
      .getByRole('button', { name: 'Close' })
      .first()
      .click();
    const downloadsBeforeAsset = routes.downloadUrlCalls();
    await generatedAsset.getByRole('button', { name: 'Download' }).click();
    await waitFor('asset download URL', () => routes.downloadUrlCalls() > downloadsBeforeAsset);

    const browserOutput = `${consoleMessages.join('\n')}\n${pageErrors.join('\n')}`;
    assert(
      !browserOutput.includes('debug-image-studio-token'),
      'auth token leaked to browser logs',
    );
    assert(!browserOutput.includes(ESTIMATE_TOKEN), 'estimate token leaked to browser logs');
    assert(!browserOutput.includes('signature=opaque'), 'signed URL leaked to browser logs');
    assert(pageErrors.length === 0, `browser page errors: ${pageErrors.join(' | ')}`);

    console.log(
      '[image-studio] ok: desktop/mobile generation, recovery, cancellation, upload, errors, assets, downloads',
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
