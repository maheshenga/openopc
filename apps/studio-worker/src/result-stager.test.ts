import { describe, expect, test } from 'bun:test';
import {
  InMemoryStudioObjectStore,
  StudioStorageUnavailableError,
  studioStagingManifestKey,
  studioStagingPrefix,
  studioSubmissionKeyHash,
} from '@kortix/studio-runtime';
import type { StudioProviderAsset } from '@kortix/studio-runtime';
import { StudioResultStager } from './result-stager';

const IDS = {
  accountId: '11111111-1111-4111-8111-111111111111',
  projectId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  attemptId: '44444444-4444-4444-8444-444444444444',
  providerConfigId: '55555555-5555-4555-8555-555555555555',
  pricingCatalogId: '66666666-6666-4666-8666-666666666666',
};

const PNG = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

function asset(
  input: { openBody: StudioProviderAsset['openBody']; replayable?: boolean } = {
    openBody: async () => new Blob([PNG]).stream(),
  },
) {
  return {
    kind: 'image' as const,
    filename: 'result.png',
    mime_type: 'image/png',
    size_bytes: PNG.byteLength,
    replayable_within_attempt: input.replayable ?? true,
    openBody: input.openBody,
  } satisfies StudioProviderAsset;
}

function stageInput(overrides: Record<string, unknown> = {}) {
  return {
    ...IDS,
    submissionKey: 'submission-key-1',
    providerConfigVersion: 'provider-v1',
    pricingVersion: 1,
    assets: [asset()],
    usage: { output_count: 1 },
    ...overrides,
  };
}

describe('StudioResultStager', () => {
  test('stages assets under the deterministic identity prefix and writes manifest last', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const stager = new StudioResultStager(store);
    const result = await stager.stage(stageInput());

    const prefix = studioStagingPrefix({
      accountId: IDS.accountId,
      projectId: IDS.projectId,
      jobId: IDS.jobId,
      attemptId: IDS.attemptId,
      submissionKeyHash: studioSubmissionKeyHash('submission-key-1'),
    });
    expect(result.manifestKey).toBe(`${prefix}manifest.json`);
    expect(result.manifest.assets[0]?.key.startsWith(prefix)).toBe(true);
    expect(result.manifest.account_id).toBe(IDS.accountId);
    expect(result.manifest.submission_key_hash).toBe(studioSubmissionKeyHash('submission-key-1'));
    expect(JSON.stringify(result.manifest)).not.toMatch(/https?:\/\//i);
    expect(JSON.stringify(result.manifest)).not.toMatch(/credential|authorization|raw_body/i);
    await expect(store.headObject({ key: result.manifestKey })).resolves.toMatchObject({
      content_type: 'application/json',
    });
  });

  test('is idempotent for the same staged result and rejects a conflicting existing manifest', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const stager = new StudioResultStager(store);
    const first = await stager.stage(stageInput());
    const replay = await stager.stage(stageInput());
    expect(replay.manifestChecksum).toBe(first.manifestChecksum);
    expect(replay.manifest.assets).toEqual(first.manifest.assets);

    const conflictingKey = studioStagingManifestKey({
      accountId: IDS.accountId,
      projectId: IDS.projectId,
      jobId: IDS.jobId,
      attemptId: IDS.attemptId,
      submissionKeyHash: studioSubmissionKeyHash('submission-key-1'),
    });
    const conflictingStore = new InMemoryStudioObjectStore({
      namespace: 'studio-test',
      ready: true,
    });
    const conflicting = new StudioResultStager(conflictingStore);
    await conflictingStore.putObject({
      key: conflictingKey,
      body: new Blob([JSON.stringify({ ...first.manifest, job_id: IDS.accountId })]).stream(),
      content_type: 'application/json',
      size_bytes: JSON.stringify({ ...first.manifest, job_id: IDS.accountId }).length,
      checksum_sha256: await sha256(JSON.stringify({ ...first.manifest, job_id: IDS.accountId })),
      metadata: { kind: 'studio-staging-manifest' },
    });
    await expect(conflicting.stage(stageInput())).rejects.toThrow(/manifest/i);
  });

  test('does not publish a manifest after an asset failure and caps replayable opens at three', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    let opens = 0;
    const broken = asset({
      openBody: async () => {
        opens += 1;
        throw new Error('source unavailable');
      },
    });
    const stager = new StudioResultStager(store);
    await expect(stager.stage(stageInput({ assets: [broken] }))).rejects.toMatchObject({
      classification: 'unknown_outcome',
    });
    expect(opens).toBeLessThanOrEqual(3);
    await expect(
      store.headObject({
        key: studioStagingManifestKey({
          accountId: IDS.accountId,
          projectId: IDS.projectId,
          jobId: IDS.jobId,
          attemptId: IDS.attemptId,
          submissionKeyHash: studioSubmissionKeyHash('submission-key-1'),
        }),
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('stages a non-replayable source once and treats its read failure as unknown', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    let opens = 0;
    const once = asset({
      replayable: false,
      openBody: async () => {
        opens += 1;
        return new Blob([PNG]).stream();
      },
    });
    const stager = new StudioResultStager(store);

    await expect(stager.stage(stageInput({ assets: [once] }))).resolves.toMatchObject({
      manifest: { assets: [{ mime_type: 'image/png' }] },
    });
    expect(opens).toBe(1);

    const brokenStore = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const broken = asset({
      replayable: false,
      openBody: async () => {
        throw new Error('one-shot source failed');
      },
    });
    await expect(
      new StudioResultStager(brokenStore).stage(
        stageInput({ submissionKey: 'submission-key-2', assets: [broken] }),
      ),
    ).rejects.toMatchObject({ classification: 'unknown_outcome' });
  });

  test('reuses an exact existing asset without overwriting it', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const key = stagingAssetKey();
    await store.putObject({
      key,
      body: new Blob([PNG]).stream(),
      content_type: 'image/png',
      size_bytes: PNG.byteLength,
      checksum_sha256: checksum(PNG),
      metadata: { kind: 'studio-staging-asset' },
    });
    const originalPut = store.putObject.bind(store);
    let assetPuts = 0;
    store.putObject = async (input) => {
      if (input.key === key) assetPuts += 1;
      return originalPut(input);
    };

    await expect(new StudioResultStager(store).stage(stageInput())).resolves.toMatchObject({
      manifest: { assets: [{ key }] },
    });
    expect(assetPuts).toBe(0);
  });

  test('rejects a conflicting existing asset without overwriting it', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const key = stagingAssetKey();
    const conflictingBytes = new Uint8Array([1, 2, 3, 4]);
    const conflictingChecksum = checksum(conflictingBytes);
    await store.putObject({
      key,
      body: new Blob([conflictingBytes]).stream(),
      content_type: 'application/octet-stream',
      size_bytes: conflictingBytes.byteLength,
      checksum_sha256: conflictingChecksum,
      metadata: { kind: 'studio-staging-asset' },
    });

    await expect(new StudioResultStager(store).stage(stageInput())).rejects.toMatchObject({
      classification: 'terminal',
    });
    await expect(store.headObject({ key })).resolves.toMatchObject({
      checksum_sha256: conflictingChecksum,
      content_type: 'application/octet-stream',
    });
  });

  test('replays a transient asset put only within the configured source-open cap', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const originalPut = store.putObject.bind(store);
    let assetPuts = 0;
    let opens = 0;
    store.putObject = async (input) => {
      if (input.key.includes('/assets/')) {
        assetPuts += 1;
        if (assetPuts === 1) throw new StudioStorageUnavailableError();
      }
      return originalPut(input);
    };

    await expect(
      new StudioResultStager(store).stage(
        stageInput({
          assets: [
            asset({
              openBody: async () => {
                opens += 1;
                return new Blob([PNG]).stream();
              },
            }),
          ],
        }),
      ),
    ).resolves.toMatchObject({ manifest: { assets: [{ mime_type: 'image/png' }] } });
    expect(assetPuts).toBe(2);
    expect(opens).toBe(2);
    expect(opens).toBeLessThanOrEqual(3);
  });

  test('recovers an exact asset after the object store loses the put acknowledgement', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const originalPut = store.putObject.bind(store);
    let lostAcknowledgement = true;
    let opens = 0;
    store.putObject = async (input) => {
      const written = await originalPut(input);
      if (input.key.includes('/assets/') && lostAcknowledgement) {
        lostAcknowledgement = false;
        throw new StudioStorageUnavailableError();
      }
      return written;
    };

    await expect(
      new StudioResultStager(store).stage(
        stageInput({
          assets: [
            asset({
              openBody: async () => {
                opens += 1;
                return new Blob([PNG]).stream();
              },
            }),
          ],
        }),
      ),
    ).resolves.toMatchObject({ manifest: { assets: [{ mime_type: 'image/png' }] } });
    expect(opens).toBe(1);
  });

  test('recovers the manifest after the object store loses the put acknowledgement', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const originalPut = store.putObject.bind(store);
    let lostAcknowledgement = true;
    store.putObject = async (input) => {
      const written = await originalPut(input);
      if (input.key.endsWith('/manifest.json') && lostAcknowledgement) {
        lostAcknowledgement = false;
        throw new StudioStorageUnavailableError();
      }
      return written;
    };

    await expect(new StudioResultStager(store).stage(stageInput())).resolves.toMatchObject({
      manifest: { usage: { output_count: 1 } },
    });
  });

  test('retries an absent manifest without reopening or rewriting staged assets', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const originalPut = store.putObject.bind(store);
    let assetPuts = 0;
    let manifestPuts = 0;
    let opens = 0;
    store.putObject = async (input) => {
      if (input.key.includes('/assets/')) assetPuts += 1;
      if (input.key.endsWith('/manifest.json')) {
        manifestPuts += 1;
        if (manifestPuts < 3) throw new StudioStorageUnavailableError();
      }
      return originalPut(input);
    };

    await expect(
      new StudioResultStager(store).stage(
        stageInput({
          assets: [
            asset({
              openBody: async () => {
                opens += 1;
                return new Blob([PNG]).stream();
              },
            }),
          ],
        }),
      ),
    ).resolves.toMatchObject({ manifest: { usage: { output_count: 1 } } });
    expect(manifestPuts).toBe(3);
    expect(assetPuts).toBe(1);
    expect(opens).toBe(1);
  });

  test('uses conditional create for every staged asset and manifest', async () => {
    const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true });
    const originalPut = store.putObject.bind(store);
    const conditions: unknown[] = [];
    store.putObject = async (input) => {
      conditions.push((input as unknown as Record<string, unknown>).if_none_match);
      return originalPut(input);
    };

    await new StudioResultStager(store).stage(stageInput());
    expect(conditions).toEqual(['*', '*']);
  });
});

async function sha256(value: string): Promise<string> {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}

function checksum(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

function stagingAssetKey(): string {
  return `${studioStagingPrefix({
    accountId: IDS.accountId,
    projectId: IDS.projectId,
    jobId: IDS.jobId,
    attemptId: IDS.attemptId,
    submissionKeyHash: studioSubmissionKeyHash('submission-key-1'),
  })}assets/000-result.png`;
}
