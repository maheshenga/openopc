import { describe, expect, mock, test } from 'bun:test';
import type {
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
  IntelligenceImageEstimate,
  IntelligenceTaskResponse,
} from '@kortix/sdk';
import { renderToStaticMarkup } from 'react-dom/server';

import { TooltipProvider } from '@/components/ui/tooltip';

import { type IntelligenceImageFormState, createImageEstimateState } from './image-input';
import type { ImageStudioLabels, ImageStudioViewProps } from './image-studio-page';
import { emptyImageTaskState } from './task-state';

mock.module('@kortix/sdk/react', () => ({
  useCancelIntelligenceJob: () => undefined,
  useCreateIntelligenceTask: () => undefined,
  useCreateIntelligenceUpload: () => undefined,
  useEstimateIntelligenceImage: () => undefined,
  useFinalizeIntelligenceUpload: () => undefined,
  useIntelligenceAgentCard: () => undefined,
  useIntelligenceAssetDownload: () => undefined,
  useIntelligenceCapabilityDiscovery: () => undefined,
  useIntelligenceTaskEvents: () => undefined,
}));

const {
  createImageStudioController,
  forgetImageStudioJobId,
  imageStudioErrorCode,
  isImageEstimateRefreshError,
  ImageStudioView,
  readImageStudioTaskId,
  readRememberedImageStudioJobId,
  rememberImageStudioJobId,
  retryImageStudioDiscovery,
} = await import('./image-studio-page');

const PROJECT_ID = '11000000-0000-4000-a000-000000000001';
const PROVIDER_ID = '12000000-0000-4000-a000-000000000001';
const TASK_ID = '13000000-0000-4000-a000-000000000001';
const JOB_ID = '14000000-0000-4000-a000-000000000001';
const ASSET_ID = '15000000-0000-4000-a000-000000000001';
const ESTIMATE_ID = '16000000-0000-4000-a000-000000000001';

const TARGETS: IntelligenceCapabilityDiscoveryResponse['execution_targets'] = [
  {
    capability_id: 'studio.image.generate',
    provider_config_id: PROVIDER_ID,
    model: 'image-pro',
  },
  {
    capability_id: 'studio.image.generate',
    provider_config_id: PROVIDER_ID,
    model: 'image-fast',
  },
];

const FORM: IntelligenceImageFormState = {
  prompt: 'A precise studio photograph of a ceramic vessel',
  negativePrompt: '',
  referenceAssetIds: [],
  aspectRatio: '1:1',
  quality: 'standard',
  outputCount: 1,
  providerConfigId: PROVIDER_ID,
  model: 'image-pro',
  agentCardHash: 'a'.repeat(64),
  idempotencyKey: 'image-studio:17000000-0000-4000-a000-000000000001',
};

const ESTIMATE: IntelligenceImageEstimate = {
  estimate_id: ESTIMATE_ID,
  estimate_token: 'studio-estimate-v2.payload.signature',
  expires_at: '2030-07-20T12:00:00.000Z',
  currency: 'credits',
  provider_cost_credits: 8,
  platform_cost_credits: 2,
  max_approved_credits: 10,
  input_hash: 'b'.repeat(64),
  line_items: [
    { label: 'Provider', credits: 8 },
    { label: 'Platform', credits: 2 },
  ],
};

const LABELS: ImageStudioLabels = {
  title: 'Image Studio',
  loadingDiscovery: 'Loading image providers...',
  unavailable: 'No image provider is available.',
  retry: 'Retry',
  prompt: 'Prompt',
  promptPlaceholder: 'Describe the image',
  negativePrompt: 'Negative prompt',
  negativePromptPlaceholder: 'What to avoid',
  provider: 'Provider',
  model: 'Model',
  aspectRatio: 'Aspect ratio',
  quality: 'Quality',
  qualityStandard: 'Standard',
  qualityHigh: 'High',
  outputCount: 'Outputs',
  decreaseOutputCount: 'Decrease output count',
  increaseOutputCount: 'Increase output count',
  references: 'References',
  addReference: 'Add reference image',
  removeReference: 'Remove reference image',
  uploadingReference: 'Uploading reference...',
  estimate: 'Estimated cost',
  estimating: 'Estimating...',
  credits: 'credits',
  generate: 'Generate',
  generating: 'Submitting...',
  results: 'Results',
  noResults: 'Generated images will appear here.',
  statusUnknown: 'Recovering task...',
  statusQueued: 'Queued',
  statusRunning: 'Running',
  statusProgress: 'Progress',
  statusWaitingApproval: 'Waiting for approval',
  statusSucceeded: 'Completed',
  statusFailed: 'Failed',
  statusCancelled: 'Cancelled',
  cancel: 'Cancel generation',
  download: 'Download image',
  reuseReference: 'Reuse as reference',
  resultAlt: 'Generated image',
  insufficientCredits: 'Insufficient credits',
  permissionDenied: 'Permission denied',
  validationInvalidPrompt: 'Enter a prompt.',
  validationInvalidNegativePrompt: 'Negative prompt is too long.',
  validationInvalidOutputCount: 'Choose between 1 and 8 outputs.',
  validationInvalidReferenceAssets: 'Choose up to 8 valid references.',
  validationInvalidProvider: 'Choose a provider.',
  validationInvalidModel: 'Choose a model.',
  requestFailed: 'Image generation request failed.',
};

const noop = () => undefined;

function viewProps(overrides: Partial<ImageStudioViewProps> = {}): ImageStudioViewProps {
  return {
    discoveryState: 'ready',
    targets: TARGETS,
    form: FORM,
    references: [],
    estimate: ESTIMATE,
    estimating: false,
    validationCode: null,
    submitting: false,
    uploadingReference: false,
    taskState: emptyImageTaskState(),
    results: [],
    operationErrorCode: null,
    canCancel: false,
    cancelling: false,
    labels: LABELS,
    onPromptChange: noop,
    onNegativePromptChange: noop,
    onProviderChange: noop,
    onModelChange: noop,
    onAspectRatioChange: noop,
    onQualityChange: noop,
    onOutputCountChange: noop,
    onReferenceFiles: noop,
    onRemoveReference: noop,
    onGenerate: noop,
    onCancel: noop,
    onRetry: noop,
    onDownload: noop,
    onReuseReference: noop,
    ...overrides,
  };
}

function renderView(overrides: Partial<ImageStudioViewProps> = {}): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <ImageStudioView {...viewProps(overrides)} />
    </TooltipProvider>,
  );
}

describe('ImageStudioView', () => {
  test('uses the shared Hint and Loading primitives', async () => {
    const sources = await Promise.all(
      [
        'src/features/studio/image-studio-page.tsx',
        'src/features/studio/image-generation-form.tsx',
        'src/features/studio/image-task-results.tsx',
      ].map((path) => Bun.file(path).text()),
    );

    for (const source of sources) {
      expect(source).not.toContain('@/components/ui/tooltip');
      expect(source).not.toContain('LoaderCircle');
    }
    expect(sources.join('\n')).toContain('@/components/ui/hint');
    expect(sources.join('\n')).toContain('@/components/ui/loading');
  });

  test('renders bounded discovery loading and unavailable states', () => {
    const loading = renderView({ discoveryState: 'loading', targets: [] });
    const unavailable = renderView({ discoveryState: 'unavailable', targets: [] });

    expect(loading).toContain('Loading image providers...');
    expect(loading).not.toContain('Describe the image');
    expect(unavailable).toContain('No image provider is available.');
    expect(unavailable).not.toContain('Describe the image');
  });

  test('renders a stable discovery error code and retry command', () => {
    const html = renderView({
      discoveryState: 'error',
      targets: [],
      operationErrorCode: 'STUDIO_PERMISSION_DENIED',
    });

    expect(html).toContain('STUDIO_PERMISSION_DENIED');
    expect(html).toContain('Retry');
    expect(html).not.toContain('Bearer');
  });

  test('renders provider, model, form bounds, and the signed estimate amount', () => {
    const html = renderView();

    expect(html).toContain('image-pro');
    expect(html).toContain('image-fast');
    expect(html).toContain('max="8"');
    expect(html).toContain('10');
    expect(html).toContain('credits');
    expect(html).toContain('A precise studio photograph');
  });

  test('renders validation and disables duplicate submission while pending', () => {
    const html = renderView({
      validationCode: 'INVALID_OUTPUT_COUNT',
      submitting: true,
      form: { ...FORM, outputCount: 9 },
    });

    expect(html).toContain('Choose between 1 and 8 outputs.');
    expect(html).toContain('Submitting...');
    expect(html).toContain('disabled=""');
  });

  test('renders stable billing and permission errors without provider bodies', () => {
    const billing = renderView({ operationErrorCode: 'STUDIO_INSUFFICIENT_CREDITS' });
    const permission = renderView({ operationErrorCode: 'STUDIO_PERMISSION_DENIED' });

    expect(billing).toContain('Insufficient credits');
    expect(permission).toContain('Permission denied');
    expect(billing).not.toContain('https://');
    expect(permission).not.toContain('Bearer');
  });

  test('renders queued, running progress, failed, cancelled, and succeeded task states', () => {
    const queued = renderView({
      taskState: { ...emptyImageTaskState(TASK_ID), status: 'queued' },
    });
    const running = renderView({
      taskState: { ...emptyImageTaskState(TASK_ID), status: 'running', progress: 0.42 },
      canCancel: true,
    });
    const waitingApproval = renderView({
      taskState: { ...emptyImageTaskState(TASK_ID), status: 'waiting_approval' },
      canCancel: true,
    });
    const failed = renderView({
      taskState: {
        ...emptyImageTaskState(TASK_ID),
        status: 'failed',
        terminal: true,
        errorCode: 'STUDIO_PROVIDER_TIMEOUT',
      },
    });
    const cancelled = renderView({
      taskState: { ...emptyImageTaskState(TASK_ID), status: 'cancelled', terminal: true },
    });
    const succeeded = renderView({
      taskState: {
        ...emptyImageTaskState(TASK_ID),
        status: 'succeeded',
        terminal: true,
        progress: 1,
        assetIds: [ASSET_ID],
      },
      results: [
        {
          assetId: ASSET_ID,
          previewUrl: 'https://assets.example.test/generated.png',
        },
      ],
    });

    expect(queued).toContain('Queued');
    expect(running).toContain('Progress');
    expect(running).toContain('42%');
    expect(running).toContain('Cancel generation');
    expect(waitingApproval).toContain('Waiting for approval');
    expect(waitingApproval).toContain('Cancel generation');
    expect(failed).toContain('STUDIO_PROVIDER_TIMEOUT');
    expect(failed).toContain('Retry');
    expect(cancelled).toContain('Cancelled');
    expect(cancelled).not.toContain('animate-spin');
    expect(succeeded).toContain('Generated image');
    expect(succeeded).toContain('Download image');
    expect(succeeded).toContain('Reuse as reference');
  });

  test('renders the unknown recovery state for a task restored from the URL', () => {
    const html = renderView({ taskState: emptyImageTaskState(TASK_ID) });

    expect(readImageStudioTaskId(new URLSearchParams(`task=${TASK_ID}`))).toBe(TASK_ID);
    expect(readImageStudioTaskId(new URLSearchParams('task=not-a-uuid'))).toBeNull();
    expect(html).toContain('Recovering task...');
  });
});

describe('Image Studio controller', () => {
  test('submits one canonical signed Intelligence task for concurrent commands', async () => {
    let resolveTask!: (value: IntelligenceTaskResponse) => void;
    const createTask = mock(
      (_input: IntelligenceCreateTaskRequest) =>
        new Promise<IntelligenceTaskResponse>((resolve) => {
          resolveTask = resolve;
        }),
    );
    const setTaskQuery = mock(() => undefined);
    const controller = createImageStudioController({
      createTask,
      cancelJob: async () => undefined,
      createDownloadUrl: async () => ({
        asset_id: ASSET_ID,
        signed_download_url: 'https://assets.example.test/download',
        expires_at: '2030-07-20T12:00:00.000Z',
      }),
      openUrl: noop,
      setTaskQuery,
      addReference: noop,
    });
    const estimateState = createImageEstimateState(FORM, ESTIMATE);

    const first = controller.submit(FORM, estimateState);
    const replay = controller.submit(FORM, estimateState);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask.mock.calls[0]?.[0]).toMatchObject({
      protocol_version: 'intelligence.v1',
      capability_id: 'studio.image.generate',
      provider_config_id: PROVIDER_ID,
      model: 'image-pro',
      estimate_approval: {
        estimate_id: ESTIMATE_ID,
        estimate_token: ESTIMATE.estimate_token,
        max_approved_credits: 10,
      },
      input: { capability: 'image.generate' },
    });

    resolveTask({
      protocol_version: 'intelligence.v1',
      task_id: TASK_ID,
      job_id: JOB_ID,
      created: true,
    });
    expect(await first).toEqual(await replay);
    expect(setTaskQuery).toHaveBeenCalledWith(TASK_ID);
  });

  test('keeps cancel, download, and reuse commands behind explicit controller calls', async () => {
    const cancelJob = mock(async () => undefined);
    const createDownloadUrl = mock(async () => ({
      asset_id: ASSET_ID,
      signed_download_url: 'https://assets.example.test/download',
      expires_at: '2030-07-20T12:00:00.000Z',
    }));
    const openUrl = mock(() => undefined);
    const addReference = mock(() => undefined);
    const controller = createImageStudioController({
      createTask: async () => ({
        protocol_version: 'intelligence.v1',
        task_id: TASK_ID,
        job_id: JOB_ID,
        created: true,
      }),
      cancelJob,
      createDownloadUrl,
      openUrl,
      setTaskQuery: noop,
      addReference,
    });

    expect(cancelJob).not.toHaveBeenCalled();
    expect(createDownloadUrl).not.toHaveBeenCalled();
    await controller.cancel(JOB_ID);
    await controller.download(ASSET_ID);
    controller.reuse(ASSET_ID);

    expect(cancelJob).toHaveBeenCalledWith(JOB_ID);
    expect(createDownloadUrl).toHaveBeenCalledWith(ASSET_ID);
    expect(openUrl).toHaveBeenCalledWith('https://assets.example.test/download');
    expect(addReference).toHaveBeenCalledWith(ASSET_ID);
  });

  test('normalizes request errors to stable non-secret UI codes', () => {
    expect(imageStudioErrorCode({ status: 402, code: 'UNSAFE_PROVIDER_BODY' })).toBe(
      'STUDIO_INSUFFICIENT_CREDITS',
    );
    expect(imageStudioErrorCode({ status: 403, message: 'Bearer private-token' })).toBe(
      'STUDIO_PERMISSION_DENIED',
    );
    expect(imageStudioErrorCode({ code: 'STUDIO_ESTIMATE_EXPIRED' })).toBe(
      'STUDIO_ESTIMATE_EXPIRED',
    );
    expect(imageStudioErrorCode(new Error('https://provider.test/private'))).toBe(
      'STUDIO_REQUEST_FAILED',
    );
  });

  test('refreshes only estimate conflicts and keeps idempotency conflicts separate', () => {
    expect(isImageEstimateRefreshError('INTELLIGENCE_ESTIMATE_INVALID')).toBe(true);
    expect(isImageEstimateRefreshError('INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED')).toBe(true);
    expect(isImageEstimateRefreshError('STUDIO_ESTIMATE_EXPIRED')).toBe(true);
    expect(isImageEstimateRefreshError('STUDIO_PRICING_STALE')).toBe(true);
    expect(isImageEstimateRefreshError('INTELLIGENCE_IDEMPOTENCY_MISMATCH')).toBe(false);
    expect(isImageEstimateRefreshError('INTELLIGENCE_REQUEST_FAILED')).toBe(false);
  });

  test('remembers only a scoped task-to-job mapping and removes it at terminal state', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    expect(rememberImageStudioJobId(storage, PROJECT_ID, TASK_ID, JOB_ID)).toBe(true);
    expect(readRememberedImageStudioJobId(storage, PROJECT_ID, TASK_ID)).toBe(JOB_ID);
    expect([...values.entries()]).toEqual([
      [`kortix:studio:${PROJECT_ID}:task-job:${TASK_ID}`, JOB_ID],
    ]);

    forgetImageStudioJobId(storage, PROJECT_ID, TASK_ID);
    expect(readRememberedImageStudioJobId(storage, PROJECT_ID, TASK_ID)).toBeNull();
  });

  test('fails safely when session storage is blocked or contains a malformed job id', () => {
    const blocked = {
      getItem: (_key: string): string | null => {
        throw new Error('storage blocked');
      },
      setItem: (_key: string, _value: string): void => {
        throw new Error('storage blocked');
      },
      removeItem: (_key: string): void => {
        throw new Error('storage blocked');
      },
    };
    const malformed = {
      getItem: (_key: string) => 'signed-url-or-not-a-uuid',
      setItem: (_key: string, _value: string) => undefined,
      removeItem: (_key: string) => undefined,
    };

    expect(rememberImageStudioJobId(blocked, PROJECT_ID, TASK_ID, JOB_ID)).toBe(false);
    expect(readRememberedImageStudioJobId(blocked, PROJECT_ID, TASK_ID)).toBeNull();
    expect(readRememberedImageStudioJobId(malformed, PROJECT_ID, TASK_ID)).toBeNull();
    expect(() => forgetImageStudioJobId(blocked, PROJECT_ID, TASK_ID)).not.toThrow();
    expect(rememberImageStudioJobId(malformed, 'not-a-project', TASK_ID, JOB_ID)).toBe(false);
  });

  test('retries capability discovery and the Agent Card together', async () => {
    const refetchCapabilities = mock(async () => 'capabilities');
    const refetchAgentCard = mock(async () => 'agent-card');

    await retryImageStudioDiscovery(refetchCapabilities, refetchAgentCard);

    expect(refetchCapabilities).toHaveBeenCalledTimes(1);
    expect(refetchAgentCard).toHaveBeenCalledTimes(1);
  });
});
