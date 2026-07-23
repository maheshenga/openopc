import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';

export type RuntimeIsolationSnapshot = Readonly<{
  platform: string;
  uid: number | null;
  home: string;
  tmpdir: string;
  appWritable: boolean;
  cpuSeconds: number | null;
  memoryMb: number | null;
}>;

export type RuntimeIsolationAttestor = Readonly<{
  attest(): Promise<boolean>;
}>;

function limitValue(limits: string, label: string): number | null {
  const line = limits.split('\n').find((entry) => entry.startsWith(label));
  if (line === undefined) return null;
  const value = line.slice(label.length).trim().split(/\s+/)[0];
  if (value === undefined || value === 'unlimited' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function appIsWritable(): Promise<boolean> {
  try {
    await access('/app', constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readRuntimeIsolationSnapshot(): Promise<RuntimeIsolationSnapshot> {
  let limits = '';
  try {
    limits = await readFile('/proc/self/limits', 'utf8');
  } catch {
    // A missing procfs is not an attestation; the null values fail closed below.
  }
  const addressSpaceBytes = limitValue(limits, 'Max address space');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return Object.freeze({
    platform: process.platform,
    uid,
    home: process.env.HOME ?? '',
    tmpdir: process.env.TMPDIR ?? '',
    appWritable: await appIsWritable(),
    cpuSeconds: limitValue(limits, 'Max cpu time'),
    memoryMb: addressSpaceBytes === null ? null : addressSpaceBytes / (1024 * 1024),
  });
}

export function isolationSnapshotIsCurrent(
  snapshot: RuntimeIsolationSnapshot,
  expected: { cpuSeconds: number; memoryMb: number },
): boolean {
  return (
    snapshot.platform === 'linux' &&
    snapshot.uid !== null &&
    snapshot.uid !== 0 &&
    snapshot.home === '/tmp/openopc-browser' &&
    snapshot.tmpdir === '/tmp/openopc-browser' &&
    !snapshot.appWritable &&
    snapshot.cpuSeconds !== null &&
    snapshot.cpuSeconds <= expected.cpuSeconds &&
    snapshot.memoryMb !== null &&
    snapshot.memoryMb <= expected.memoryMb
  );
}

export function createRuntimeIsolationAttestor(input: {
  probe?: () => Promise<RuntimeIsolationSnapshot>;
  expectedCpuSeconds: number;
  expectedMemoryMb: number;
}): RuntimeIsolationAttestor {
  const probe = input.probe ?? readRuntimeIsolationSnapshot;
  return Object.freeze({
    async attest() {
      try {
        return isolationSnapshotIsCurrent(await probe(), {
          cpuSeconds: input.expectedCpuSeconds,
          memoryMb: input.expectedMemoryMb,
        });
      } catch {
        return false;
      }
    },
  });
}
