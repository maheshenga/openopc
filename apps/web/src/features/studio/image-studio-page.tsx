'use client';

import type {
  IntelligenceAssetDownload,
  IntelligenceCapabilityDiscoveryResponse,
  IntelligenceCreateTaskRequest,
  IntelligenceImageEstimate,
  IntelligenceTaskResponse,
} from '@kortix/sdk';
import {
  useCancelIntelligenceJob,
  useCreateIntelligenceTask,
  useCreateIntelligenceUpload,
  useEstimateIntelligenceImage,
  useFinalizeIntelligenceUpload,
  useIntelligenceAgentCard,
  useIntelligenceAssetDownload,
  useIntelligenceCapabilityDiscovery,
  useIntelligenceTaskByJob,
  useIntelligenceTaskEvents,
} from '@kortix/sdk/react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';

import {
  ImageGenerationForm,
  type ImageGenerationFormLabels,
  type ImageStudioReference,
} from './image-generation-form';
import {
  type ImageEstimateState,
  type IntelligenceImageFormState,
  buildImageEstimateRequest,
  buildImageTaskRequest,
  createImageEstimateState,
  createImageIdempotencyKey,
  estimateApprovalForCurrentForm,
  imageEstimateFingerprint,
  selectImageExecutionTarget,
} from './image-input';
import {
  type ImageTaskResult,
  ImageTaskResults,
  type ImageTaskResultsLabels,
} from './image-task-results';
import { uploadReferenceImage } from './reference-upload';
import { type ImageTaskViewState, emptyImageTaskState, reduceTaskEvents } from './task-state';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_ERROR_CODE_PATTERN = /^(?:STUDIO|INTELLIGENCE)_[A-Z0-9_.-]{1,118}$/;
const IMAGE_ESTIMATE_REFRESH_CODES = new Set([
  'INTELLIGENCE_ESTIMATE_INVALID',
  'INTELLIGENCE_ESTIMATE_LIMIT_EXCEEDED',
  'STUDIO_ESTIMATE_EXPIRED',
  'STUDIO_PRICING_STALE',
  'STUDIO_PROVIDER_CONFIG_STALE',
]);
const ESTIMATE_DEBOUNCE_MS = 300;
const EVENT_POLL_INTERVAL_MS = 1_500;
const EMPTY_EXECUTION_TARGETS: IntelligenceCapabilityDiscoveryResponse['execution_targets'] = [];

type DiscoveryState = 'loading' | 'ready' | 'unavailable' | 'error';

export interface ImageStudioLabels extends ImageGenerationFormLabels, ImageTaskResultsLabels {
  title: string;
  loadingDiscovery: string;
  unavailable: string;
  insufficientCredits: string;
  permissionDenied: string;
  validationInvalidPrompt: string;
  validationInvalidNegativePrompt: string;
  validationInvalidOutputCount: string;
  validationInvalidReferenceAssets: string;
  validationInvalidProvider: string;
  validationInvalidModel: string;
  requestFailed: string;
}

export interface ImageStudioViewProps {
  discoveryState: DiscoveryState;
  targets: IntelligenceCapabilityDiscoveryResponse['execution_targets'];
  form: IntelligenceImageFormState;
  references: readonly ImageStudioReference[];
  estimate: IntelligenceImageEstimate | null;
  estimating: boolean;
  validationCode: string | null;
  submitting: boolean;
  uploadingReference: boolean;
  taskState: ImageTaskViewState;
  results: readonly ImageTaskResult[];
  operationErrorCode: string | null;
  canCancel: boolean;
  cancelling: boolean;
  labels: ImageStudioLabels;
  onPromptChange(value: string): void;
  onNegativePromptChange(value: string): void;
  onProviderChange(providerConfigId: string): void;
  onModelChange(model: string): void;
  onAspectRatioChange(value: IntelligenceImageFormState['aspectRatio']): void;
  onQualityChange(value: IntelligenceImageFormState['quality']): void;
  onOutputCountChange(value: number): void;
  onReferenceFiles(files: readonly File[]): void;
  onRemoveReference(assetId: string): void;
  onGenerate(): void;
  onCancel(): void;
  onRetry(): void;
  onDownload(assetId: string): void;
  onReuseReference(assetId: string): void;
}

export interface ImageStudioControllerDependencies {
  createTask(input: IntelligenceCreateTaskRequest): Promise<IntelligenceTaskResponse>;
  cancelJob(jobId: string): Promise<unknown>;
  createDownloadUrl(assetId: string): Promise<IntelligenceAssetDownload>;
  openUrl(url: string): void;
  setTaskQuery(taskId: string): void;
  addReference(assetId: string): void;
}

export interface ImageStudioController {
  submit(
    form: IntelligenceImageFormState,
    estimateState: ImageEstimateState | null,
  ): Promise<IntelligenceTaskResponse>;
  cancel(jobId: string): Promise<void>;
  download(assetId: string): Promise<void>;
  reuse(assetId: string): void;
}

export interface ImageStudioSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function imageStudioJobStorageKey(projectId: string, taskId: string): string | null {
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(taskId)) return null;
  return `kortix:studio:${projectId}:task-job:${taskId}`;
}

export function rememberImageStudioJobId(
  storage: ImageStudioSessionStorage,
  projectId: string,
  taskId: string,
  jobId: string,
): boolean {
  const key = imageStudioJobStorageKey(projectId, taskId);
  if (!key || !UUID_PATTERN.test(jobId)) return false;
  try {
    storage.setItem(key, jobId);
    return true;
  } catch {
    return false;
  }
}

export function readRememberedImageStudioJobId(
  storage: ImageStudioSessionStorage,
  projectId: string,
  taskId: string,
): string | null {
  const key = imageStudioJobStorageKey(projectId, taskId);
  if (!key) return null;
  try {
    const jobId = storage.getItem(key);
    return jobId && UUID_PATTERN.test(jobId) ? jobId : null;
  } catch {
    return null;
  }
}

export function forgetImageStudioJobId(
  storage: ImageStudioSessionStorage,
  projectId: string,
  taskId: string,
): void {
  const key = imageStudioJobStorageKey(projectId, taskId);
  if (!key) return;
  try {
    storage.removeItem(key);
  } catch {
    // Storage can be disabled by browser policy; cleanup remains best effort.
  }
}

function validationMessage(code: string | null, labels: ImageStudioLabels): string | null {
  switch (code) {
    case 'INVALID_PROMPT':
      return labels.validationInvalidPrompt;
    case 'INVALID_NEGATIVE_PROMPT':
      return labels.validationInvalidNegativePrompt;
    case 'INVALID_OUTPUT_COUNT':
      return labels.validationInvalidOutputCount;
    case 'INVALID_REFERENCE_ASSETS':
      return labels.validationInvalidReferenceAssets;
    case 'INVALID_PROVIDER':
      return labels.validationInvalidProvider;
    case 'INVALID_MODEL':
      return labels.validationInvalidModel;
    case null:
      return null;
    default:
      return labels.requestFailed;
  }
}

function operationErrorMessage(code: string | null, labels: ImageStudioLabels): string | null {
  switch (code) {
    case null:
      return null;
    case 'STUDIO_INSUFFICIENT_CREDITS':
      return labels.insufficientCredits;
    case 'STUDIO_PERMISSION_DENIED':
      return labels.permissionDenied;
    default:
      return labels.requestFailed;
  }
}

export function imageStudioValidationCode(form: IntelligenceImageFormState): string | null {
  try {
    buildImageEstimateRequest(form);
    return null;
  } catch (error) {
    return error instanceof Error && /^INVALID_[A-Z_]+$/.test(error.message)
      ? error.message
      : 'INVALID_FORM';
  }
}

export function imageStudioErrorCode(error: unknown): string {
  const source = error as { status?: unknown; code?: unknown } | null;
  if (source && source.status === 402) return 'STUDIO_INSUFFICIENT_CREDITS';
  if (source && source.status === 403) return 'STUDIO_PERMISSION_DENIED';
  if (source && typeof source.code === 'string' && SAFE_ERROR_CODE_PATTERN.test(source.code)) {
    return source.code;
  }
  return 'STUDIO_REQUEST_FAILED';
}

export function isImageEstimateRefreshError(code: string): boolean {
  return IMAGE_ESTIMATE_REFRESH_CODES.has(code);
}

export async function retryImageStudioDiscovery(
  refetchCapabilities: () => Promise<unknown>,
  refetchAgentCard: () => Promise<unknown>,
): Promise<void> {
  await Promise.all([refetchCapabilities(), refetchAgentCard()]);
}

export function readImageStudioTaskId(searchParams: Pick<URLSearchParams, 'get'>): string | null {
  const taskId = searchParams.get('task');
  return taskId && UUID_PATTERN.test(taskId) ? taskId : null;
}

export function readImageStudioJobId(searchParams: Pick<URLSearchParams, 'get'>): string | null {
  const jobId = searchParams.get('job');
  return jobId && UUID_PATTERN.test(jobId) ? jobId : null;
}

function readReferenceAssetId(searchParams: Pick<URLSearchParams, 'get'>): string | null {
  const assetId = searchParams.get('reference');
  return assetId && UUID_PATTERN.test(assetId) ? assetId : null;
}

function taskOnlyUrl(pathname: string, taskId: string | null): string {
  return taskId ? `${pathname}?task=${encodeURIComponent(taskId)}` : pathname;
}

export function createImageStudioController(
  dependencies: ImageStudioControllerDependencies,
): ImageStudioController {
  let pendingSubmission: Promise<IntelligenceTaskResponse> | null = null;

  return {
    submit(form, estimateState) {
      if (pendingSubmission) return pendingSubmission;
      const approval = estimateApprovalForCurrentForm(form, estimateState);
      if (!approval) return Promise.reject(new Error('STUDIO_ESTIMATE_REQUIRED'));
      const request = buildImageTaskRequest(form, approval);
      const operation = dependencies.createTask(request).then((response) => {
        dependencies.setTaskQuery(response.task_id);
        return response;
      });
      pendingSubmission = operation;
      const clear = () => {
        if (pendingSubmission === operation) pendingSubmission = null;
      };
      void operation.then(clear, clear);
      return operation;
    },
    async cancel(jobId) {
      await dependencies.cancelJob(jobId);
    },
    async download(assetId) {
      const response = await dependencies.createDownloadUrl(assetId);
      dependencies.openUrl(response.signed_download_url);
    },
    reuse(assetId) {
      dependencies.addReference(assetId);
    },
  };
}

export function ImageStudioView({
  discoveryState,
  targets,
  form,
  references,
  estimate,
  estimating,
  validationCode,
  submitting,
  uploadingReference,
  taskState,
  results,
  operationErrorCode,
  canCancel,
  cancelling,
  labels,
  onPromptChange,
  onNegativePromptChange,
  onProviderChange,
  onModelChange,
  onAspectRatioChange,
  onQualityChange,
  onOutputCountChange,
  onReferenceFiles,
  onRemoveReference,
  onGenerate,
  onCancel,
  onRetry,
  onDownload,
  onReuseReference,
}: ImageStudioViewProps) {
  if (discoveryState !== 'ready') {
    const loading = discoveryState === 'loading';
    const failed = discoveryState === 'error';
    return (
      <div
        className="text-muted-foreground grid min-h-0 flex-1 place-items-center px-6 text-center text-sm"
        role={failed ? 'alert' : 'status'}
        aria-label={labels.title}
      >
        <div className="space-y-3">
          {loading ? (
            <Loading className="mx-auto size-6" />
          ) : (
            <AlertTriangle className="mx-auto size-6" aria-hidden="true" />
          )}
          <p>
            {loading ? labels.loadingDiscovery : failed ? labels.requestFailed : labels.unavailable}
          </p>
          {failed ? (
            <code className="block text-xs">{operationErrorCode ?? 'STUDIO_REQUEST_FAILED'}</code>
          ) : null}
          {failed ? (
            <Button type="button" variant="outline" size="lg" onClick={onRetry}>
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {labels.retry}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <main
      data-testid="image-studio-accepted"
      className="grid min-h-0 flex-1 grid-rows-[auto_minmax(360px,1fr)] overflow-y-auto md:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] md:grid-rows-1 md:overflow-hidden"
      aria-label={labels.title}
    >
      <ImageGenerationForm
        targets={targets}
        form={form}
        references={references}
        estimate={estimate}
        estimating={estimating}
        validationMessage={validationMessage(validationCode, labels)}
        submitting={submitting}
        uploadingReference={uploadingReference}
        labels={labels}
        onPromptChange={onPromptChange}
        onNegativePromptChange={onNegativePromptChange}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onAspectRatioChange={onAspectRatioChange}
        onQualityChange={onQualityChange}
        onOutputCountChange={onOutputCountChange}
        onReferenceFiles={onReferenceFiles}
        onRemoveReference={onRemoveReference}
        onGenerate={onGenerate}
      />
      <ImageTaskResults
        state={taskState}
        results={results}
        operationErrorCode={operationErrorCode}
        operationErrorMessage={operationErrorMessage(operationErrorCode, labels)}
        canCancel={canCancel}
        cancelling={cancelling}
        labels={labels}
        onCancel={onCancel}
        onRetry={onRetry}
        onDownload={onDownload}
        onReuseReference={onReuseReference}
      />
    </main>
  );
}

function initialForm(): IntelligenceImageFormState {
  return {
    prompt: '',
    negativePrompt: '',
    referenceAssetIds: [],
    aspectRatio: '1:1',
    quality: 'standard',
    outputCount: 1,
    providerConfigId: '',
    model: '',
    agentCardHash: '',
    idempotencyKey: createImageIdempotencyKey(),
  };
}

function openSignedDownload(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.download = '';
  anchor.click();
}

function browserSessionStorage(): ImageStudioSessionStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function ImageStudioPage({ projectId }: { projectId: string }) {
  const t = useTranslations('studio');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const discovery = useIntelligenceCapabilityDiscovery(projectId);
  const agentCard = useIntelligenceAgentCard(projectId);
  const { mutateAsync: estimateImage, isPending: estimating } =
    useEstimateIntelligenceImage(projectId);
  const { mutateAsync: createTask, isPending: submitting } = useCreateIntelligenceTask(projectId);
  const { mutateAsync: cancelJob, isPending: cancelling } = useCancelIntelligenceJob(projectId);
  const { mutateAsync: createUpload } = useCreateIntelligenceUpload(projectId);
  const { mutateAsync: finalizeUpload } = useFinalizeIntelligenceUpload(projectId);
  const { mutateAsync: createDownloadUrl } = useIntelligenceAssetDownload(projectId);

  const initialTaskId = readImageStudioTaskId(searchParams);
  const sourceJobId = readImageStudioJobId(searchParams);
  const taskByJob = useIntelligenceTaskByJob(projectId, sourceJobId, {
    enabled: sourceJobId !== null && initialTaskId === null,
  });
  const [form, setForm] = useState<IntelligenceImageFormState>(initialForm);
  const [references, setReferences] = useState<ImageStudioReference[]>([]);
  const [estimateState, setEstimateState] = useState<ImageEstimateState | null>(null);
  const [taskId, setTaskId] = useState<string | null>(initialTaskId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [taskState, setTaskState] = useState<ImageTaskViewState>(() =>
    emptyImageTaskState(initialTaskId),
  );
  const [resultUrls, setResultUrls] = useState<Record<string, string>>({});
  const [operationErrorCode, setOperationErrorCode] = useState<string | null>(null);
  const [uploadingReference, setUploadingReference] = useState(false);
  const latestFingerprint = useRef<string | null>(null);
  const activeTaskId = useRef<string | null>(initialTaskId);
  const lastQueryTaskId = useRef<string | null>(initialTaskId);
  const formSnapshot = useRef(form);
  const resultUrlsSnapshot = useRef(resultUrls);
  const requestedPreviews = useRef(new Set<string>());
  formSnapshot.current = form;
  resultUrlsSnapshot.current = resultUrls;

  const targets = discovery.data?.execution_targets ?? EMPTY_EXECUTION_TARGETS;
  const selectedTarget = selectImageExecutionTarget(discovery.data, {
    providerConfigId: form.providerConfigId,
    model: form.model,
  });
  const validationCode = imageStudioValidationCode(form);
  const fingerprint = useMemo(() => {
    if (validationCode) return null;
    try {
      return imageEstimateFingerprint(form);
    } catch {
      return null;
    }
  }, [form, validationCode]);
  const targetSetupPending =
    targets.length > 0 && (!selectedTarget || agentCard.data?.card_hash !== form.agentCardHash);
  const discoveryState: DiscoveryState =
    discovery.isLoading || agentCard.isLoading
      ? 'loading'
      : discovery.error || agentCard.error
        ? 'error'
        : targets.length === 0
          ? 'unavailable'
          : targetSetupPending
            ? 'loading'
            : 'ready';
  const discoveryErrorCode = discovery.error
    ? imageStudioErrorCode(discovery.error)
    : agentCard.error
      ? imageStudioErrorCode(agentCard.error)
      : null;

  const setTaskQuery = useCallback(
    (nextTaskId: string) => {
      lastQueryTaskId.current = nextTaskId;
      router.replace(taskOnlyUrl(pathname, nextTaskId), { scroll: false });
    },
    [pathname, router],
  );

  const addReference = useCallback((assetId: string, previewUrl?: string) => {
    if (!UUID_PATTERN.test(assetId)) return;
    setReferences((current) => {
      const existing = current.find((reference) => reference.assetId === assetId);
      if (existing) {
        return previewUrl
          ? current.map((reference) =>
              reference.assetId === assetId ? { ...reference, previewUrl } : reference,
            )
          : current;
      }
      if (current.length >= 8) return current;
      return [...current, { assetId, ...(previewUrl ? { previewUrl } : {}) }];
    });
    setForm((current) =>
      current.referenceAssetIds.includes(assetId) || current.referenceAssetIds.length >= 8
        ? current
        : { ...current, referenceAssetIds: [...current.referenceAssetIds, assetId] },
    );
  }, []);

  const controller = useMemo(
    () =>
      createImageStudioController({
        createTask,
        cancelJob,
        createDownloadUrl,
        openUrl: openSignedDownload,
        setTaskQuery,
        addReference: (assetId) => addReference(assetId, resultUrlsSnapshot.current[assetId]),
      }),
    [addReference, cancelJob, createDownloadUrl, createTask, setTaskQuery],
  );

  const requestEstimate = useCallback(
    async (snapshot: IntelligenceImageFormState, snapshotFingerprint: string) => {
      try {
        const estimate = await estimateImage(buildImageEstimateRequest(snapshot));
        if (latestFingerprint.current === snapshotFingerprint) {
          setEstimateState(createImageEstimateState(snapshot, estimate));
        }
      } catch (error) {
        if (latestFingerprint.current === snapshotFingerprint) {
          setOperationErrorCode(imageStudioErrorCode(error));
        }
      }
    },
    [estimateImage],
  );

  const taskEvents = useIntelligenceTaskEvents(projectId, taskId, eventCursor, {
    enabled: !!taskId && !taskState.terminal,
    pollingEnabled: !taskState.terminal,
    refetchInterval: EVENT_POLL_INTERVAL_MS,
  });

  useEffect(() => {
    const target = selectedTarget ?? selectImageExecutionTarget(discovery.data, null);
    if (!target) return;
    if (target.provider_config_id === form.providerConfigId && target.model === form.model) {
      return;
    }
    setForm((current) => ({
      ...current,
      providerConfigId: target.provider_config_id,
      model: target.model,
    }));
  }, [discovery.data, form.model, form.providerConfigId, selectedTarget]);

  useEffect(() => {
    const cardHash = agentCard.data?.card_hash;
    if (!cardHash || cardHash === form.agentCardHash) return;
    setForm((current) => ({ ...current, agentCardHash: cardHash }));
  }, [agentCard.data?.card_hash, form.agentCardHash]);

  useEffect(() => {
    latestFingerprint.current = fingerprint;
    setEstimateState(null);
    if (!fingerprint || discoveryState !== 'ready') return;
    setOperationErrorCode(null);
    const snapshot = formSnapshot.current;
    const timer = window.setTimeout(() => {
      void requestEstimate(snapshot, fingerprint);
    }, ESTIMATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [discoveryState, fingerprint, requestEstimate]);

  useEffect(() => {
    const queryTaskId = readImageStudioTaskId(searchParams);
    if (queryTaskId !== lastQueryTaskId.current) {
      lastQueryTaskId.current = queryTaskId;
      activeTaskId.current = queryTaskId;
      setTaskId(queryTaskId);
      setJobId(null);
      setEventCursor(null);
      setTaskState(emptyImageTaskState(queryTaskId));
      setResultUrls({});
      requestedPreviews.current.clear();
    }

    const queryJobId = readImageStudioJobId(searchParams);
    if (queryJobId && !queryTaskId) return;

    const referenceAssetId = readReferenceAssetId(searchParams);
    if (referenceAssetId) addReference(referenceAssetId);

    const canonicalUrl = taskOnlyUrl(pathname, queryTaskId);
    const currentQuery = searchParams.toString();
    const canonicalQuery = queryTaskId ? `task=${encodeURIComponent(queryTaskId)}` : '';
    if (currentQuery !== canonicalQuery) {
      router.replace(canonicalUrl, { scroll: false });
    }
  }, [addReference, pathname, router, searchParams]);

  useEffect(() => {
    if (!sourceJobId || initialTaskId || !taskByJob.data) return;
    const lookup = taskByJob.data;
    if (lookup.job_id !== sourceJobId) {
      setOperationErrorCode('INTELLIGENCE_TASK_LOOKUP_FAILED');
      return;
    }
    lastQueryTaskId.current = lookup.task_id;
    activeTaskId.current = lookup.task_id;
    setTaskId(lookup.task_id);
    setJobId(lookup.job_id);
    setEventCursor(null);
    setTaskState(emptyImageTaskState(lookup.task_id));
    setResultUrls({});
    requestedPreviews.current.clear();
    const storage = browserSessionStorage();
    if (storage) rememberImageStudioJobId(storage, projectId, lookup.task_id, lookup.job_id);
    setOperationErrorCode(null);
    router.replace(taskOnlyUrl(pathname, lookup.task_id), { scroll: false });
  }, [initialTaskId, pathname, projectId, router, sourceJobId, taskByJob.data]);

  useEffect(() => {
    if (!taskByJob.error) return;
    setOperationErrorCode(imageStudioErrorCode(taskByJob.error));
  }, [taskByJob.error]);

  useEffect(() => {
    if (!taskEvents.data || taskEvents.data.task_id !== taskId) return;
    setTaskState((current) => reduceTaskEvents(taskEvents.data.items, current));
    if (taskEvents.data.next_cursor) setEventCursor(taskEvents.data.next_cursor);
  }, [taskEvents.data, taskId]);

  useEffect(() => {
    if (!taskEvents.error) return;
    setOperationErrorCode(imageStudioErrorCode(taskEvents.error));
  }, [taskEvents.error]);

  useEffect(() => {
    const currentTaskId = taskId;
    for (const assetId of taskState.assetIds) {
      if (resultUrls[assetId] || requestedPreviews.current.has(assetId)) continue;
      requestedPreviews.current.add(assetId);
      void createDownloadUrl(assetId).then(
        (download: IntelligenceAssetDownload) => {
          if (activeTaskId.current !== currentTaskId) return;
          setResultUrls((current) => ({
            ...current,
            [assetId]: download.signed_download_url,
          }));
        },
        (error: unknown) => {
          requestedPreviews.current.delete(assetId);
          if (activeTaskId.current === currentTaskId) {
            setOperationErrorCode(imageStudioErrorCode(error));
          }
        },
      );
    }
  }, [createDownloadUrl, resultUrls, taskId, taskState.assetIds]);

  useEffect(() => {
    activeTaskId.current = taskId;
  }, [taskId]);

  useEffect(() => {
    if (!taskId || jobId) return;
    const storage = browserSessionStorage();
    if (!storage) return;
    const rememberedJobId = readRememberedImageStudioJobId(storage, projectId, taskId);
    if (rememberedJobId) setJobId(rememberedJobId);
  }, [jobId, projectId, taskId]);

  useEffect(() => {
    if (!taskId || !taskState.terminal) return;
    const storage = browserSessionStorage();
    if (storage) forgetImageStudioJobId(storage, projectId, taskId);
  }, [projectId, taskId, taskState.terminal]);

  const updateForm = useCallback(
    <Key extends keyof IntelligenceImageFormState>(
      key: Key,
      value: IntelligenceImageFormState[Key],
    ) => {
      setForm((current) => ({ ...current, [key]: value }));
    },
    [],
  );

  const handleProviderChange = useCallback(
    (providerConfigId: string) => {
      const target = targets.find((candidate) => candidate.provider_config_id === providerConfigId);
      setForm((current) => ({
        ...current,
        providerConfigId,
        model: target?.model ?? '',
      }));
    },
    [targets],
  );

  const handleGenerate = useCallback(async () => {
    setOperationErrorCode(null);
    try {
      const response = await controller.submit(form, estimateState);
      activeTaskId.current = response.task_id;
      setTaskId(response.task_id);
      setJobId(response.job_id);
      const storage = browserSessionStorage();
      if (storage) {
        rememberImageStudioJobId(storage, projectId, response.task_id, response.job_id);
      }
      setEventCursor(null);
      setTaskState(emptyImageTaskState(response.task_id));
      setResultUrls({});
      requestedPreviews.current.clear();
      setForm((current) => ({ ...current, idempotencyKey: createImageIdempotencyKey() }));
    } catch (error) {
      const code = imageStudioErrorCode(error);
      setOperationErrorCode(code);
      if (code === 'INTELLIGENCE_IDEMPOTENCY_MISMATCH') {
        setForm((current) => ({ ...current, idempotencyKey: createImageIdempotencyKey() }));
      } else if (fingerprint && isImageEstimateRefreshError(code)) {
        setEstimateState(null);
        void requestEstimate(form, fingerprint);
      }
    }
  }, [controller, estimateState, fingerprint, form, projectId, requestEstimate]);

  const handleCancel = useCallback(async () => {
    const activeJobId = jobId ?? taskState.jobId;
    if (!activeJobId) return;
    setOperationErrorCode(null);
    try {
      await controller.cancel(activeJobId);
      setTaskState((current) => ({ ...current, status: 'cancelled', terminal: true }));
    } catch (error) {
      setOperationErrorCode(imageStudioErrorCode(error));
    }
  }, [controller, jobId, taskState.jobId]);

  const handleDownload = useCallback(
    async (assetId: string) => {
      setOperationErrorCode(null);
      try {
        await controller.download(assetId);
      } catch (error) {
        setOperationErrorCode(imageStudioErrorCode(error));
      }
    },
    [controller],
  );

  const handleReferenceFiles = useCallback(
    async (files: readonly File[]) => {
      const remaining = Math.max(0, 8 - form.referenceAssetIds.length);
      if (remaining === 0 || files.length === 0) return;
      setUploadingReference(true);
      setOperationErrorCode(null);
      try {
        for (const file of files.slice(0, remaining)) {
          const asset = await uploadReferenceImage({
            file,
            createUpload,
            finalizeUpload,
          });
          addReference(asset.asset_id, URL.createObjectURL(file));
        }
      } catch (error) {
        setOperationErrorCode(imageStudioErrorCode(error));
      } finally {
        setUploadingReference(false);
      }
    },
    [addReference, createUpload, finalizeUpload, form.referenceAssetIds.length],
  );

  const handleRemoveReference = useCallback((assetId: string) => {
    setReferences((current) => {
      const removed = current.find((reference) => reference.assetId === assetId);
      if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((reference) => reference.assetId !== assetId);
    });
    setForm((current) => ({
      ...current,
      referenceAssetIds: current.referenceAssetIds.filter((candidate) => candidate !== assetId),
    }));
  }, []);

  const handleRetry = useCallback(() => {
    setOperationErrorCode(null);
    if (discoveryState === 'error') {
      void retryImageStudioDiscovery(discovery.refetch, agentCard.refetch);
      return;
    }
    if (sourceJobId && taskByJob.isError) {
      void taskByJob.refetch();
      return;
    }
    if (!estimateState && fingerprint) {
      void requestEstimate(form, fingerprint);
      return;
    }
    void handleGenerate();
  }, [
    agentCard.refetch,
    discovery.refetch,
    discoveryState,
    estimateState,
    fingerprint,
    form,
    handleGenerate,
    requestEstimate,
    sourceJobId,
    taskByJob,
  ]);

  const labels: ImageStudioLabels = {
    title: t('image.title'),
    loadingDiscovery: t('image.loadingDiscovery'),
    unavailable: t('image.unavailable'),
    retry: t('image.retry'),
    prompt: t('image.prompt'),
    promptPlaceholder: t('image.promptPlaceholder'),
    negativePrompt: t('image.negativePrompt'),
    negativePromptPlaceholder: t('image.negativePromptPlaceholder'),
    provider: t('image.provider'),
    model: t('image.model'),
    aspectRatio: t('image.aspectRatio'),
    quality: t('image.quality'),
    qualityStandard: t('image.qualityStandard'),
    qualityHigh: t('image.qualityHigh'),
    outputCount: t('image.outputCount'),
    decreaseOutputCount: t('image.decreaseOutputCount'),
    increaseOutputCount: t('image.increaseOutputCount'),
    references: t('image.references'),
    addReference: t('image.addReference'),
    removeReference: t('image.removeReference'),
    uploadingReference: t('image.uploadingReference'),
    estimate: t('image.estimate'),
    estimating: t('image.estimating'),
    credits: t('image.credits'),
    generate: t('image.generate'),
    generating: t('image.generating'),
    results: t('image.results'),
    noResults: t('image.noResults'),
    statusUnknown: t('image.statusUnknown'),
    statusQueued: t('image.statusQueued'),
    statusRunning: t('image.statusRunning'),
    statusProgress: t('image.statusProgress'),
    statusWaitingApproval: t('image.statusWaitingApproval'),
    statusSucceeded: t('image.statusSucceeded'),
    statusFailed: t('image.statusFailed'),
    statusCancelled: t('image.statusCancelled'),
    cancel: t('image.cancel'),
    download: t('image.download'),
    reuseReference: t('image.reuseReference'),
    resultAlt: t('image.resultAlt'),
    insufficientCredits: t('image.insufficientCredits'),
    permissionDenied: t('image.permissionDenied'),
    validationInvalidPrompt: t('image.validationInvalidPrompt'),
    validationInvalidNegativePrompt: t('image.validationInvalidNegativePrompt'),
    validationInvalidOutputCount: t('image.validationInvalidOutputCount'),
    validationInvalidReferenceAssets: t('image.validationInvalidReferenceAssets'),
    validationInvalidProvider: t('image.validationInvalidProvider'),
    validationInvalidModel: t('image.validationInvalidModel'),
    requestFailed: t('image.requestFailed'),
  };

  const currentEstimate =
    !validationCode && fingerprint && estimateState?.formFingerprint === fingerprint
      ? estimateState.estimate
      : null;

  return (
    <ImageStudioView
      discoveryState={discoveryState}
      targets={targets}
      form={form}
      references={references}
      estimate={currentEstimate}
      estimating={estimating}
      validationCode={validationCode}
      submitting={submitting}
      uploadingReference={uploadingReference}
      taskState={taskState}
      results={taskState.assetIds.map((assetId) => ({
        assetId,
        ...(resultUrls[assetId] ? { previewUrl: resultUrls[assetId] } : {}),
      }))}
      operationErrorCode={operationErrorCode ?? discoveryErrorCode}
      canCancel={!!(jobId ?? taskState.jobId) && !taskState.terminal}
      cancelling={cancelling}
      labels={labels}
      onPromptChange={(value) => updateForm('prompt', value)}
      onNegativePromptChange={(value) => updateForm('negativePrompt', value)}
      onProviderChange={handleProviderChange}
      onModelChange={(value) => updateForm('model', value)}
      onAspectRatioChange={(value) => updateForm('aspectRatio', value)}
      onQualityChange={(value) => updateForm('quality', value)}
      onOutputCountChange={(value) => updateForm('outputCount', value)}
      onReferenceFiles={(files) => void handleReferenceFiles(files)}
      onRemoveReference={handleRemoveReference}
      onGenerate={() => void handleGenerate()}
      onCancel={() => void handleCancel()}
      onRetry={handleRetry}
      onDownload={(assetId) => void handleDownload(assetId)}
      onReuseReference={(assetId) => controller.reuse(assetId)}
    />
  );
}
