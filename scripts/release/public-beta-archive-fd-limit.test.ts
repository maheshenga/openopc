import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

const realFs = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const realOpenSync = realFs.openSync;
const realCloseSync = realFs.closeSync;
const outputDescriptors = new Set<number>();
const maxLiveOutputDescriptors = 4;

mock.module('node:fs', () => ({
  ...realFs,
  openSync: (...args: Parameters<typeof realOpenSync>) => {
    const flags = Number(args[1]);
    const isOutput = (flags & realFs.constants.O_CREAT) !== 0;
    if (isOutput && outputDescriptors.size >= maxLiveOutputDescriptors) {
      const error = new Error('EMFILE: injected output descriptor budget') as NodeJS.ErrnoException;
      error.code = 'EMFILE';
      throw error;
    }
    const descriptor = realOpenSync(...args);
    if (isOutput) outputDescriptors.add(descriptor);
    return descriptor;
  },
  closeSync: (descriptor: number) => {
    outputDescriptors.delete(descriptor);
    return realCloseSync(descriptor);
  },
}));

const { authenticateAndExtractPublicBetaArchive }: typeof import('./public-beta-archive') =
  await import(
    // @ts-expect-error Bun resolves query-string module specifiers as isolated modules.
    './public-beta-archive?fd-limit'
  );

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value & 0xffff, 0);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0o100644 << 16),
      u32(localOffset),
      name,
    ]);
    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

describe('public beta archive output descriptor budget', () => {
  test('extracts a valid multi-file archive within the retained descriptor budget', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-fd-limit-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const entries = Array.from({ length: 3 }, (_, index) => ({
      name: `files/${index}.txt`,
      data: new TextEncoder().encode(`payload-${index}`),
    }));
    const archive = storedZip(entries);
    realFs.writeFileSync(archivePath, archive);
    outputDescriptors.clear();
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(result).not.toBe(false);
      for (const [index, entry] of entries.entries()) {
        expect(realFs.readFileSync(join(destination, entry.name), 'utf8')).toBe(`payload-${index}`);
      }
      expect(outputDescriptors.size).toBe(0);
    } finally {
      for (const descriptor of outputDescriptors) {
        try {
          realCloseSync(descriptor);
        } catch {
          // The production cleanup may already have closed this descriptor.
        }
      }
      outputDescriptors.clear();
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed and releases prepared descriptors when the budget is exhausted', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-fd-limit-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const entries = Array.from({ length: 12 }, (_, index) => ({
      name: `files/${index}.txt`,
      data: new TextEncoder().encode(`payload-${index}`),
    }));
    const archive = storedZip(entries);
    realFs.writeFileSync(archivePath, archive);
    outputDescriptors.clear();
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(result).toBe(false);
      expect(realFs.existsSync(destination)).toBe(false);
      expect(outputDescriptors.size).toBe(0);
    } finally {
      for (const descriptor of outputDescriptors) {
        try {
          realCloseSync(descriptor);
        } catch {
          // The production cleanup may already have closed this descriptor.
        }
      }
      outputDescriptors.clear();
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
