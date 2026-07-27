import {
  type Sha256Digest,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
  sha256Digest,
} from '@openopc/module-runtime-contracts';

export interface StoredRuntimeArtifact {
  digest: Sha256Digest;
  bytes: number;
  mediaType: 'application/wasm';
  storageKey: string;
}

export interface RuntimeArtifactStore {
  write(input: {
    accountId: string;
    digest: Sha256Digest;
    bytes: Uint8Array;
  }): Promise<StoredRuntimeArtifact>;
  read(storageKey: string, maxBytes: number): AsyncIterable<Uint8Array>;
}

export interface RuntimeArtifactMetadata extends StoredRuntimeArtifact {
  runtimeArtifactId: string;
  accountId: string;
  releaseId: string;
  runtimeDescriptorId: string;
}

export interface RuntimeArtifactMetadataStore {
  get(
    accountId: string,
    releaseId: string,
    runtimeDescriptorId: string,
  ): Promise<RuntimeArtifactMetadata | null>;
}

export interface RuntimeArtifactLeaseCoordinates {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
}

export interface RuntimeArtifactLeaseStore {
  getForLease(input: RuntimeArtifactLeaseCoordinates): Promise<RuntimeArtifactMetadata | null>;
}

export interface RuntimeArtifactRead {
  digest: Sha256Digest;
  bytes: number;
  body: ReadableStream<Uint8Array>;
}

export class RuntimeArtifactAccessError extends Error {
  readonly code = 'RUNNER_EXECUTION_UNAVAILABLE';
  readonly status = 409;

  constructor() {
    super('RUNNER_EXECUTION_UNAVAILABLE');
    this.name = 'RuntimeArtifactAccessError';
  }
}

export class RuntimeArtifactStoreError extends Error {
  readonly code = 'RUNTIME_ARTIFACT_STORE_UNAVAILABLE';

  constructor() {
    super('RUNTIME_ARTIFACT_STORE_UNAVAILABLE');
    this.name = 'RuntimeArtifactStoreError';
  }
}

function clone(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function validSize(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 1 && bytes.byteLength <= WASI_RUNTIME_ARTIFACT_MAX_BYTES;
}

function boundedArtifactStream(
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let total = 0;
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      try {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          if (total !== expectedBytes) throw new RuntimeArtifactStoreError();
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array) || total + next.value.byteLength > expectedBytes) {
          throw new RuntimeArtifactStoreError();
        }
        total += next.value.byteLength;
        controller.enqueue(clone(next.value));
      } catch (error) {
        finished = true;
        await iterator.return?.().catch(() => undefined);
        controller.error(error instanceof RuntimeArtifactStoreError ? error : new RuntimeArtifactStoreError());
      }
    },
    async cancel() {
      finished = true;
      await iterator.return?.();
    },
  });
}

export class RuntimeArtifactService {
  constructor(
    private readonly input: {
      leaseStore: RuntimeArtifactLeaseStore;
      artifactStore: RuntimeArtifactStore;
    },
  ) {}

  async openForLease(coordinates: RuntimeArtifactLeaseCoordinates): Promise<RuntimeArtifactRead> {
    const artifact = await this.input.leaseStore.getForLease(coordinates);
    if (!artifact) throw new RuntimeArtifactAccessError();
    return {
      digest: artifact.digest,
      bytes: artifact.bytes,
      body: boundedArtifactStream(
        this.input.artifactStore.read(artifact.storageKey, artifact.bytes),
        artifact.bytes,
      ),
    };
  }
}

export function createMemoryRuntimeArtifactStore(): RuntimeArtifactStore {
  const objects = new Map<string, { digest: Sha256Digest; bytes: Uint8Array }>();

  return {
    async write(input) {
      if (!validSize(input.bytes) || (await sha256Digest(input.bytes)) !== input.digest) {
        throw new RuntimeArtifactStoreError();
      }
      const storageKey = `memory://runtime-artifacts/${input.digest.slice('sha256:'.length)}`;
      const prior = objects.get(storageKey);
      if (
        prior &&
        (prior.digest !== input.digest ||
          prior.bytes.byteLength !== input.bytes.byteLength ||
          prior.bytes.some((byte, index) => byte !== input.bytes[index]))
      ) {
        throw new RuntimeArtifactStoreError();
      }
      if (!prior) objects.set(storageKey, { digest: input.digest, bytes: clone(input.bytes) });
      return {
        digest: input.digest,
        bytes: input.bytes.byteLength,
        mediaType: 'application/wasm',
        storageKey,
      };
    },

    async *read(storageKey, maxBytes) {
      const stored = objects.get(storageKey);
      if (!stored || stored.bytes.byteLength > maxBytes) throw new RuntimeArtifactStoreError();
      yield clone(stored.bytes);
    },
  };
}

export function createUnavailableRuntimeArtifactStore(): RuntimeArtifactStore {
  return {
    async write() {
      throw new RuntimeArtifactStoreError();
    },
    async *read() {
      yield* [] as Uint8Array[];
      throw new RuntimeArtifactStoreError();
    },
  };
}
