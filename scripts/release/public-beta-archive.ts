import { createHash } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  closeSync,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Entry, type ZipFile, fromFd } from 'yauzl';

import type { PublicBetaSha256Digest } from './public-beta-canonical-json';
import {
  type PublicBetaNativeDirectory,
  type PublicBetaNativeFile,
  type PublicBetaNativeFilesystem,
  createPublicBetaNativeFilesystem,
} from './public-beta-native-filesystem';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const HASH_BUFFER_BYTES = 1024 * 1024;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;
const ZIP_EOCD_BYTES = 22;
const ZIP_EOCD_MAX_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_MIN_BYTES = 56;
const ZIP_CENTRAL_MAX_EXTRA_BYTES = 16 * 1024;
const ZIP_CENTRAL_MAX_COMMENT_BYTES = 4 * 1024;
const CRC32_TABLE = new Uint32Array(256);

for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
  }
  CRC32_TABLE[index] = value >>> 0;
}

export interface PublicBetaArchiveLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxExpandedBytes: number;
  maxEntryBytes: number;
  maxCompressionRatio: number;
  maxPathBytes: number;
  maxPathSegments: number;
}

export const PUBLIC_BETA_ARCHIVE_LIMITS: Readonly<PublicBetaArchiveLimits> = Object.freeze({
  maxArchiveBytes: 10 * 1024 * 1024 * 1024,
  maxEntries: 4_096,
  maxExpandedBytes: 20 * 1024 * 1024 * 1024,
  maxEntryBytes: 10 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxPathBytes: 1_024,
  maxPathSegments: 32,
});

interface PublicBetaArchiveRequest {
  archivePath: string;
  expectedDigest: PublicBetaSha256Digest;
  expectedSizeBytes: number;
  destination: string;
  limits: Readonly<PublicBetaArchiveLimits>;
}

export interface PublicBetaArchiveExtraction {
  path: string;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  files: readonly string[];
}

interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  sizeBytes: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface InspectedFile {
  entry: Entry;
  path: string;
}

interface PreparedOutput {
  descriptor: number | null;
  relativePath: string;
  path: string;
  initial: FileSnapshot;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mode: bigint;
}

interface PublishedOutput {
  relativePath: string;
  snapshot: FileSnapshot;
}

interface ArchiveInspection {
  entryCount: number;
  directories: string[];
  files: InspectedFile[];
  expandedBytes: number;
}

interface CentralDirectoryContract {
  entryCount: number;
  offset: number;
  size: number;
  eocdOffset: number;
}

interface PathClaim {
  kind: 'directory' | 'file';
  path: string;
  explicit: boolean;
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(value: unknown): Readonly<PublicBetaArchiveLimits> | false {
  try {
    const limits = value ?? PUBLIC_BETA_ARCHIVE_LIMITS;
    if (typeof limits !== 'object' || limits === null) return false;
    const candidate = limits as Partial<PublicBetaArchiveLimits>;
    const snapshot = {
      maxArchiveBytes: candidate.maxArchiveBytes,
      maxEntries: candidate.maxEntries,
      maxExpandedBytes: candidate.maxExpandedBytes,
      maxEntryBytes: candidate.maxEntryBytes,
      maxCompressionRatio: candidate.maxCompressionRatio,
      maxPathBytes: candidate.maxPathBytes,
      maxPathSegments: candidate.maxPathSegments,
    };
    const integerKeys = [
      'maxArchiveBytes',
      'maxEntries',
      'maxExpandedBytes',
      'maxEntryBytes',
      'maxPathBytes',
      'maxPathSegments',
    ] as const;
    for (const key of integerKeys) {
      const candidateValue = snapshot[key];
      if (
        !safePositiveInteger(candidateValue) ||
        candidateValue > PUBLIC_BETA_ARCHIVE_LIMITS[key]
      ) {
        return false;
      }
    }
    if (
      typeof snapshot.maxCompressionRatio !== 'number' ||
      !Number.isFinite(snapshot.maxCompressionRatio) ||
      snapshot.maxCompressionRatio < 1 ||
      snapshot.maxCompressionRatio > PUBLIC_BETA_ARCHIVE_LIMITS.maxCompressionRatio
    ) {
      return false;
    }
    return Object.freeze(snapshot) as Readonly<PublicBetaArchiveLimits>;
  } catch {
    return false;
  }
}

function snapshotRequest(input: unknown): PublicBetaArchiveRequest | false {
  try {
    if (
      (typeof input !== 'object' && typeof input !== 'function') ||
      input === null
    ) {
      return false;
    }
    const candidate = input as {
      archivePath?: unknown;
      expectedDigest?: unknown;
      expectedSizeBytes?: unknown;
      destination?: unknown;
      limits?: unknown;
    };
    const archivePath = candidate.archivePath;
    const expectedDigest = candidate.expectedDigest;
    const expectedSizeBytes = candidate.expectedSizeBytes;
    const destination = candidate.destination;
    const limits = resolveLimits(candidate.limits);
    if (
      limits === false ||
      typeof archivePath !== 'string' ||
      archivePath.length === 0 ||
      typeof destination !== 'string' ||
      destination.length === 0 ||
      typeof expectedDigest !== 'string' ||
      !DIGEST.test(expectedDigest) ||
      typeof expectedSizeBytes !== 'number' ||
      !Number.isSafeInteger(expectedSizeBytes) ||
      expectedSizeBytes < 0 ||
      expectedSizeBytes > limits.maxArchiveBytes
    ) {
      return false;
    }
    return Object.freeze({
      archivePath,
      expectedDigest: expectedDigest as PublicBetaSha256Digest,
      expectedSizeBytes,
      destination,
      limits,
    });
  } catch {
    return false;
  }
}

function fileSnapshot(value: BigIntStats): FileSnapshot | false {
  if (
    !value.isFile() ||
    value.size < 0n ||
    value.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return false;
  }
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    nlink: value.nlink,
    size: value.size,
    sizeBytes: Number(value.size),
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function snapshot(descriptor: number): FileSnapshot | false {
  try {
    return fileSnapshot(fstatSync(descriptor, { bigint: true }));
  } catch {
    return false;
  }
}

function pathSnapshot(path: string): FileSnapshot | false {
  try {
    return fileSnapshot(lstatSync(path, { bigint: true }));
  } catch {
    return false;
  }
}

function directoryIdentity(path: string): DirectoryIdentity | false {
  try {
    const value = lstatSync(path, { bigint: true });
    if (!value.isDirectory() || value.isSymbolicLink()) return false;
    return { dev: value.dev, ino: value.ino, mode: value.mode };
  } catch {
    return false;
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFileIdentity(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function readDescriptorRange(
  descriptor: number,
  position: number,
  size: number,
): Buffer | false {
  if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(size) || size < 0) {
    return false;
  }
  const buffer = Buffer.alloc(size);
  let offset = 0;
  try {
    while (offset < size) {
      const bytesRead = readSync(descriptor, buffer, offset, size - offset, position + offset);
      if (bytesRead <= 0) return false;
      offset += bytesRead;
    }
    return buffer;
  } catch {
    return false;
  }
}

function safeZip64Number(value: bigint): number | false {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return false;
  return Number(value);
}

function countCentralDirectoryRecords(
  descriptor: number,
  offset: number,
  size: number,
  maxEntries: number,
): number | false {
  const end = offset + size;
  if (!Number.isSafeInteger(end) || end < offset) return false;
  let cursor = offset;
  let count = 0;
  while (cursor < end) {
    const header = readDescriptorRange(descriptor, cursor, 46);
    if (header === false || header.readUInt32LE(0) !== 0x02014b50) return false;
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    if (
      header.readUInt16LE(34) !== 0 ||
      extraLength > ZIP_CENTRAL_MAX_EXTRA_BYTES ||
      commentLength > ZIP_CENTRAL_MAX_COMMENT_BYTES
    ) {
      return false;
    }
    const recordSize =
      46 + header.readUInt16LE(28) + extraLength + commentLength;
    if (recordSize < 46 || cursor + recordSize > end) return false;
    cursor += recordSize;
    count += 1;
    if (count > maxEntries) return false;
  }
  return cursor === end ? count : false;
}

function readCentralDirectoryContract(
  descriptor: number,
  archiveSizeBytes: number,
  maxEntries: number,
): CentralDirectoryContract | false {
  const tailSize = Math.min(archiveSizeBytes, ZIP_EOCD_BYTES + ZIP_EOCD_MAX_COMMENT_BYTES);
  const tailStart = archiveSizeBytes - tailSize;
  const tail = readDescriptorRange(descriptor, tailStart, tailSize);
  if (tail === false) return false;

  let eocdOffset = -1;
  let eocd: Buffer | null = null;
  for (let index = tail.length - ZIP_EOCD_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== 0x06054b50) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + ZIP_EOCD_BYTES + commentLength !== tail.length) continue;
    eocdOffset = tailStart + index;
    eocd = tail.subarray(index, index + ZIP_EOCD_BYTES);
    break;
  }
  if (eocd === null || eocdOffset < 0) return false;

  if (eocd.readUInt16LE(4) !== 0 || eocd.readUInt16LE(6) !== 0) return false;
  const entryCountDisk16 = eocd.readUInt16LE(8);
  const entryCount16 = eocd.readUInt16LE(10);
  const size32 = eocd.readUInt32LE(12);
  const offset32 = eocd.readUInt32LE(16);
  const needsZip64 =
    entryCountDisk16 === 0xffff || entryCount16 === 0xffff || size32 === 0xffffffff || offset32 === 0xffffffff;

  let entryCount = entryCount16;
  let centralSize = size32;
  let centralOffset = offset32;
  let expectedCentralEnd = eocdOffset;
  if (needsZip64) {
    if (eocdOffset < ZIP64_LOCATOR_BYTES) return false;
    const locator = readDescriptorRange(
      descriptor,
      eocdOffset - ZIP64_LOCATOR_BYTES,
      ZIP64_LOCATOR_BYTES,
    );
    if (locator === false || locator.readUInt32LE(0) !== 0x07064b50) return false;
    if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) return false;
    const zip64Offset = safeZip64Number(locator.readBigUInt64LE(8));
    if (zip64Offset === false || zip64Offset + ZIP64_EOCD_MIN_BYTES > eocdOffset) return false;
    const zip64 = readDescriptorRange(descriptor, zip64Offset, ZIP64_EOCD_MIN_BYTES);
    if (zip64 === false || zip64.readUInt32LE(0) !== 0x06064b50) return false;
    const zip64RecordSize = safeZip64Number(zip64.readBigUInt64LE(4));
    if (
      zip64RecordSize === false ||
      zip64RecordSize < 44 ||
      zip64Offset + 12 + zip64RecordSize !== eocdOffset - ZIP64_LOCATOR_BYTES
    ) {
      return false;
    }
    if (zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) return false;
    const entryCountDisk = safeZip64Number(zip64.readBigUInt64LE(24));
    const entryCountTotal = safeZip64Number(zip64.readBigUInt64LE(32));
    const centralSizeValue = safeZip64Number(zip64.readBigUInt64LE(40));
    const centralOffsetValue = safeZip64Number(zip64.readBigUInt64LE(48));
    if (
      entryCountDisk === false ||
      entryCountTotal === false ||
      entryCountDisk !== entryCountTotal ||
      centralSizeValue === false ||
      centralOffsetValue === false ||
      (entryCountDisk16 !== 0xffff && entryCountDisk16 !== entryCountDisk) ||
      (entryCount16 !== 0xffff && entryCount16 !== entryCountTotal) ||
      (size32 !== 0xffffffff && size32 !== centralSizeValue) ||
      (offset32 !== 0xffffffff && offset32 !== centralOffsetValue)
    ) {
      return false;
    }
    entryCount = entryCountTotal;
    centralSize = centralSizeValue;
    centralOffset = centralOffsetValue;
    expectedCentralEnd = zip64Offset;
  } else if (entryCountDisk16 !== entryCount16) {
    return false;
  }

  if (
    entryCount < 0 ||
    entryCount > maxEntries ||
    centralSize < 0 ||
    centralOffset < 0 ||
    centralOffset + centralSize !== expectedCentralEnd ||
    centralOffset + centralSize > archiveSizeBytes
  ) {
    return false;
  }
  const actualEntryCount = countCentralDirectoryRecords(
    descriptor,
    centralOffset,
    centralSize,
    maxEntries,
  );
  return actualEntryCount === entryCount
    ? { entryCount, offset: centralOffset, size: centralSize, eocdOffset }
    : false;
}

function pathWithoutLinks(path: string, expected: 'file' | 'directory'): string | false {
  try {
    const absolute = resolve(path);
    const root = parse(absolute).root;
    const segments = relative(root, absolute).split(sep).filter(Boolean);
    let cursor = root;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      const value = lstatSync(cursor);
      if (value.isSymbolicLink()) return false;
    }
    const real = realpathSync.native(absolute);
    const finalValue = lstatSync(real);
    if (finalValue.isSymbolicLink()) return false;
    if (expected === 'file' ? !finalValue.isFile() : !finalValue.isDirectory()) return false;
    return real;
  } catch {
    return false;
  }
}

function directoryPathBindsIdentity(path: string, expected: DirectoryIdentity): boolean {
  const canonical = pathWithoutLinks(path, 'directory');
  if (canonical === false || canonical !== path) return false;
  const current = directoryIdentity(canonical);
  return current !== false && sameDirectoryIdentity(expected, current);
}

function newDestinationPath(path: string): string | false {
  try {
    const absolute = resolve(path);
    const name = basename(absolute);
    if (name.length === 0 || name === '.' || name === '..') return false;
    try {
      lstatSync(absolute);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const parent = pathWithoutLinks(dirname(absolute), 'directory');
    if (parent === false) return false;
    const destination = resolve(parent, name);
    return dirname(destination) === parent ? destination : false;
  } catch {
    return false;
  }
}

function hashDescriptor(
  descriptor: number,
  sizeBytes: number,
): PublicBetaSha256Digest | false {
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < sizeBytes) {
      const requested = Math.min(buffer.byteLength, sizeBytes - position);
      const bytesRead = readSync(descriptor, buffer, 0, requested, position);
      if (bytesRead <= 0) return false;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest('hex')}`;
  } catch {
    return false;
  }
}

function openZipFile(descriptor: number): Promise<ZipFile | false> {
  return new Promise((resolvePromise) => {
    try {
      fromFd(
        descriptor,
        {
          autoClose: false,
          lazyEntries: true,
          decodeStrings: true,
          validateEntrySizes: true,
          strictFileNames: true,
        },
        (error, zipFile) => resolvePromise(error || !zipFile ? false : zipFile),
      );
    } catch {
      resolvePromise(false);
    }
  });
}

function archiveEntryKind(entry: Entry): 'directory' | 'file' | false {
  const pathSaysDirectory = entry.fileName.endsWith('/');
  const host = entry.versionMadeBy >>> 8;
  const unixMode = entry.externalFileAttributes >>> 16;
  if (host === 3 || unixMode !== 0) {
    const fileType = unixMode & UNIX_FILE_TYPE;
    if (fileType === UNIX_REGULAR_FILE && !pathSaysDirectory) return 'file';
    if (fileType === UNIX_DIRECTORY && pathSaysDirectory) return 'directory';
    return false;
  }

  const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0;
  if (dosDirectory !== pathSaysDirectory) return false;
  return pathSaysDirectory ? 'directory' : 'file';
}

function normalizedEntryPath(
  rawPath: string,
  kind: 'directory' | 'file',
  limits: Readonly<PublicBetaArchiveLimits>,
): string | false {
  if (
    typeof rawPath !== 'string' ||
    rawPath.length === 0 ||
    rawPath.includes('\\') ||
    rawPath.includes(':') ||
    rawPath.startsWith('/') ||
    rawPath.startsWith('\\') ||
    new TextEncoder().encode(rawPath).byteLength > limits.maxPathBytes
  ) {
    return false;
  }
  const directorySuffix = rawPath.endsWith('/');
  if (directorySuffix !== (kind === 'directory')) return false;
  const candidate = directorySuffix ? rawPath.slice(0, -1) : rawPath;
  const segments = candidate.split('/');
  if (
    candidate.length === 0 ||
    segments.length > limits.maxPathSegments ||
    segments.some(
      (segment) =>
        !PATH_SEGMENT.test(segment) ||
        segment.endsWith('.') ||
        WINDOWS_DEVICE.test(segment),
    )
  ) {
    return false;
  }
  return segments.join('/');
}

function registerPath(
  claims: Map<string, PathClaim>,
  path: string,
  kind: 'directory' | 'file',
): boolean {
  const segments = path.split('/');
  for (let length = 1; length < segments.length; length += 1) {
    const ancestor = segments.slice(0, length).join('/');
    const key = ancestor.toLowerCase();
    const existing = claims.get(key);
    if (existing) {
      if (existing.path !== ancestor || existing.kind !== 'directory') return false;
    } else {
      claims.set(key, { path: ancestor, kind: 'directory', explicit: false });
    }
  }

  const key = path.toLowerCase();
  const existing = claims.get(key);
  if (!existing) {
    claims.set(key, { path, kind, explicit: true });
    return true;
  }
  if (
    existing.path !== path ||
    existing.kind !== 'directory' ||
    kind !== 'directory' ||
    existing.explicit
  ) {
    return false;
  }
  existing.explicit = true;
  return true;
}

function validEntryMetadata(
  entry: Entry,
  archiveSizeBytes: number,
  limits: Readonly<PublicBetaArchiveLimits>,
): boolean {
  if (
    entry.isEncrypted() ||
    (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
    !Number.isSafeInteger(entry.compressedSize) ||
    !Number.isSafeInteger(entry.uncompressedSize) ||
    !Number.isSafeInteger(entry.relativeOffsetOfLocalHeader) ||
    entry.compressedSize < 0 ||
    entry.uncompressedSize < 0 ||
    entry.relativeOffsetOfLocalHeader < 0 ||
    entry.compressedSize > archiveSizeBytes ||
    entry.relativeOffsetOfLocalHeader >= archiveSizeBytes ||
    entry.uncompressedSize > limits.maxEntryBytes ||
    entry.fileNameLength > limits.maxPathBytes
  ) {
    return false;
  }
  if (entry.uncompressedSize === 0) return true;
  return (
    entry.compressedSize > 0 &&
    entry.uncompressedSize / entry.compressedSize <= limits.maxCompressionRatio
  );
}

function inspectArchive(
  zipFile: ZipFile,
  archiveSizeBytes: number,
  limits: Readonly<PublicBetaArchiveLimits>,
): Promise<ArchiveInspection | false> {
  return new Promise((resolvePromise) => {
    if (
      !Number.isSafeInteger(zipFile.entryCount) ||
      zipFile.entryCount < 0 ||
      zipFile.entryCount > limits.maxEntries
    ) {
      resolvePromise(false);
      return;
    }

    const claims = new Map<string, PathClaim>();
    const files: InspectedFile[] = [];
    let expandedBytes = 0;
    let entriesRead = 0;
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      resolvePromise(false);
    };

    zipFile.once('error', fail);
    zipFile.on('entry', (entry: Entry) => {
      if (settled) return;
      entriesRead += 1;
      const kind = archiveEntryKind(entry);
      const path = kind === false ? false : normalizedEntryPath(entry.fileName, kind, limits);
      if (
        kind === false ||
        path === false ||
        !validEntryMetadata(entry, archiveSizeBytes, limits) ||
        entry.uncompressedSize > limits.maxExpandedBytes - expandedBytes ||
        (kind === 'directory' &&
          (entry.compressedSize !== 0 ||
            entry.uncompressedSize !== 0 ||
            entry.compressionMethod !== 0)) ||
        !registerPath(claims, path, kind)
      ) {
        fail();
        return;
      }
      expandedBytes += entry.uncompressedSize;
      if (kind === 'file') files.push({ entry, path });
      zipFile.readEntry();
    });
    zipFile.once('end', () => {
      if (settled) return;
      if (entriesRead !== zipFile.entryCount) {
        fail();
        return;
      }
      settled = true;
      const directories = [...claims.values()]
        .filter((claim) => claim.kind === 'directory')
        .map((claim) => claim.path)
        .sort((left, right) => {
          const depthDifference = left.split('/').length - right.split('/').length;
          if (depthDifference !== 0) return depthDifference;
          return left < right ? -1 : left > right ? 1 : 0;
        });
      resolvePromise({ entryCount: entriesRead, directories, files, expandedBytes });
    });
    zipFile.readEntry();
  });
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable | false> {
  return new Promise((resolvePromise) => {
    try {
      zipFile.openReadStream(entry, (error, stream) => {
        resolvePromise(error || !stream ? false : stream);
      });
    } catch {
      resolvePromise(false);
    }
  });
}

function closeZipFile(zipFile: ZipFile): Promise<boolean> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    zipFile.once('close', () => settle(true));
    zipFile.once('error', () => settle(false));
    try {
      if (zipFile.isOpen) {
        zipFile.close();
      } else {
        setImmediate(() => settle(true));
      }
    } catch {
      settle(false);
    }
  });
}

function preparedOutputBindsPath(output: PreparedOutput, expectedSize: number): boolean {
  if (output.descriptor === null) return false;
  const currentPath = pathWithoutLinks(output.path, 'file');
  if (currentPath === false || currentPath !== output.path) return false;
  const opened = snapshot(output.descriptor);
  const current = pathSnapshot(currentPath);
  return (
    opened !== false &&
    current !== false &&
    opened.nlink === 1n &&
    opened.sizeBytes === expectedSize &&
    sameFileIdentity(output.initial, opened) &&
    sameSnapshot(opened, current)
  );
}

function prepareOutputFiles(
  files: readonly InspectedFile[],
  stagingPath: string,
  stagingIdentity: DirectoryIdentity,
): PreparedOutput[] | false {
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const prepared: PreparedOutput[] = [];
  let completed = false;
  try {
    for (const file of files) {
      if (!directoryPathBindsIdentity(stagingPath, stagingIdentity)) return false;
      const outputPath = resolve(stagingPath, ...file.path.split('/'));
      if (!outputPath.startsWith(`${stagingPath}${sep}`)) return false;
      const parentPath = dirname(outputPath);
      mkdirSync(parentPath, { recursive: true, mode: 0o700 });
      if (
        pathWithoutLinks(parentPath, 'directory') !== parentPath ||
        !directoryPathBindsIdentity(stagingPath, stagingIdentity)
      ) {
        return false;
      }

      const descriptor = openSync(outputPath, flags, 0o600);
      const initial = snapshot(descriptor);
      if (initial === false) {
        try {
          closeSync(descriptor);
        } catch {
          // The operation already fails closed; outer cleanup remains identity-bound.
        }
        return false;
      }
      const candidate = {
        descriptor,
        relativePath: file.path,
        path: outputPath,
        initial,
      } satisfies PreparedOutput;
      prepared.push(candidate);
      if (
        initial.nlink !== 1n ||
        initial.size !== 0n ||
        !preparedOutputBindsPath(candidate, 0)
      ) {
        return false;
      }
    }

    if (
      !directoryPathBindsIdentity(stagingPath, stagingIdentity) ||
      prepared.some((output) => !preparedOutputBindsPath(output, 0))
    ) {
      return false;
    }
    completed = true;
    return prepared;
  } catch {
    return false;
  } finally {
    if (!completed) closePreparedOutputs(prepared);
  }
}

function closePreparedOutput(output: PreparedOutput): boolean {
  if (output.descriptor === null) return true;
  const descriptor = output.descriptor;
  output.descriptor = null;
  try {
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function closePreparedOutputs(outputs: readonly PreparedOutput[]): boolean {
  let result = true;
  for (const output of outputs) {
    if (!closePreparedOutput(output)) result = false;
  }
  return result;
}

function publishedOutputBindsPath(output: PublishedOutput, destination: string): boolean {
  const path = resolve(destination, output.relativePath);
  if (!path.startsWith(`${destination}${sep}`)) return false;
  const current = pathSnapshot(path);
  return current !== false && sameSnapshot(output.snapshot, current);
}

function stagePathFromNativeDirectory(
  filesystem: PublicBetaNativeFilesystem,
  directory: PublicBetaNativeDirectory,
): string | false {
  const anchor = filesystem.childPath(directory, 'anchor.tmp');
  return anchor === false ? false : dirname(anchor);
}

function exactStageMembership(
  stagingPath: string,
  stagingIdentity: DirectoryIdentity,
  inspection: Readonly<ArchiveInspection>,
  outputs: readonly PublishedOutput[],
): boolean {
  if (!directoryPathBindsIdentity(stagingPath, stagingIdentity)) return false;
  const expectedDirectories = new Set(inspection.directories);
  const expectedFiles = new Set(inspection.files.map((file) => file.path));
  const actualDirectories = new Set<string>();
  const actualFiles = new Set<string>();
  const visit = (absolute: string, relativePath: string): boolean => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const childAbsolutePath = resolve(absolute, entry.name);
      if (!childAbsolutePath.startsWith(`${stagingPath}${sep}`)) return false;
      if (entry.isDirectory()) {
        if (pathWithoutLinks(childAbsolutePath, 'directory') !== childAbsolutePath) return false;
        actualDirectories.add(childRelativePath);
        if (!visit(childAbsolutePath, childRelativePath)) return false;
      } else if (entry.isFile()) {
        if (pathWithoutLinks(childAbsolutePath, 'file') !== childAbsolutePath) return false;
        actualFiles.add(childRelativePath);
      } else {
        return false;
      }
    }
    return true;
  };
  if (!visit(stagingPath, '')) return false;
  if (actualDirectories.size !== expectedDirectories.size || actualFiles.size !== expectedFiles.size) return false;
  for (const directory of actualDirectories) if (!expectedDirectories.has(directory)) return false;
  for (const file of actualFiles) if (!expectedFiles.has(file)) return false;
  return outputs.every((output) => publishedOutputBindsPath(output, stagingPath));
}

function snapshotPreparedOutputs(
  outputs: readonly PreparedOutput[],
  files: readonly InspectedFile[],
): PublishedOutput[] | false {
  if (outputs.length !== files.length) return false;
  const completed: PublishedOutput[] = [];
  for (const [index, output] of outputs.entries()) {
    const file = files[index];
    if (
      file === undefined ||
      output.relativePath !== file.path ||
      output.descriptor === null ||
      !preparedOutputBindsPath(output, file.entry.uncompressedSize)
    ) {
      return false;
    }
    const current = snapshot(output.descriptor);
    if (current === false) return false;
    completed.push({ relativePath: output.relativePath, snapshot: current });
  }
  return completed;
}

async function extractFile(
  zipFile: ZipFile,
  file: InspectedFile,
  descriptor: number,
  streamed: { bytes: number },
  limits: Readonly<PublicBetaArchiveLimits>,
): Promise<boolean> {
  const before = snapshot(descriptor);
  if (before === false || before.nlink !== 1n || before.size !== 0n) return false;
  const input = await openEntryStream(zipFile, file.entry);
  if (input === false) return false;

  let entryBytes = 0;
  let entryCrc32 = 0xffffffff;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      entryBytes += chunk.byteLength;
      streamed.bytes += chunk.byteLength;
      for (const byte of chunk) {
        entryCrc32 = (entryCrc32 >>> 8) ^ (CRC32_TABLE[(entryCrc32 ^ byte) & 0xff] ?? 0);
      }
      if (
        entryBytes > file.entry.uncompressedSize ||
        entryBytes > limits.maxEntryBytes ||
        streamed.bytes > limits.maxExpandedBytes
      ) {
        callback(new Error('PUBLIC_BETA_ARCHIVE_LIMIT_EXCEEDED'));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    const outputStream = createWriteStream('', {
      fd: descriptor,
      autoClose: false,
    });
    await pipeline(input, counter, outputStream);
    const completed = snapshot(descriptor);
    return (
      entryBytes === file.entry.uncompressedSize &&
      ((entryCrc32 ^ 0xffffffff) >>> 0) === file.entry.crc32 &&
      completed !== false &&
      completed.nlink === 1n &&
      completed.sizeBytes === entryBytes &&
      sameFileIdentity(before, completed)
    );
  } catch {
    return false;
  }
}

export async function authenticateAndExtractPublicBetaArchive(input: {
  archivePath: string;
  expectedDigest: PublicBetaSha256Digest;
  expectedSizeBytes: number;
  destination: string;
  limits?: Readonly<PublicBetaArchiveLimits>;
}): Promise<PublicBetaArchiveExtraction | false> {
  const request = snapshotRequest(input);
  if (request === false) return false;
  const { archivePath: requestedArchivePath, destination: requestedDestination, limits } = request;

  const archivePath = pathWithoutLinks(requestedArchivePath, 'file');
  const destination = newDestinationPath(requestedDestination);
  if (archivePath === false || destination === false || archivePath === destination) return false;
  const destinationParent = dirname(destination);
  const destinationName = basename(destination);
  const filesystem = createPublicBetaNativeFilesystem();

  let descriptor: number | null = null;
  let zipFile: ZipFile | null = null;
  let descriptorOwnedByZipFile = false;
  let preparedOutputs: PreparedOutput[] = [];
  let destinationNative: PublicBetaNativeDirectory | false = false;
  let stagingNative: PublicBetaNativeDirectory | false = false;
  let retainedCleanupFiles: PublicBetaNativeFile[] = [];
  let stagingCleanupNames: readonly string[] = [];
  let result: PublicBetaArchiveExtraction | false = false;
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    descriptor = openSync(archivePath, flags);
    const before = snapshot(descriptor);
    if (
      before === false ||
      before.sizeBytes !== request.expectedSizeBytes ||
      before.sizeBytes > limits.maxArchiveBytes
    ) {
      return false;
    }

    const computedDigest = hashDescriptor(descriptor, before.sizeBytes);
    const afterHash = snapshot(descriptor);
    if (
      computedDigest === false ||
      computedDigest !== request.expectedDigest ||
      afterHash === false ||
      !sameSnapshot(before, afterHash)
    ) {
      return false;
    }

    const centralDirectory = readCentralDirectoryContract(
      descriptor,
      before.sizeBytes,
      limits.maxEntries,
    );
    if (centralDirectory === false) return false;

    const openedZipFile = await openZipFile(descriptor);
    if (openedZipFile === false) return false;
    zipFile = openedZipFile;
    descriptorOwnedByZipFile = true;
    const inspection = await inspectArchive(zipFile, before.sizeBytes, limits);
    const afterInspection = snapshot(descriptor);
    if (
      inspection === false ||
      inspection.entryCount !== centralDirectory.entryCount ||
      afterInspection === false ||
      !sameSnapshot(before, afterInspection)
    ) {
      return false;
    }

    destinationNative = filesystem.openDirectory(destinationParent);
    if (!destinationNative) return false;
    stagingNative = filesystem.createPrivateDirectory(destinationNative, 'archive-stage-');
    if (!stagingNative) return false;
    const stagingPath = stagePathFromNativeDirectory(filesystem, stagingNative);
    if (stagingPath === false || dirname(stagingPath) !== destinationParent || pathWithoutLinks(stagingPath, 'directory') !== stagingPath) return false;
    const stagingIdentity = directoryIdentity(stagingPath);
    if (stagingIdentity === false) return false;
    for (const directory of inspection.directories) {
      if (!directoryPathBindsIdentity(stagingPath, stagingIdentity)) return false;
      mkdirSync(resolve(stagingPath, ...directory.split('/')), { mode: 0o700 });
      if (!directoryPathBindsIdentity(stagingPath, stagingIdentity)) return false;
    }

    const streamed = { bytes: 0 };
    const prepared = prepareOutputFiles(inspection.files, stagingPath, stagingIdentity);
    if (prepared === false) return false;
    preparedOutputs = prepared;
    if (
      !directoryPathBindsIdentity(stagingPath, stagingIdentity) ||
      preparedOutputs.some((output) => !preparedOutputBindsPath(output, 0))
    ) {
      return false;
    }
    for (const [index, file] of inspection.files.entries()) {
      const descriptor = preparedOutputs[index]?.descriptor;
      if (descriptor === null || descriptor === undefined) return false;
      if (!(await extractFile(zipFile, file, descriptor, streamed, limits))) return false;
    }
    const afterExtraction = snapshot(descriptor);
    if (
      streamed.bytes !== inspection.expandedBytes ||
      afterExtraction === false ||
      !sameSnapshot(before, afterExtraction)
    ) {
      return false;
    }
    const publishedOutputs = snapshotPreparedOutputs(preparedOutputs, inspection.files);
    if (publishedOutputs === false || !closePreparedOutputs(preparedOutputs)) return false;
    const candidateCleanupNames = inspection.files.every((file) => !file.path.includes('/'))
      ? inspection.files.map((file) => file.path)
      : [];
    for (const name of candidateCleanupNames) {
      const retained = filesystem.retainExistingRegularFile(stagingNative, name);
      if (retained === false) return false;
      retainedCleanupFiles.push(retained);
      if (!filesystem.closeFile(retained)) return false;
      retainedCleanupFiles = retainedCleanupFiles.filter((file) => file !== retained);
    }
    if (
      candidateCleanupNames.length > 0 &&
      !filesystem.exactRegularFiles(stagingNative, candidateCleanupNames)
    ) {
      return false;
    }
    if (
      !exactStageMembership(stagingPath, stagingIdentity, inspection, publishedOutputs)
    ) {
      return false;
    }
    stagingCleanupNames = candidateCleanupNames;
    if (newDestinationPath(destination) !== destination) return false;
    if (
      !filesystem.publishNoReplace(
        stagingNative,
        destinationNative,
        destinationName,
        () =>
          (candidateCleanupNames.length === 0 ||
            filesystem.exactRegularFiles(stagingNative, candidateCleanupNames)) &&
          exactStageMembership(stagingPath, stagingIdentity, inspection, publishedOutputs),
      )
    ) {
      return false;
    }
    if (
      !directoryPathBindsIdentity(destination, stagingIdentity) ||
      publishedOutputs.some((output) => !publishedOutputBindsPath(output, destination))
    ) {
      return false;
    }

    result = Object.freeze({
      path: archivePath,
      digest: computedDigest,
      sizeBytes: before.sizeBytes,
      files: Object.freeze(inspection.files.map((file) => file.path)),
    });
  } catch {
    result = false;
  } finally {
    for (const retained of retainedCleanupFiles) {
      if (!filesystem.closeFile(retained)) result = false;
    }
    retainedCleanupFiles = [];
    if (!closePreparedOutputs(preparedOutputs)) result = false;
    if (zipFile !== null && !(await closeZipFile(zipFile))) {
      result = false;
    }
    if (descriptor !== null && !descriptorOwnedByZipFile) {
      try {
        closeSync(descriptor);
      } catch {
        result = false;
      }
    }
    if (
      result === false &&
      stagingNative !== false
    ) {
      filesystem.disposeUnpublished(stagingNative, stagingCleanupNames);
    }
    if (stagingNative !== false) filesystem.closeDirectory(stagingNative);
    if (destinationNative !== false) filesystem.closeDirectory(destinationNative);
  }
  return result;
}
