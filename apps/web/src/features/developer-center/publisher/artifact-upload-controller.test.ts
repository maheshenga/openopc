import { describe, expect, mock, test } from 'bun:test';
import type {
  DeveloperModuleArtifact,
  DeveloperModuleArtifactUploadTicket,
  DeveloperModuleReleaseSubmission,
} from '@kortix/sdk';

import { createDeveloperModuleArtifactUploadController } from './artifact-upload-controller';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const DIGEST = `sha256:${'a'.repeat(64)}` as const;
const TICKET: DeveloperModuleArtifactUploadTicket = {
  upload_id: '12000000-0000-4000-a000-000000000001',
  state: 'created',
  expected_digest: DIGEST,
  expected_size: 12,
  upload_url: 'https://objects.example.test/presigned',
  headers: { 'x-upload-token': 'opaque' },
  expires_at: '2026-07-25T12:05:00.000Z',
};
const ARTIFACT: DeveloperModuleArtifact = {
  artifact_id: '13000000-0000-4000-a000-000000000001',
  account_id: ACCOUNT_ID,
  publisher_id: 'acme',
  artifact_digest: DIGEST,
  envelope_digest: `sha256:${'b'.repeat(64)}`,
  media_type: 'application/vnd.openopc.developer-module.v2+json',
  size_bytes: 12,
  item_snapshot: { type: 'registry:module', id: 'acme.recruiting' },
  source_provenance: null,
  created_by: '14000000-0000-4000-a000-000000000001',
  created_at: '2026-07-25T12:00:00.000Z',
};
const SUBMISSION = {
  created: true,
  release: { release_id: '15000000-0000-4000-a000-000000000001' },
} as DeveloperModuleReleaseSubmission;

function packageFile() {
  return new File(['package-data'], 'module.openopc', { type: 'application/octet-stream' });
}

describe('developer module artifact upload controller', () => {
  test('hashes, uploads, finalizes and submits one artifact in order', async () => {
    const order: string[] = [];
    const createUpload = mock(async () => {
      order.push('ticket');
      return TICKET;
    });
    const upload = mock(async (_ticket, _file, _signal, onProgress) => {
      order.push('upload');
      onProgress(4, 12);
      onProgress(12, 12);
    });
    const finalizeUpload = mock(async () => {
      order.push('finalize');
      return ARTIFACT;
    });
    const submitRelease = mock(async () => {
      order.push('submit');
      return SUBMISSION;
    });
    const stages: string[] = [];
    const controller = createDeveloperModuleArtifactUploadController(
      {
        hash: async () => {
          order.push('hash');
          return DIGEST;
        },
        createUpload,
        upload,
        finalizeUpload,
        cancelUpload: async () => undefined,
        submitRelease,
      },
      (state) => stages.push(state.stage),
    );

    await expect(
      controller.start(packageFile(), { accountId: ACCOUNT_ID, publisherId: 'acme' }),
    ).resolves.toEqual(SUBMISSION);

    expect(order).toEqual(['hash', 'ticket', 'upload', 'finalize', 'submit']);
    expect(createUpload).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
      expectedSize: 12,
      expectedDigest: DIGEST,
    });
    const uploadCall = upload.mock.calls[0];
    expect(uploadCall?.[0]).toEqual(TICKET);
    expect(uploadCall?.[1]).toBeInstanceOf(File);
    expect(uploadCall?.[2]).toBeInstanceOf(AbortSignal);
    expect(typeof uploadCall?.[3]).toBe('function');
    expect(finalizeUpload).toHaveBeenCalledWith(TICKET.upload_id, { accountId: ACCOUNT_ID });
    expect(submitRelease).toHaveBeenCalledWith({
      artifactId: ARTIFACT.artifact_id,
      accountId: ACCOUNT_ID,
    });
    expect(stages).toEqual([
      'hashing',
      'requesting_upload',
      'uploading',
      'uploading',
      'uploading',
      'finalizing',
      'submitting',
      'submitted',
    ]);
    expect(controller.getState()).toMatchObject({
      stage: 'submitted',
      progress: 100,
      digest: DIGEST,
      artifact: ARTIFACT,
      submission: SUBMISSION,
    });
  });

  test('cancels an active byte upload and cleans up the server ticket', async () => {
    let uploadStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });
    const cancelUpload = mock(async () => undefined);
    const upload = mock(
      async (_ticket, _file, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          uploadStarted();
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const submitRelease = mock(async () => SUBMISSION);
    const controller = createDeveloperModuleArtifactUploadController({
      hash: async () => DIGEST,
      createUpload: async () => TICKET,
      upload,
      finalizeUpload: async () => ARTIFACT,
      cancelUpload,
      submitRelease,
    });

    const pending = controller.start(packageFile(), {
      accountId: ACCOUNT_ID,
      publisherId: 'acme',
    });
    await started;
    await controller.cancel();
    await expect(pending).resolves.toBeNull();

    expect(cancelUpload).toHaveBeenCalledWith(TICKET.upload_id, { accountId: ACCOUNT_ID });
    expect(submitRelease).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ stage: 'cancelled', progress: 0 });
  });

  test('cleans up the server ticket when an upload step fails', async () => {
    const cancelUpload = mock(async () => undefined);
    const controller = createDeveloperModuleArtifactUploadController({
      hash: async () => DIGEST,
      createUpload: async () => TICKET,
      upload: async () => {
        throw new Error('object storage unavailable');
      },
      finalizeUpload: async () => ARTIFACT,
      cancelUpload,
      submitRelease: async () => SUBMISSION,
    });

    await expect(
      controller.start(packageFile(), { accountId: ACCOUNT_ID, publisherId: 'acme' }),
    ).rejects.toThrow('object storage unavailable');

    expect(cancelUpload).toHaveBeenCalledWith(TICKET.upload_id, { accountId: ACCOUNT_ID });
    expect(controller.getState()).toMatchObject({ stage: 'error' });
  });

  test('deduplicates concurrent starts and never exposes the presigned URL in state', async () => {
    let resolveUpload!: () => void;
    const upload = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    const controller = createDeveloperModuleArtifactUploadController({
      hash: async () => DIGEST,
      createUpload: async () => TICKET,
      upload,
      finalizeUpload: async () => ARTIFACT,
      cancelUpload: async () => undefined,
      submitRelease: async () => SUBMISSION,
    });
    const file = packageFile();

    const first = controller.start(file, { accountId: ACCOUNT_ID, publisherId: 'acme' });
    const replay = controller.start(file, { accountId: ACCOUNT_ID, publisherId: 'acme' });
    await Bun.sleep(0);

    expect(first).toBe(replay);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(controller.getState())).not.toContain(TICKET.upload_url);
    expect(JSON.stringify(controller.getState())).not.toContain('x-upload-token');
    resolveUpload();
    await first;
  });
});
