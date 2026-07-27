import { expect, test } from 'bun:test';

import * as runtimeArtifacts from './runtime-artifacts';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const DIGEST = 'sha256:cd5d4935a48c0672cb06407bb443bc0087aff947c6b864bac886982c73b3027f' as const;

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

test('memory runtime artifact store keeps immutable bytes and bounded reads', async () => {
  const store = runtimeArtifacts.createMemoryRuntimeArtifactStore();
  const bytes = new Uint8Array([0, 97, 115, 109]);

  const stored = await store.write({ accountId: ACCOUNT_ID, digest: DIGEST, bytes });
  bytes[0] = 255;

  expect(stored).toEqual({
    digest: DIGEST,
    bytes: 4,
    mediaType: 'application/wasm',
    storageKey: `memory://runtime-artifacts/${DIGEST.slice('sha256:'.length)}`,
  });
  expect(await collect(store.read(stored.storageKey, 4))).toEqual(
    new Uint8Array([0, 97, 115, 109]),
  );
  await expect(collect(store.read(stored.storageKey, 3))).rejects.toThrow(
    'RUNTIME_ARTIFACT_STORE_UNAVAILABLE',
  );
});

test('lease-bound runtime artifact reads fail closed without a trusted live binding', async () => {
  const RuntimeArtifactService = (
    runtimeArtifacts as typeof runtimeArtifacts & {
      RuntimeArtifactService: new (input: unknown) => {
        openForLease(input: unknown): Promise<unknown>;
      };
    }
  ).RuntimeArtifactService;
  expect(typeof RuntimeArtifactService).toBe('function');
  const service = new RuntimeArtifactService({
    leaseStore: { getForLease: async () => null },
    artifactStore: runtimeArtifacts.createMemoryRuntimeArtifactStore(),
  });

  await expect(
    service.openForLease({
      accountId: ACCOUNT_ID,
      projectId: '20000000-0000-4000-a000-000000000002',
      executionId: '30000000-0000-4000-a000-000000000003',
      leaseId: '40000000-0000-4000-a000-000000000004',
      generation: 2,
      runnerId: '50000000-0000-4000-a000-000000000005',
    }),
  ).rejects.toMatchObject({ code: 'RUNNER_EXECUTION_UNAVAILABLE', status: 409 });
});

test('lease-bound runtime artifact reads enforce the persisted byte length while streaming', async () => {
  const RuntimeArtifactService = (
    runtimeArtifacts as typeof runtimeArtifacts & {
      RuntimeArtifactService: new (input: unknown) => {
        openForLease(input: unknown): Promise<{
          digest: typeof DIGEST;
          bytes: number;
          body: ReadableStream<Uint8Array>;
        }>;
      };
    }
  ).RuntimeArtifactService;
  expect(typeof RuntimeArtifactService).toBe('function');
  const coordinates = {
    accountId: ACCOUNT_ID,
    projectId: '20000000-0000-4000-a000-000000000002',
    executionId: '30000000-0000-4000-a000-000000000003',
    leaseId: '40000000-0000-4000-a000-000000000004',
    generation: 2,
    runnerId: '50000000-0000-4000-a000-000000000005',
  };
  const metadata = {
    runtimeArtifactId: '60000000-0000-4000-a000-000000000006',
    accountId: ACCOUNT_ID,
    releaseId: '70000000-0000-4000-a000-000000000007',
    runtimeDescriptorId: '80000000-0000-4000-a000-000000000008',
    digest: DIGEST,
    bytes: 4,
    mediaType: 'application/wasm' as const,
    storageKey: 'module-runtime/artifacts/private/component.wasm',
  };

  for (const chunks of [
    [new Uint8Array([0, 97, 115])],
    [new Uint8Array([0, 97, 115, 109]), new Uint8Array([1])],
  ]) {
    const service = new RuntimeArtifactService({
      leaseStore: { getForLease: async () => metadata },
      artifactStore: {
        async write() {
          throw new Error('unexpected write');
        },
        async *read() {
          for (const chunk of chunks) yield chunk;
        },
      },
    });
    const opened = await service.openForLease(coordinates);
    expect(opened).not.toHaveProperty('storageKey');
    await expect(
      collect({
        async *[Symbol.asyncIterator]() {
          const reader = opened.body.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
        },
      }),
    ).rejects.toThrow('RUNTIME_ARTIFACT_STORE_UNAVAILABLE');
  }
});
