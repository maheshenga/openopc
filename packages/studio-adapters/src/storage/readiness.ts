import { createHash, randomUUID } from 'node:crypto';
import {
  type StudioObjectMetadata,
  type StudioObjectStore,
  StudioStorageUnavailableError,
} from '@kortix/studio-runtime';

const DEFAULT_CACHE_MS = 60_000;
const READINESS_CONTENT_TYPE = 'application/octet-stream';
const READINESS_BYTE = new Uint8Array([1]);
const READINESS_CHECKSUM = createHash('sha256').update(READINESS_BYTE).digest('hex');

export function createCachedStudioReadinessProbe(input: {
  store: StudioObjectStore;
  role: 'api' | 'worker';
  cacheMs?: number;
  now?: () => number;
}): () => Promise<void> {
  const now = input.now ?? Date.now;
  const cacheMs = Math.max(0, input.cacheMs ?? DEFAULT_CACHE_MS);
  let readyUntil = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | null = null;

  return async () => {
    if (now() < readyUntil) return;
    if (inFlight) return inFlight;

    inFlight = runReadinessProbe(input.store, input.role)
      .then(() => {
        readyUntil = now() + cacheMs;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

async function runReadinessProbe(store: StudioObjectStore, role: 'api' | 'worker'): Promise<void> {
  const key = `_studio-readiness/${role}/${randomUUID()}`;
  let failed = false;

  try {
    await store.putObject({
      key,
      body: new Blob([READINESS_BYTE]).stream(),
      content_type: READINESS_CONTENT_TYPE,
      size_bytes: READINESS_BYTE.byteLength,
      checksum_sha256: READINESS_CHECKSUM,
      metadata: {},
    });
    const head = await store.headObject({ key });
    verifyMetadata(head, key);
    const object = await store.getObject({ key });
    verifyMetadata(object, key);
    const bytes = await readBoundedProbeBody(object.body);
    if (
      bytes.byteLength !== READINESS_BYTE.byteLength ||
      bytes[0] !== READINESS_BYTE[0] ||
      createHash('sha256').update(bytes).digest('hex') !== READINESS_CHECKSUM
    ) {
      failed = true;
    }
  } catch {
    failed = true;
  }

  try {
    await store.deleteObject({ key });
  } catch {
    failed = true;
  }

  if (failed) throw new StudioStorageUnavailableError();
}

function verifyMetadata(metadata: StudioObjectMetadata, key: string): void {
  if (
    metadata.key !== key ||
    metadata.content_type !== READINESS_CONTENT_TYPE ||
    metadata.size_bytes !== READINESS_BYTE.byteLength ||
    metadata.checksum_sha256 !== READINESS_CHECKSUM
  ) {
    throw new StudioStorageUnavailableError();
  }
}

async function readBoundedProbeBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const bytes = new Uint8Array(READINESS_BYTE.byteLength);
  let offset = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) return bytes.slice(0, offset);
    if (offset + next.value.byteLength > READINESS_BYTE.byteLength) {
      await reader.cancel();
      return new Uint8Array();
    }
    bytes.set(next.value, offset);
    offset += next.value.byteLength;
  }
}
