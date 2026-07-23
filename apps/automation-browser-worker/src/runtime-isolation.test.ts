import { describe, expect, test } from 'bun:test';
import {
  createRuntimeIsolationAttestor,
  isolationSnapshotIsCurrent,
  type RuntimeIsolationSnapshot,
} from './runtime-isolation';

function isolationProbe(
  overrides: Partial<RuntimeIsolationSnapshot> = {},
): () => Promise<RuntimeIsolationSnapshot> {
  return async () => ({
    platform: 'linux',
    uid: 1000,
    home: '/tmp/openopc-browser',
    tmpdir: '/tmp/openopc-browser',
    appWritable: false,
    cpuSeconds: 120,
    memoryMb: 512,
    ...overrides,
  });
}

describe('runtime isolation attestation', () => {
  test('accepts a Linux non-root runtime with bounded resources and the dedicated temp root', async () => {
    const snapshot = await isolationProbe()();
    expect(isolationSnapshotIsCurrent(snapshot, { cpuSeconds: 120, memoryMb: 512 })).toBeTrue();
    await expect(
      createRuntimeIsolationAttestor({
        probe: isolationProbe(),
        expectedCpuSeconds: 120,
        expectedMemoryMb: 512,
      }).attest(),
    ).resolves.toBeTrue();
  });

  test('fails closed for root, writable app code, missing limits, or a different temporary root', async () => {
    for (const snapshot of [
      { uid: 0 },
      { appWritable: true },
      { cpuSeconds: null },
      { memoryMb: null },
      { tmpdir: '/tmp' },
    ] satisfies Array<Partial<RuntimeIsolationSnapshot>>) {
      await expect(
        createRuntimeIsolationAttestor({
          probe: isolationProbe(snapshot),
          expectedCpuSeconds: 120,
          expectedMemoryMb: 512,
        }).attest(),
      ).resolves.toBeFalse();
    }
  });
});
