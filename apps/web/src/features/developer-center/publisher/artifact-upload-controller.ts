import {
  type CreateDeveloperModuleArtifactUploadInput,
  type DeveloperModuleArtifact,
  type DeveloperModuleArtifactUploadTicket,
  type DeveloperModuleDigest,
  type DeveloperModuleReleaseAccountOptions,
  type DeveloperModuleReleaseSubmission,
  type SubmitDeveloperModuleReleaseInput,
  cancelDeveloperModuleArtifactUpload,
  createDeveloperModuleArtifactUpload,
  finalizeDeveloperModuleArtifactUpload,
  submitDeveloperModuleRelease,
} from '@kortix/sdk';

export const DEVELOPER_MODULE_PACKAGE_MAX_BYTES = 512 * 1024 * 1024;

export type DeveloperModuleArtifactUploadStage =
  | 'idle'
  | 'hashing'
  | 'requesting_upload'
  | 'uploading'
  | 'finalizing'
  | 'submitting'
  | 'submitted'
  | 'cancelled'
  | 'error';

export interface DeveloperModuleArtifactUploadState {
  stage: DeveloperModuleArtifactUploadStage;
  fileName: string | null;
  fileSize: number;
  progress: number;
  digest: DeveloperModuleDigest | null;
  uploadId: string | null;
  artifact: DeveloperModuleArtifact | null;
  submission: DeveloperModuleReleaseSubmission | null;
}

export interface DeveloperModuleArtifactUploadDependencies {
  hash: (file: File, signal: AbortSignal) => Promise<DeveloperModuleDigest>;
  createUpload: (
    input: CreateDeveloperModuleArtifactUploadInput,
  ) => Promise<DeveloperModuleArtifactUploadTicket>;
  upload: (
    ticket: DeveloperModuleArtifactUploadTicket,
    file: File,
    signal: AbortSignal,
    onProgress: (loaded: number, total: number) => void,
  ) => Promise<void>;
  finalizeUpload: (
    uploadId: string,
    options?: DeveloperModuleReleaseAccountOptions,
  ) => Promise<DeveloperModuleArtifact>;
  cancelUpload: (uploadId: string, options?: DeveloperModuleReleaseAccountOptions) => Promise<void>;
  submitRelease: (
    input: SubmitDeveloperModuleReleaseInput,
  ) => Promise<DeveloperModuleReleaseSubmission>;
}

export interface DeveloperModuleArtifactUploadStartOptions {
  accountId: string;
  publisherId: string;
}

function initialState(): DeveloperModuleArtifactUploadState {
  return {
    stage: 'idle',
    fileName: null,
    fileSize: 0,
    progress: 0,
    digest: null,
    uploadId: null,
    artifact: null,
    submission: null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : Boolean(
        error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError',
      );
}

export async function hashDeveloperModuleArtifact(
  file: File,
  signal: AbortSignal,
): Promise<DeveloperModuleDigest> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const bytes = await file.arrayBuffer();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const result = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `sha256:${hex}`;
}

export function uploadDeveloperModuleArtifactBytes(
  ticket: DeveloperModuleArtifactUploadTicket,
  file: File,
  signal: AbortSignal,
  onProgress: (loaded: number, total: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    const finish = (callback: () => void) => {
      signal.removeEventListener('abort', abort);
      callback();
    };

    request.open('PUT', ticket.upload_url, true);
    for (const [name, value] of Object.entries(ticket.headers))
      request.setRequestHeader(name, value);
    request.upload.onprogress = (event) =>
      onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    request.onerror = () => finish(() => reject(new Error('DEVELOPER_ARTIFACT_UPLOAD_FAILED')));
    request.onabort = () =>
      finish(() => reject(new DOMException('Artifact upload cancelled', 'AbortError')));
    request.onload = () =>
      finish(() => {
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new Error('DEVELOPER_ARTIFACT_UPLOAD_FAILED'));
      });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else request.send(file);
  });
}

export const defaultDeveloperModuleArtifactUploadDependencies: DeveloperModuleArtifactUploadDependencies =
  {
    hash: hashDeveloperModuleArtifact,
    createUpload: createDeveloperModuleArtifactUpload,
    upload: uploadDeveloperModuleArtifactBytes,
    finalizeUpload: finalizeDeveloperModuleArtifactUpload,
    cancelUpload: cancelDeveloperModuleArtifactUpload,
    submitRelease: submitDeveloperModuleRelease,
  };

export function createDeveloperModuleArtifactUploadController(
  dependencies: DeveloperModuleArtifactUploadDependencies = defaultDeveloperModuleArtifactUploadDependencies,
  onStateChange: (state: DeveloperModuleArtifactUploadState) => void = () => undefined,
) {
  let state = initialState();
  let pending: Promise<DeveloperModuleReleaseSubmission | null> | null = null;
  let abortController: AbortController | null = null;
  let accountId: string | null = null;
  let cleanup: Promise<void> | null = null;
  let cancellationRequested = false;

  const getState = (): DeveloperModuleArtifactUploadState => ({ ...state });
  const update = (patch: Partial<DeveloperModuleArtifactUploadState>) => {
    state = { ...state, ...patch };
    onStateChange(getState());
  };
  const cleanupUpload = (): Promise<void> => {
    if (!state.uploadId || !accountId) return Promise.resolve();
    if (!cleanup) {
      cleanup = dependencies.cancelUpload(state.uploadId, { accountId }).catch(() => undefined);
    }
    return cleanup;
  };

  const start = (
    file: File,
    options: DeveloperModuleArtifactUploadStartOptions,
  ): Promise<DeveloperModuleReleaseSubmission | null> => {
    if (pending) return pending;
    if (file.size <= 0 || file.size > DEVELOPER_MODULE_PACKAGE_MAX_BYTES) {
      update({
        ...initialState(),
        stage: 'error',
        fileName: file.name,
        fileSize: file.size,
      });
      return Promise.reject(new Error('DEVELOPER_ARTIFACT_SIZE_INVALID'));
    }

    const operationAbortController = new AbortController();
    abortController = operationAbortController;
    accountId = options.accountId;
    cleanup = null;
    cancellationRequested = false;
    update({
      ...initialState(),
      stage: 'hashing',
      fileName: file.name,
      fileSize: file.size,
    });

    pending = (async () => {
      try {
        const digest = await dependencies.hash(file, operationAbortController.signal);
        if (cancellationRequested) return null;
        update({ stage: 'requesting_upload', progress: 5, digest });

        const ticket = await dependencies.createUpload({
          accountId: options.accountId,
          publisherId: options.publisherId,
          expectedSize: file.size,
          expectedDigest: digest,
        });
        update({ stage: 'uploading', progress: 10, uploadId: ticket.upload_id });
        if (
          ticket.expected_digest !== digest ||
          ticket.expected_size !== file.size ||
          cancellationRequested
        ) {
          await cleanupUpload();
          if (cancellationRequested) return null;
          throw new Error('DEVELOPER_ARTIFACT_UPLOAD_TICKET_INVALID');
        }

        await dependencies.upload(
          ticket,
          file,
          operationAbortController.signal,
          (loaded, total) => {
            const ratio = total > 0 ? Math.min(Math.max(loaded / total, 0), 1) : 0;
            update({ stage: 'uploading', progress: Math.round(10 + ratio * 65) });
          },
        );
        if (cancellationRequested) return null;

        update({ stage: 'finalizing', progress: 80 });
        const artifact = await dependencies.finalizeUpload(ticket.upload_id, {
          accountId: options.accountId,
        });
        if (cancellationRequested) return null;
        update({ stage: 'submitting', progress: 90, artifact });
        const submission = await dependencies.submitRelease({
          artifactId: artifact.artifact_id,
          accountId: options.accountId,
        });
        if (cancellationRequested) return null;
        update({ stage: 'submitted', progress: 100, submission });
        return submission;
      } catch (error) {
        if (cancellationRequested || isAbortError(error)) {
          await cleanupUpload();
          update({ stage: 'cancelled', progress: 0 });
          return null;
        }
        await cleanupUpload();
        update({ stage: 'error' });
        throw error;
      } finally {
        pending = null;
        abortController = null;
      }
    })();
    return pending;
  };

  const cancel = async (): Promise<void> => {
    cancellationRequested = true;
    abortController?.abort();
    await cleanupUpload();
    update({ stage: 'cancelled', progress: 0 });
  };

  const reset = (): DeveloperModuleArtifactUploadState => {
    if (pending) throw new Error('DEVELOPER_ARTIFACT_UPLOAD_ACTIVE');
    state = initialState();
    onStateChange(getState());
    return getState();
  };

  return { getState, start, cancel, reset };
}
