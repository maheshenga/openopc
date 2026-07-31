import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  PUBLIC_BETA_ARCHIVE_LIMITS,
  type PublicBetaArchiveLimits,
  authenticateAndExtractPublicBetaArchive,
} from './public-beta-archive';

type EntryKind = 'file' | 'directory';

interface ZipEntrySpec {
  name: string;
  data?: Uint8Array;
  kind?: EntryKind;
  compressionMethod?: number;
  flags?: number;
  mode?: number;
  declaredCompressedSize?: number;
  declaredUncompressedSize?: number;
  declaredCrc32?: number;
  localName?: string;
  centralExtra?: Uint8Array;
  centralComment?: Uint8Array;
  diskStart?: number;
  compressedData?: Uint8Array;
}

const textEncoder = new TextEncoder();
const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = (value >>> 8) ^ (crcTable[(value ^ byte) & 0xff] ?? 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

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

function u64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64LE(value, 0);
  return result;
}

function zip64Extra(uncompressedSize: bigint, compressedSize: bigint): Uint8Array {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(uncompressedSize, 0);
  data.writeBigUInt64LE(compressedSize, 8);
  return Buffer.concat([u16(0x0001), u16(data.length), data]);
}

function buildZip(entries: readonly ZipEntrySpec[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const kind = entry.kind ?? 'file';
    const source = entry.data ?? (kind === 'directory' ? new Uint8Array() : textEncoder.encode(entry.name));
    const method = entry.compressionMethod ?? 0;
    const compressed =
      entry.compressedData ?? (method === 8 ? deflateRawSync(source) : Buffer.from(source));
    const flags = entry.flags ?? 0x800;
    const localName = textEncoder.encode(entry.localName ?? entry.name);
    const centralName = textEncoder.encode(entry.name);
    const crc = entry.declaredCrc32 ?? crc32(source);
    const localCompressedSize = entry.compressedData
      ? compressed.length
      : compressed.length;
    const localUncompressedSize = source.length;
    const declaredCompressedSize = entry.declaredCompressedSize ?? localCompressedSize;
    const declaredUncompressedSize = entry.declaredUncompressedSize ?? localUncompressedSize;
    const mode = entry.mode ?? (kind === 'directory' ? 0o040755 : 0o100644);
    const externalAttributes = (mode << 16) >>> 0;
    const extra = Buffer.from(entry.centralExtra ?? new Uint8Array());
    const comment = Buffer.from(entry.centralComment ?? new Uint8Array());

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(localCompressedSize),
      u32(localUncompressedSize),
      u16(localName.length),
      u16(0),
      localName,
      compressed,
    ]);
    localParts.push(localHeader);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(flags),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(declaredCompressedSize),
      u32(declaredUncompressedSize),
      u16(centralName.length),
      u16(extra.length),
      u16(comment.length),
      u16(entry.diskStart ?? 0),
      u16(0),
      u32(externalAttributes),
      u32(localOffset),
      centralName,
      extra,
      comment,
    ]);
    centralParts.push(centralHeader);
    localOffset += localHeader.length;
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

function upgradeToZip64Eocd(archive: Uint8Array): Uint8Array {
  const source = Buffer.from(archive);
  const classicOffset = source.length - 22;
  const entryCount = source.readUInt16LE(classicOffset + 10);
  const centralSize = source.readUInt32LE(classicOffset + 12);
  const centralOffset = source.readUInt32LE(classicOffset + 16);
  const body = source.subarray(0, classicOffset);
  const zip64Eocd = Buffer.concat([
    u32(0x06064b50),
    u64(44n),
    u16((3 << 8) | 45),
    u16(45),
    u32(0),
    u32(0),
    u64(BigInt(entryCount)),
    u64(BigInt(entryCount)),
    u64(BigInt(centralSize)),
    u64(BigInt(centralOffset)),
  ]);
  const locator = Buffer.concat([
    u32(0x07064b50),
    u32(0),
    u64(BigInt(classicOffset)),
    u32(1),
  ]);
  const sentinel = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(0xffff),
    u16(0xffff),
    u32(0xffffffff),
    u32(0xffffffff),
    u16(0),
  ]);
  return Buffer.concat([body, zip64Eocd, locator, sentinel]);
}

function withLimits(overrides: Partial<PublicBetaArchiveLimits>): PublicBetaArchiveLimits {
  return { ...PUBLIC_BETA_ARCHIVE_LIMITS, ...overrides };
}

function exists(path: string): Promise<boolean> {
  return fs
    .access(path)
    .then(() => true)
    .catch(() => false);
}

describe('public beta archive authentication and extraction', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openopc-public-beta-archive-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(
    bytes: Uint8Array,
    destinationName = 'extracted',
  ): Promise<{ archivePath: string; destination: string; expectedDigest: `sha256:${string}` }> {
    const archivePath = join(root, `candidate-${Date.now()}-${Math.random()}.zip`);
    const destination = join(root, destinationName);
    await writeFile(archivePath, bytes);
    return { archivePath, destination, expectedDigest: digest(bytes) };
  }

  test('authenticates before extraction and returns only regular extracted files', async () => {
    const bytes = buildZip([
      { name: 'nested/hello.txt', data: textEncoder.encode('hello') },
      { name: 'nested/', kind: 'directory' },
    ]);
    const input = await fixture(bytes);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    });

    expect(result).not.toBe(false);
    if (result === false) throw new Error('EXPECTED_ARCHIVE_EXTRACTION');
    expect(result.digest).toBe(input.expectedDigest);
    expect(result.sizeBytes).toBe(bytes.length);
    expect(result.files).toEqual(['nested/hello.txt']);
    expect(await readFile(join(input.destination, 'nested', 'hello.txt'), 'utf8')).toBe('hello');
  });

  test('does not extract or leave the destination when the archive digest is wrong', async () => {
    const bytes = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
    const input = await fixture(bytes);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: digest(textEncoder.encode('different bytes')),
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('preserves a pre-existing destination instead of deleting it', async () => {
    const bytes = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
    const input = await fixture(bytes);
    await fs.mkdir(input.destination);
    await writeFile(join(input.destination, 'sentinel.txt'), 'keep me');

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await readFile(join(input.destination, 'sentinel.txt'), 'utf8')).toBe('keep me');
  });

  const hostileFixtures: ReadonlyArray<readonly [
    string,
    () => { entries: readonly ZipEntrySpec[]; limits?: PublicBetaArchiveLimits },
  ]> = [
    ['absolute-path', () => ({ entries: [{ name: '/escape.txt' }] })],
    ['dot-dot', () => ({ entries: [{ name: '../escape.txt' }] })],
    ['backslash', () => ({ entries: [{ name: 'nested\\escape.txt' }] })],
    ['drive-prefix', () => ({ entries: [{ name: 'C:/escape.txt' }] })],
    ['ads', () => ({ entries: [{ name: 'safe.txt:stream' }] })],
    ['control-character', () => ({ entries: [{ name: 'safe/\u0001.txt' }] })],
    ['reserved-device-name', () => ({ entries: [{ name: 'CON.txt' }] })],
    [
      'duplicate-name',
      () => ({ entries: [{ name: 'same.txt' }, { name: 'same.txt' }] }),
    ],
    [
      'case-collision',
      () => ({ entries: [{ name: 'Readme.txt' }, { name: 'README.txt' }] }),
    ],
    [
      'file-directory-prefix-collision',
      () => ({ entries: [{ name: 'a' }, { name: 'a/b.txt' }] }),
    ],
    [
      'symlink',
      () => ({ entries: [{ name: 'link', mode: 0o120777, data: textEncoder.encode('target') }] }),
    ],
    ['device', () => ({ entries: [{ name: 'device', mode: 0o020666 }] })],
    [
      'entry-count',
      () => ({
        entries: [{ name: 'one.txt' }, { name: 'two.txt' }],
        limits: withLimits({ maxEntries: 1 }),
      }),
    ],
    [
      'expanded-size',
      () => ({
        entries: [{ name: 'large.txt', data: textEncoder.encode('0123456789') }],
        limits: withLimits({ maxExpandedBytes: 5 }),
      }),
    ],
    [
      'entry-size',
      () => ({
        entries: [{ name: 'large.txt', data: textEncoder.encode('0123456789') }],
        limits: withLimits({ maxEntryBytes: 5 }),
      }),
    ],
    [
      'compression-ratio',
      () => ({
        entries: [
          {
            name: 'bomb.txt',
            data: textEncoder.encode('A'.repeat(8 * 1024)),
            compressionMethod: 8,
          },
        ],
        limits: withLimits({ maxCompressionRatio: 2 }),
      }),
    ],
    ['encrypted', () => ({ entries: [{ name: 'secret.txt', flags: 0x801 }] })],
    ['unsupported-compression', () => ({ entries: [{ name: 'unknown.bin', compressionMethod: 99 }] })],
    [
      'zip64-expanded-size',
      () => ({
        entries: [
          {
            name: 'zip64.bin',
            data: textEncoder.encode('small'),
            declaredCompressedSize: 0xffffffff,
            declaredUncompressedSize: 0xffffffff,
            centralExtra: zip64Extra(11n * 1024n * 1024n * 1024n, 5n),
          },
        ],
        limits: withLimits({ maxEntryBytes: 10 * 1024 * 1024 * 1024 }),
      }),
    ],
    [
      'truncated-central-directory',
      () => {
        const valid = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
        return { entries: [], limits: { ...PUBLIC_BETA_ARCHIVE_LIMITS, maxArchiveBytes: valid.length } };
      },
    ],
  ];

  test.each(hostileFixtures)('rejects hostile ZIP fixture %s', async (name, makeFixture) => {
    const fixtureValue = makeFixture();
    const raw =
      name === 'truncated-central-directory'
        ? buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]).slice(0, -8)
        : buildZip(fixtureValue.entries);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
      limits: fixtureValue.limits,
    });

    expect(result, name).toBe(false);
    expect(await exists(input.destination), name).toBe(false);
  });

  test('removes a destination created by the call when streamed entry bytes are invalid', async () => {
    const bytes = buildZip([
      {
        name: 'broken.txt',
        data: textEncoder.encode('actual'),
        declaredUncompressedSize: 999,
      },
    ]);
    const input = await fixture(bytes);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test.each([0, 8])(
    'rejects a compression method %d entry whose streamed CRC-32 is wrong',
    async (compressionMethod) => {
      const bytes = buildZip([
        {
          name: 'same-length.bin',
          data: textEncoder.encode('authenticated payload'),
          compressionMethod,
          declaredCrc32: 0x12345678,
        },
      ]);
      const input = await fixture(bytes);

      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath: input.archivePath,
        expectedDigest: input.expectedDigest,
        expectedSizeBytes: bytes.length,
        destination: input.destination,
      });

      expect(result).toBe(false);
      expect(await exists(input.destination)).toBe(false);
    },
  );

  test('rejects an EOCD entry count that omits central directory records', async () => {
    const raw = Buffer.from(
      buildZip([
        { name: 'one.txt', data: textEncoder.encode('one') },
        { name: 'two.txt', data: textEncoder.encode('two') },
      ]),
    );
    raw.writeUInt16LE(1, raw.length - 14);
    raw.writeUInt16LE(1, raw.length - 12);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('rejects a central directory record assigned to another disk', async () => {
    const raw = buildZip([{ name: 'other-disk.bin', diskStart: 1 }]);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('rejects an oversized central directory extra field', async () => {
    const extra = Buffer.concat([u16(0xcafe), u16(65_528), Buffer.alloc(65_528)]);
    const raw = buildZip([{ name: 'huge-extra.bin', centralExtra: extra }]);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('rejects an oversized central directory comment', async () => {
    const raw = buildZip([
      {
        name: 'huge-comment.bin',
        centralComment: new Uint8Array(4_097).fill(0x61),
      },
    ]);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('rejects a non-empty archive with a zero central directory size', async () => {
    const raw = Buffer.from(buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]));
    raw.writeUInt32LE(0, raw.length - 10);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('accepts a valid Zip64 end-of-central-directory contract', async () => {
    const raw = upgradeToZip64Eocd(
      buildZip([{ name: 'zip64.txt', data: textEncoder.encode('zip64') }]),
    );
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).not.toBe(false);
    expect(await readFile(join(input.destination, 'zip64.txt'), 'utf8')).toBe('zip64');
  });

  test('rejects a conflicting non-sentinel classic count in a Zip64 archive', async () => {
    const raw = Buffer.from(
      upgradeToZip64Eocd(buildZip([{ name: 'zip64.txt', data: textEncoder.encode('zip64') }])),
    );
    raw.writeUInt16LE(2, raw.length - 14);
    const input = await fixture(raw);

    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: raw.length,
      destination: input.destination,
    });

    expect(result).toBe(false);
    expect(await exists(input.destination)).toBe(false);
  });

  test('closes the archive descriptor on both success and failure', async () => {
    const bytes = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
    const input = await fixture(bytes);
    const result = await authenticateAndExtractPublicBetaArchive({
      archivePath: input.archivePath,
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    });
    expect(result).not.toBe(false);

    const renamed = `${input.archivePath}.renamed`;
    await fs.rename(input.archivePath, renamed);
    expect(await exists(renamed)).toBe(true);
  });

  test('fails closed instead of rejecting when an input getter throws', async () => {
    const bytes = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
    const input = await fixture(bytes);
    const throwingInput = {
      get archivePath(): string {
        throw new Error('INPUT_GETTER_FAILED');
      },
      expectedDigest: input.expectedDigest,
      expectedSizeBytes: bytes.length,
      destination: input.destination,
    } as unknown as Parameters<typeof authenticateAndExtractPublicBetaArchive>[0];

    let result: Awaited<ReturnType<typeof authenticateAndExtractPublicBetaArchive>> | 'rejected';
    try {
      result = await authenticateAndExtractPublicBetaArchive(throwingInput);
    } catch {
      result = 'rejected';
    }

    expect(result).toBe(false);
  });

  test('snapshots changing archive input and limits getters once', async () => {
    const bytes = buildZip([{ name: 'hello.txt', data: textEncoder.encode('hello') }]);
    const input = await fixture(bytes);
    let digestReads = 0;
    const dynamicLimits = { ...PUBLIC_BETA_ARCHIVE_LIMITS };
    let maxEntriesReads = 0;
    Object.defineProperty(dynamicLimits, 'maxEntries', {
      configurable: true,
      get: () => {
        maxEntriesReads += 1;
        return maxEntriesReads === 1 ? PUBLIC_BETA_ARCHIVE_LIMITS.maxEntries : 0;
      },
    });

    const dynamicInput = {
      archivePath: input.archivePath,
      get expectedDigest(): `sha256:${string}` {
        digestReads += 1;
        return digestReads === 1 ? input.expectedDigest : `sha256:${'0'.repeat(64)}`;
      },
      expectedSizeBytes: bytes.length,
      destination: input.destination,
      limits: dynamicLimits,
    };

    const result = await authenticateAndExtractPublicBetaArchive(dynamicInput);

    expect(result).not.toBe(false);
    expect(digestReads).toBe(1);
    expect(maxEntriesReads).toBe(1);
  });
});
