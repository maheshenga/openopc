import {
  type OpenOpcChatMessage,
  type OpenOpcImageAsset,
  type OpenOpcImageEstimate,
  type OpenOpcImageGenerateInput,
  type OpenOpcImageJob,
  type OpenOpcImageJobEvent,
  type OpenOpcImageModel,
  type OpenOpcModel,
  type OpenOpcModuleClient,
  OpenOpcModuleProtocolError,
  OpenOpcModuleRequestError,
  OpenOpcModuleServiceError,
  type OpenOpcRequestOptions,
  createOpenOpcBrowserModuleClient,
} from '@openopc/developer-sdk';
import {
  ACTIVE_JOB_REFRESH_MS,
  markJobEventsRead,
  pollBackoffMs,
  readImageJobSnapshot,
  rememberImageJobSnapshots,
  resetImageJobPollStateForTest,
  shouldReadJobEvents,
} from './job-polling';

const MAX_POLL_MS = 10 * 60_000;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

let clientPromise: Promise<OpenOpcModuleClient> | null = null;

export function getOpenOpcClient(): Promise<OpenOpcModuleClient> {
  clientPromise ??= createOpenOpcBrowserModuleClient({ timeoutMs: 45_000 });
  return clientPromise;
}

export function resetOpenOpcClientForTest(): void {
  clientPromise = null;
  resetImageJobPollStateForTest();
}

export function setOpenOpcClientForTest(client: OpenOpcModuleClient): void {
  clientPromise = Promise.resolve(client);
}

export async function listImageModels(): Promise<OpenOpcImageModel[]> {
  const client = await getOpenOpcClient();
  return (await client.ai.images.models.list()).data;
}

export async function listTextModels(): Promise<OpenOpcModel[]> {
  const client = await getOpenOpcClient();
  return (await client.ai.models.list()).data;
}

export function mergeReferenceAssetIds(
  existingAssetIds: readonly string[],
  uploadedAssetIds: readonly string[],
): string[] {
  return [...new Set([...existingAssetIds, ...uploadedAssetIds])].slice(0, 8);
}

export async function uploadReferenceFiles(
  files: readonly File[],
  options?: OpenOpcRequestOptions,
): Promise<string[]> {
  const client = await getOpenOpcClient();
  const selectedFiles = files.slice(0, 8);
  selectedFiles.forEach(validateImageFile);
  const assets = await Promise.all(
    selectedFiles.map((file) =>
      client.ai.images.assets.create({ file, filename: file.name }, options),
    ),
  );
  return assets.map((asset) => asset.asset_id);
}

/**
 * Build the upstream-compatible 4x3 layout guide in memory. It is an input
 * artifact for the image model only; the module never exposes an editable
 * canvas surface to users.
 */
export async function createGifTemplateFile(): Promise<File> {
  if (typeof document === 'undefined')
    throw new Error('Image template generation requires a browser.');
  const canvas = document.createElement('canvas');
  canvas.width = 3264;
  canvas.height = 2448;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Unable to create the GIF layout template.');
  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = '#94a3b8';
  context.lineWidth = 8;
  for (let column = 1; column < 4; column += 1) {
    const x = column * (canvas.width / 4);
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }
  for (let row = 1; row < 3; row += 1) {
    const y = row * (canvas.height / 3);
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('Unable to encode the GIF layout template.')),
      'image/png',
    );
  });
  return new File([blob], 'image-studio-gif-template.png', { type: 'image/png' });
}

export interface GenerateImageInput extends OpenOpcImageGenerateInput {
  model: string;
  referenceFiles?: readonly File[];
  idempotencyKey?: string;
  onIdempotencyKey?: (key: string) => void;
  onEstimate?: (estimate: OpenOpcImageEstimate) => void;
  onProgress?: (progress: number | null) => void;
  onStatus?: (job: OpenOpcImageJob) => void;
  signal?: AbortSignal;
}

export interface GeneratedImage {
  assetId: string;
  blob: Blob;
  url: string;
}

export function imageFileExtension(mimeType: string): 'png' | 'jpg' | 'webp' {
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  return 'png';
}

export function isUnknownImageSubmissionError(reason: unknown): boolean {
  return (
    reason instanceof OpenOpcModuleRequestError &&
    (reason.code === 'OPENOPC_MODULE_REQUEST_TIMEOUT' ||
      reason.code === 'OPENOPC_MODULE_REQUEST_FAILED')
  );
}

export function retainedImageRetryKey(
  reason: unknown,
  idempotencyKey: string | undefined,
  reconciliationAttempted: boolean,
): string | undefined {
  return !reconciliationAttempted && idempotencyKey && isUnknownImageSubmissionError(reason)
    ? idempotencyKey
    : undefined;
}

export function isImageClipboardAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  );
}

export async function copyImageBlob(blob: Blob): Promise<boolean> {
  if (!isImageClipboardAvailable()) return false;
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
  return true;
}

export async function generateImage(input: GenerateImageInput): Promise<GeneratedImage[]> {
  throwIfAborted(input.signal);
  const client = await getOpenOpcClient();
  const options = input.signal ? { signal: input.signal } : undefined;
  const uploadedAssetIds = input.referenceFiles?.length
    ? await uploadReferenceFiles(input.referenceFiles, options)
    : [];
  const referenceAssetIds = mergeReferenceAssetIds(
    input.reference_asset_ids ?? [],
    uploadedAssetIds,
  );
  const imageInput: OpenOpcImageGenerateInput = {
    prompt: input.prompt,
    ...(input.negative_prompt ? { negative_prompt: input.negative_prompt } : {}),
    reference_asset_ids: referenceAssetIds ?? [],
    aspect_ratio: input.aspect_ratio,
    quality: input.quality,
    output_count: input.output_count,
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  };
  const estimate = await client.ai.images.estimates.create(
    { model: input.model, input: imageInput },
    options,
  );
  input.onEstimate?.(estimate);
  const idempotencyKey = input.idempotencyKey ?? `image-studio-${crypto.randomUUID()}`;
  input.onIdempotencyKey?.(idempotencyKey);
  const created = await client.ai.images.jobs.create(
    {
      model: input.model,
      input: imageInput,
      estimate_id: estimate.estimate_id,
      estimate_token: estimate.estimate_token,
      idempotency_key: idempotencyKey,
    },
    options,
  );

  const job = await waitForImageJob(
    client,
    created,
    input.onStatus,
    input.onProgress,
    input.signal,
  );
  if (job.status !== 'succeeded') {
    throw new Error(job.error_code ?? 'Image generation failed.');
  }

  // Event history is an enhancement, not the source of truth for a terminal job.
  // A provider can finish the job while the history endpoint is still unavailable.
  const events = await readJobEvents(client, job.job_id, null, input.signal);
  const assetIds = new Set<string>();
  for (const event of events.items) event.asset_ids?.forEach((assetId) => assetIds.add(assetId));
  if (assetIds.size < job.input.output_count) {
    const recoveredAssetIds = await listJobAssetIds(client, job.job_id, options);
    recoveredAssetIds.forEach((assetId) => assetIds.add(assetId));
  }
  const results: GeneratedImage[] = [];
  for (const assetId of assetIds) {
    throwIfAborted(input.signal);
    const blob = await client.ai.images.assets.download(assetId, options);
    results.push({ assetId, blob, url: URL.createObjectURL(blob) });
  }
  if (results.length === 0) throw new Error('The image task finished without an output asset.');
  return results;
}

async function waitForImageJob(
  client: OpenOpcModuleClient,
  initial: OpenOpcImageJob,
  onStatus?: (job: OpenOpcImageJob) => void,
  onProgress?: (progress: number | null) => void,
  signal?: AbortSignal,
): Promise<OpenOpcImageJob> {
  const startedAt = Date.now();
  let job = initial;
  let eventCursor: string | null = null;
  let latestProgress: number | null = null;
  let failureCount = 0;
  let pollDelayMs = ACTIVE_JOB_REFRESH_MS;
  onStatus?.(job);
  rememberImageJobSnapshots([job], startedAt);
  while (job.status === 'queued' || job.status === 'running') {
    throwIfAborted(signal);
    if (Date.now() - startedAt > MAX_POLL_MS) throw new Error('Image generation timed out.');
    await abortableDelay(pollDelayMs, signal);
    const jobId = job.job_id;
    const now = Date.now();
    try {
      job = await readImageJobSnapshot(
        jobId,
        () => client.ai.images.jobs.get(jobId, signal ? { signal } : undefined),
        now,
      );
      failureCount = 0;
      pollDelayMs = ACTIVE_JOB_REFRESH_MS;
      onStatus?.(job);
      const terminal = job.status !== 'queued' && job.status !== 'running';
      if (shouldReadJobEvents(jobId, now, terminal)) {
        const events = await readJobEvents(client, jobId, eventCursor, signal);
        eventCursor = events.nextCursor;
        markJobEventsRead(jobId, now);
        for (const event of events.items) {
          if (event.progress !== undefined) latestProgress = event.progress;
        }
        if (events.items.length > 0) onProgress?.(latestProgress);
      }
    } catch (reason) {
      if (signal?.aborted) throw reason;
      if (!shouldRetryImagePoll(reason)) throw reason;
      failureCount += 1;
      pollDelayMs = pollBackoffMs(failureCount);
    }
  }
  return job;
}

async function readJobEvents(
  client: OpenOpcModuleClient,
  jobId: string,
  cursor: string | null,
  signal?: AbortSignal,
): Promise<{ items: OpenOpcImageJobEvent[]; nextCursor: string | null }> {
  try {
    const page = await client.ai.images.jobs.events(
      jobId,
      { cursor, limit: 100 },
      signal ? { signal } : undefined,
    );
    const lastCursor = page.items.at(-1)?.cursor ?? cursor;
    return {
      items: [...page.items],
      nextCursor: page.next_cursor ?? lastCursor,
    };
  } catch (reason) {
    if (signal?.aborted) throw reason;
    if (shouldFallbackToStatusPolling(reason)) {
      // Status polling remains authoritative when event history is temporarily unavailable.
      return { items: [], nextCursor: cursor };
    }
    throw reason;
  }
}

/**
 * Event history is optional during rollout and may be unavailable independently
 * of the job status endpoint. Keep protocol and authorization failures visible.
 */
export function shouldFallbackToStatusPolling(reason: unknown): boolean {
  if (reason instanceof OpenOpcModuleRequestError) return true;
  return (
    reason instanceof OpenOpcModuleServiceError &&
    (reason.status === 404 ||
      reason.status === 405 ||
      reason.status === 408 ||
      reason.status === 409 ||
      reason.status === 429 ||
      reason.status === 501 ||
      reason.status >= 500)
  );
}

export function shouldRetryImagePoll(reason: unknown): boolean {
  if (reason instanceof OpenOpcModuleRequestError) {
    return (
      reason.code === 'OPENOPC_MODULE_REQUEST_TIMEOUT' ||
      reason.code === 'OPENOPC_MODULE_REQUEST_FAILED'
    );
  }
  return (
    reason instanceof OpenOpcModuleServiceError &&
    (reason.status === 408 || reason.status === 409 || reason.status === 429 || reason.status >= 500)
  );
}

/** Recover output assets when a terminal event page is empty or unavailable. */
export async function listJobAssetIds(
  client: OpenOpcModuleClient,
  jobId: string,
  options?: OpenOpcRequestOptions,
): Promise<Set<string>> {
  const assetIds = new Set<string>();
  const requestedCursors = new Set<string>();
  let cursor: string | null = null;

  // The service caps each page at 100 items. A bounded loop prevents a broken
  // cursor chain from keeping a completed generation open indefinitely.
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    throwIfAborted(options?.signal);
    const page = await client.ai.images.assets.list({ cursor, limit: 100 }, options);
    page.items
      .filter((asset) => asset.source.job_id === jobId)
      .forEach((asset) => assetIds.add(asset.asset_id));
    const nextCursor = resolveNextAssetCursor(page.next_cursor, requestedCursors);
    if (!nextCursor) break;
    requestedCursors.add(nextCursor);
    cursor = nextCursor;
  }
  return assetIds;
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, delayMs));
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

export function isAbortError(reason: unknown): boolean {
  return (
    (reason instanceof DOMException && reason.name === 'AbortError') ||
    (reason instanceof Error && reason.name === 'AbortError') ||
    (reason instanceof OpenOpcModuleRequestError &&
      reason.code === 'OPENOPC_MODULE_REQUEST_ABORTED')
  );
}

export function openOpcErrorMessage(reason: unknown, fallback: string): string {
  const code =
    reason instanceof OpenOpcModuleServiceError || reason instanceof OpenOpcModuleRequestError
      ? reason.code
      : reason instanceof Error
        ? reason.message
        : null;

  switch (code) {
    case 'OPENOPC_MODULE_REQUEST_TIMEOUT':
      return '请求超时，请检查网络后重试。';
    case 'OPENOPC_MODULE_REQUEST_FAILED':
      return '暂时无法连接 OpenOPC 服务，请稍后重试。';
    case 'MODULE_IMAGE_ESTIMATE_EXPIRED':
    case 'OPENOPC_IMAGE_ESTIMATE_EXPIRED':
      return '费用预估已过期，请重新提交生成。';
    case 'OPENOPC_IMAGE_ESTIMATE_INPUT_MISMATCH':
      return '生成参数已变化，请重新获取费用预估。';
    case 'MODULE_IMAGE_INVALID':
    case 'OPENOPC_IMAGE_VALIDATION_ERROR':
    case 'OPENOPC_IMAGE_ESTIMATE_INVALID':
      return '输入图片或参数不符合当前模型要求。';
    case 'OPENOPC_IMAGE_INSUFFICIENT_CREDITS':
      return '可用额度不足，请刷新额度后重试。';
    case 'MODULE_IMAGE_UNAVAILABLE':
    case 'MODULE_IMAGE_STORAGE_UNAVAILABLE':
    case 'OPENOPC_IMAGE_PROVIDER_UNAVAILABLE':
    case 'OPENOPC_IMAGE_STORAGE_UNAVAILABLE':
      return '生图服务暂时不可用，请稍后重试。';
    case 'MODULE_IMAGE_JOB_NOT_CANCELLABLE':
    case 'OPENOPC_IMAGE_JOB_NOT_CANCELLABLE':
      return '任务已进入不可取消阶段。';
    case 'OPENOPC_IMAGE_ESTIMATE_SETTLEMENT_FAILED':
      return '费用结算状态需要核对，请勿重复提交。';
    default:
      break;
  }

  if (reason instanceof OpenOpcModuleProtocolError) {
    return 'OpenOPC 服务返回了无法识别的数据，请稍后重试。';
  }
  if (reason instanceof OpenOpcModuleServiceError) {
    if (reason.status === 401 || reason.status === 403) return '当前模块没有执行此操作的权限。';
    if (reason.status === 429) return '请求过于频繁，请稍后重试。';
    if (reason.status >= 500) return 'OpenOPC 服务暂时不可用，请稍后重试。';
    return fallback;
  }
  if (reason instanceof Error && !/^[A-Z][A-Z0-9_.-]+$/.test(reason.message)) {
    return reason.message;
  }
  return fallback;
}

export interface ImageJobPage {
  items: OpenOpcImageJob[];
  nextCursor: string | null;
}

export function mergeImageJobs(
  current: readonly OpenOpcImageJob[],
  incoming: readonly OpenOpcImageJob[],
): OpenOpcImageJob[] {
  const merged = new Map(current.map((job) => [job.job_id, job]));
  for (const job of incoming) merged.set(job.job_id, job);
  return [...merged.values()];
}

export function mergeLatestImageJobs(
  current: readonly OpenOpcImageJob[],
  latest: readonly OpenOpcImageJob[],
): OpenOpcImageJob[] {
  const latestIds = new Set(latest.map((job) => job.job_id));
  return [...latest, ...current.filter((job) => !latestIds.has(job.job_id))];
}

export function resolveNextJobCursor(
  nextCursor: string | null,
  requestedCursors: ReadonlySet<string>,
): string | null {
  return nextCursor && !requestedCursors.has(nextCursor) ? nextCursor : null;
}

export async function listImageJobPage(
  cursor?: string | null,
  options?: OpenOpcRequestOptions,
): Promise<ImageJobPage> {
  const client = await getOpenOpcClient();
  const page = await client.ai.images.jobs.list({ cursor: cursor ?? null, limit: 100 }, options);
  rememberImageJobSnapshots(page.items, Date.now());
  return { items: page.items, nextCursor: page.next_cursor };
}

export interface ImageAssetPage {
  items: OpenOpcImageAsset[];
  nextCursor: string | null;
}

export type ImageAssetFilter = 'all' | 'generated' | 'uploaded';

export function filterImageAssets(
  assets: readonly OpenOpcImageAsset[],
  filter: ImageAssetFilter,
): OpenOpcImageAsset[] {
  if (filter === 'all') return [...assets];
  const generated = filter === 'generated';
  return assets.filter((asset) => (asset.source.job_id !== null) === generated);
}

export function mergeImageAssets(
  current: readonly OpenOpcImageAsset[],
  incoming: readonly OpenOpcImageAsset[],
): OpenOpcImageAsset[] {
  const merged = new Map(current.map((asset) => [asset.asset_id, asset]));
  for (const asset of incoming) merged.set(asset.asset_id, asset);
  return [...merged.values()];
}

export function resolveNextAssetCursor(
  nextCursor: string | null,
  requestedCursors: ReadonlySet<string>,
): string | null {
  return nextCursor && !requestedCursors.has(nextCursor) ? nextCursor : null;
}

export async function listAssetPage(
  cursor?: string | null,
  options?: OpenOpcRequestOptions,
): Promise<ImageAssetPage> {
  const client = await getOpenOpcClient();
  const page = await client.ai.images.assets.list({ cursor: cursor ?? null, limit: 100 }, options);
  return { items: page.items, nextCursor: page.next_cursor };
}

export async function listAssets(options?: OpenOpcRequestOptions) {
  return (await listAssetPage(null, options)).items;
}

export async function downloadAsset(
  assetId: string,
  options?: OpenOpcRequestOptions,
): Promise<Blob> {
  const client = await getOpenOpcClient();
  return client.ai.images.assets.download(assetId, options);
}

export async function cancelImageJob(
  jobId: string,
  options?: OpenOpcRequestOptions,
): Promise<OpenOpcImageJob> {
  const client = await getOpenOpcClient();
  return client.ai.images.jobs.cancel(jobId, options);
}

export async function completeText(
  model: string,
  messages: readonly OpenOpcChatMessage[],
  options?: OpenOpcRequestOptions,
): Promise<string> {
  const client = await getOpenOpcClient();
  const response = await client.ai.chat.create({ model, messages, stream: false }, options);
  const choice = response.choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

export async function streamText(
  model: string,
  messages: readonly OpenOpcChatMessage[],
  onDelta: (text: string) => void,
  options?: OpenOpcRequestOptions,
): Promise<string> {
  const client = await getOpenOpcClient();
  const stream = await client.ai.chat.create({ model, messages, stream: true }, options);
  let result = '';
  for await (const chunk of stream) {
    const choice = chunk.choices[0] as Record<string, unknown> | undefined;
    const delta = choice?.delta;
    const text =
      delta && typeof delta === 'object' ? (delta as { content?: unknown }).content : undefined;
    if (typeof text === 'string') {
      result += text;
      onDelta(text);
    }
  }
  return result;
}

export async function fileAsDataUrl(file: File): Promise<string> {
  validateImageFile(file);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Unable to read the image file.'));
    reader.readAsDataURL(file);
  });
}

/** Validate image inputs before a binary upload or vision request is started. */
export function validateImageFile(file: File): void {
  if (!IMAGE_MIME_TYPES.has(file.type)) {
    throw new Error('请选择 PNG、JPEG 或 WebP 图片。');
  }
  if (file.size <= 0) {
    throw new Error('图片文件不能为空。');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('图片大小不能超过 32 MB。');
  }
}
