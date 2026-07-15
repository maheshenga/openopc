import { expect, test } from 'bun:test';
import { runStudioObjectStoreConformance } from '@kortix/studio-runtime/conformance';
import { InMemoryStudioObjectStore } from './object-store';

runStudioObjectStoreConformance(
  'InMemoryStudioObjectStore',
  () => new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: true }),
);

test('InMemoryStudioObjectStore reports failed readiness without blocking direct CRUD', async () => {
  const store = new InMemoryStudioObjectStore({ namespace: 'studio-test', ready: false });

  await expect(store.assertReady()).rejects.toThrow('STUDIO_STORAGE_UNAVAILABLE');
});
