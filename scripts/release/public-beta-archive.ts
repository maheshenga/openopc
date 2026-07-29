import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Entry, type ZipFile, fromFd } from 'yauzl';

import type { PublicBetaSha256Digest } from './public-beta-canonical-json';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const HASH_BUFFER_BYTES = 1024 * 1024;
const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const UNIX_DIRECTORY = 0o040000;

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

export interface PublicBetaArchiveExtraction {
  path: string;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  files: readonly string[];
}

interface FileSnapshot {
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface InspectedFile {
  entry: Entry;
  path: string;
}

interface ArchiveInspection {
  directories: string[];
  files: InspectedFile[];
  expandedBytes: number;
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
  const limits = value ?? PUBLIC_BETA_ARCHIVE_LIMITS;
  if (typeof limits !== 'object' || limits === null) return false;
  const candidate = limits as Partial<PublicBetaArchiveLimits>;
  const integerKeys = [
    'maxArchiveBytes',
    'maxEntries',
    'maxExpandedBytes',
    'maxEntryBytes',
    'maxPathBytes',
    'maxPathSegments',
  ] as const;
  for (const key of integerKeys) {
    const candidateValue = candidate[key];
    if (
      !safePositiveInteger(candidateValue) ||
      candidateValue > PUBLIC_BETA_ARCHIVE_LIMITS[key]
    ) {
      return false;
    }
  }
  if (
    typeof candidate.maxCompressionRatio !== 'number' ||
    !Number.isFinite(candidate.maxCompressionRatio) ||
    candidate.maxCompressionRatio < 1 ||
    candidate.maxCompressionRatio > PUBLIC_BETA_ARCHIVE_LIMITS.maxCompressionRatio
  ) {
    return false;
  }
  return candidate as PublicBetaArchiveLimits;
}

function snapshot(descriptor: number): FileSnapshot | false {
  try {
    const value = fstatSync(descriptor);
    if (!value.isFile() || !Number.isSafeInteger(value.size) || value.size < 0) return false;
    return {
      dev: value.dev,
      ino: value.ino,
      mode: value.mode,
      nlink: value.nlink,
      size: value.size,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
    };
  } catch {
    return false;
  }
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
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
      zipFile.close();
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
      zipFile.close();
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
      resolvePromise({ directories, files, expandedBytes });
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

async function extractFile(
  zipFile: ZipFile,
  file: InspectedFile,
  destination: string,
  streamed: { bytes: number },
  limits: Readonly<PublicBetaArchiveLimits>,
): Promise<boolean> {
  const input = await openEntryStream(zipFile, file.entry);
  if (input === false) return false;
  const outputPath = resolve(destination, ...file.path.split('/'));
  if (!outputPath.startsWith(`${destination}${sep}`)) return false;

  let entryBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      entryBytes += chunk.byteLength;
      streamed.bytes += chunk.byteLength;
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
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
  const output = createWriteStream(outputPath, { flags, mode: 0o600 });
  try {
    await pipeline(input, counter, output);
    const value = lstatSync(outputPath);
    return !value.isSymbolicLink() && value.isFile() && value.size === entryBytes && entryBytes === file.entry.uncompressedSize;
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
  const limits = resolveLimits(input?.limits);
  if (
    limits === false ||
    typeof input?.archivePath !== 'string' ||
    input.archivePath.length === 0 ||
    typeof input.destination !== 'string' ||
    input.destination.length === 0 ||
    typeof input.expectedDigest !== 'string' ||
    !DIGEST.test(input.expectedDigest) ||
    !Number.isSafeInteger(input.expectedSizeBytes) ||
    input.expectedSizeBytes < 0 ||
    input.expectedSizeBytes > limits.maxArchiveBytes
  ) {
    return false;
  }

  const archivePath = pathWithoutLinks(input.archivePath, 'file');
  const destination = newDestinationPath(input.destination);
  if (archivePath === false || destination === false || archivePath === destination) return false;

  let descriptor: number | null = null;
  let zipFile: ZipFile | null = null;
  let destinationCreated = false;
  let result: PublicBetaArchiveExtraction | false = false;
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    descriptor = openSync(archivePath, flags);
    const before = snapshot(descriptor);
    if (
      before === false ||
      before.size !== input.expectedSizeBytes ||
      before.size > limits.maxArchiveBytes
    ) {
      return false;
    }

    const computedDigest = hashDescriptor(descriptor, before.size);
    const afterHash = snapshot(descriptor);
    if (
      computedDigest === false ||
      computedDigest !== input.expectedDigest ||
      afterHash === false ||
      !sameSnapshot(before, afterHash)
    ) {
      return false;
    }

    zipFile = await openZipFile(descriptor);
    if (zipFile === false) {
      zipFile = null;
      return false;
    }
    const inspection = await inspectArchive(zipFile, before.size, limits);
    const afterInspection = snapshot(descriptor);
    if (
      inspection === false ||
      afterInspection === false ||
      !sameSnapshot(before, afterInspection)
    ) {
      return false;
    }

    mkdirSync(destination, { mode: 0o700 });
    destinationCreated = true;
    for (const directory of inspection.directories) {
      mkdirSync(resolve(destination, ...directory.split('/')), { mode: 0o700 });
    }

    const streamed = { bytes: 0 };
    for (const file of inspection.files) {
      if (!(await extractFile(zipFile, file, destination, streamed, limits))) return false;
    }
    const afterExtraction = snapshot(descriptor);
    if (
      streamed.bytes !== inspection.expandedBytes ||
      afterExtraction === false ||
      !sameSnapshot(before, afterExtraction)
    ) {
      return false;
    }

    result = Object.freeze({
      path: archivePath,
      digest: computedDigest,
      sizeBytes: before.size,
      files: Object.freeze(inspection.files.map((file) => file.path)),
    });
  } catch {
    result = false;
  } finally {
    if (zipFile?.isOpen) {
      try {
        zipFile.close();
      } catch {
        result = false;
      }
    }
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        result = false;
      }
    }
    if (result === false && destinationCreated) {
      try {
        rmSync(destination, { recursive: true, force: true });
      } catch {
        // The caller still receives a fail-closed result; cleanup was limited to our destination.
      }
    }
  }
  return result;
}
