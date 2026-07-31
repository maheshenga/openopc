import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

const realFs = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const realOpenSync = realFs.openSync;
const realCloseSync = realFs.closeSync;
let archiveDescriptor: number | null = null;
let manualArchiveCloseAttempted = false;

mock.module('node:fs', () => ({
  ...realFs,
  openSync: (...args: Parameters<typeof realOpenSync>) => {
    const descriptor = realOpenSync(...args);
    if (String(args[0]).endsWith('candidate.zip')) archiveDescriptor = descriptor;
    return descriptor;
  },
  closeSync: (descriptor: number) => {
    if (descriptor === archiveDescriptor) {
      manualArchiveCloseAttempted = true;
      throw new Error('ARCHIVE_DESCRIPTOR_OWNED_BY_ZIP_READER');
    }
    return realCloseSync(descriptor);
  },
}));

const { authenticateAndExtractPublicBetaArchive }: typeof import('./public-beta-archive') =
  await import(
    // @ts-expect-error Bun resolves query-string module specifiers as isolated modules.
    './public-beta-archive?fd-ownership'
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

function singleFileZip(name: string, data: Uint8Array): Uint8Array {
  const fileName = new TextEncoder().encode(name);
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
    u16(fileName.length),
    u16(0),
    fileName,
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
    u16(fileName.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0o100644 << 16),
    u32(0),
    fileName,
  ]);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

describe('public beta archive descriptor ownership', () => {
  test('does not synchronously close an archive descriptor owned by the ZIP reader', () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-fd-ownership-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const archive = singleFileZip('hello.txt', new TextEncoder().encode('hello'));
    realFs.writeFileSync(archivePath, archive);
    archiveDescriptor = null;
    manualArchiveCloseAttempted = false;
    try {
      const resultPromise = authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      return resultPromise.then((result) => {
        expect(archiveDescriptor).not.toBeNull();
        expect(manualArchiveCloseAttempted).toBe(false);
        expect(result).not.toBe(false);
        const descriptor = archiveDescriptor;
        if (descriptor === null) throw new Error('EXPECTED_ARCHIVE_DESCRIPTOR');
        let descriptorClosed = false;
        try {
          realFs.fstatSync(descriptor);
        } catch {
          descriptorClosed = true;
        }
        expect(descriptorClosed).toBe(true);
      }).finally(() => {
        if (archiveDescriptor !== null) {
          try {
            realCloseSync(archiveDescriptor);
          } catch {
            // The ZIP reader may still be finishing its asynchronous close.
          }
        }
        realFs.rmSync(root, { recursive: true, force: true });
      });
    } catch (error) {
      realFs.rmSync(root, { recursive: true, force: true });
      throw error;
    }
  });
});
