import { describe, expect, test } from 'bun:test';
import { InMemoryStudioObjectStore } from './object-store';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    chunks.push(next.value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

describe('Studio object store port', () => {
  test('streams objects and exposes signed URLs through a readiness-checked driver', async () => {
    const store = new InMemoryStudioObjectStore({ ready: true });
    const body = new Uint8Array([1, 2, 3, 4]);

    await expect(store.assertReady()).resolves.toBeUndefined();
    await store.putObject({
      bucket: 'studio-assets',
      key: 'projects/p/assets/a.bin',
      body: new Blob([body]).stream(),
      content_type: 'application/octet-stream',
      size_bytes: body.byteLength,
    });

    const object = await store.getObject({ bucket: 'studio-assets', key: 'projects/p/assets/a.bin' });
    expect(await readAll(object.body)).toEqual(body);
    expect(object.size_bytes).toBe(4);
    expect(
      await store.createSignedDownloadUrl({
        bucket: 'studio-assets',
        key: 'projects/p/assets/a.bin',
        expires_in_seconds: 60,
      }),
    ).toBe('memory://studio-assets/projects/p/assets/a.bin?ttl=60');

    const blocked = new InMemoryStudioObjectStore({ ready: false });
    await expect(blocked.assertReady()).rejects.toThrow('STUDIO_STORAGE_UNAVAILABLE');
  });
});
