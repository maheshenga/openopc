import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { type PublicBetaSha256Digest, computePublicBetaSha256 } from './public-beta-canonical-json';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const MAX_SEGMENTS = 32;
const MAX_PATH_BYTES = 1_024;
const STREAM_HASH_BUFFER_BYTES = 1024 * 1024;

export interface PublicBetaFileReference {
  root: string;
  path: string;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
  maxBytes: number;
}

export interface PublicBetaVerifiedBytes {
  bytes: Uint8Array;
  digest: PublicBetaSha256Digest;
  sizeBytes: number;
}

interface PublicBetaFileSnapshot {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  nlink: bigint;
  size: bigint;
  sizeBytes: number;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface PublicBetaReferenceSnapshot {
  root: unknown;
  path: unknown;
  digest: unknown;
  sizeBytes: unknown;
  maxBytes: unknown;
}

interface ValidPublicBetaBoundedReferenceSnapshot extends PublicBetaReferenceSnapshot {
  root: string;
  path: string;
  digest: PublicBetaSha256Digest | undefined;
  sizeBytes: number | undefined;
  maxBytes: number;
}

interface ValidPublicBetaStreamingReferenceSnapshot
  extends ValidPublicBetaBoundedReferenceSnapshot {
  digest: PublicBetaSha256Digest;
}

function snapshotReference(value: unknown): PublicBetaReferenceSnapshot | false {
  try {
    if (typeof value !== 'object' || value === null) return false;
    const reference = value as Record<string, unknown>;
    return {
      root: reference.root,
      path: reference.path,
      digest: reference.digest,
      sizeBytes: reference.sizeBytes,
      maxBytes: reference.maxBytes,
    };
  } catch {
    return false;
  }
}

function validPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    new TextEncoder().encode(value).byteLength > MAX_PATH_BYTES
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => PATH_SEGMENT.test(segment));
}

function validLimits(sizeBytes: unknown, maxBytes: unknown): sizeBytes is number {
  return (
    typeof sizeBytes === 'number' &&
    Number.isSafeInteger(sizeBytes) &&
    sizeBytes >= 0 &&
    typeof maxBytes === 'number' &&
    Number.isSafeInteger(maxBytes) &&
    maxBytes >= sizeBytes &&
    maxBytes <= bufferConstants.MAX_LENGTH &&
    sizeBytes <= bufferConstants.MAX_LENGTH
  );
}

function validBoundedReference(
  reference: PublicBetaReferenceSnapshot,
): reference is ValidPublicBetaBoundedReferenceSnapshot {
  if (
    typeof reference !== 'object' ||
    reference === null ||
    typeof reference.root !== 'string' ||
    !validPath(reference.path) ||
    typeof reference.maxBytes !== 'number' ||
    !Number.isSafeInteger(reference.maxBytes) ||
    reference.maxBytes < 0 ||
    reference.maxBytes > bufferConstants.MAX_LENGTH
  ) {
    return false;
  }
  return (
    (reference.digest === undefined ||
      (typeof reference.digest === 'string' && DIGEST.test(reference.digest))) &&
    (reference.sizeBytes === undefined || validLimits(reference.sizeBytes, reference.maxBytes))
  );
}

function validStreamingReference(
  reference: PublicBetaReferenceSnapshot,
): reference is ValidPublicBetaStreamingReferenceSnapshot {
  return (
    typeof reference === 'object' &&
    reference !== null &&
    typeof reference.root === 'string' &&
    validPath(reference.path) &&
    typeof reference.digest === 'string' &&
    DIGEST.test(reference.digest) &&
    typeof reference.maxBytes === 'number' &&
    Number.isSafeInteger(reference.maxBytes) &&
    reference.maxBytes >= 0 &&
    (reference.sizeBytes === undefined ||
      (typeof reference.sizeBytes === 'number' &&
        Number.isSafeInteger(reference.sizeBytes) &&
        reference.sizeBytes >= 0 &&
        reference.sizeBytes <= reference.maxBytes))
  );
}

function lexicalCandidatePath(root: string, path: string): string | false {
  try {
    const lexicalRoot = resolve(root);
    const realRoot = realpathSync.native(lexicalRoot);
    const rootStat = lstatSync(lexicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;

    let cursor = realRoot;
    const segments = path.split('/');
    for (const [index, segment] of segments.entries()) {
      cursor = resolve(cursor, segment);
      const stat = lstatSync(cursor);
      if (
        stat.isSymbolicLink() ||
        (index === segments.length - 1 && !stat.isFile()) ||
        realpathSync.native(cursor) !== cursor
      ) {
        return false;
      }
    }
    return cursor;
  } catch {
    return false;
  }
}

function fileSnapshot(value: BigIntStats): PublicBetaFileSnapshot | false {
  if (
    !value.isFile() ||
    value.isSymbolicLink() ||
    value.nlink !== 1n ||
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

function descriptorSnapshot(descriptor: number): PublicBetaFileSnapshot | false {
  try {
    return fileSnapshot(fstatSync(descriptor, { bigint: true }));
  } catch {
    return false;
  }
}

function pathSnapshot(path: string): PublicBetaFileSnapshot | false {
  try {
    return fileSnapshot(lstatSync(path, { bigint: true }));
  } catch {
    return false;
  }
}

function sameSnapshot(left: PublicBetaFileSnapshot, right: PublicBetaFileSnapshot): boolean {
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

function descriptorBindsVerifiedPath(
  descriptor: number,
  root: string,
  path: string,
  expectedPath: string,
  expectedSnapshot: PublicBetaFileSnapshot,
): boolean {
  const currentPath = lexicalCandidatePath(root, path);
  if (currentPath === false || currentPath !== expectedPath) return false;
  const opened = descriptorSnapshot(descriptor);
  const current = pathSnapshot(currentPath);
  return (
    opened !== false &&
    current !== false &&
    sameSnapshot(expectedSnapshot, opened) &&
    sameSnapshot(opened, current)
  );
}

function readExact(descriptor: number, sizeBytes: number): Uint8Array | false {
  const bytes = new Uint8Array(sizeBytes);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const bytesRead = readSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    if (bytesRead <= 0) return false;
    offset += bytesRead;
  }
  return bytes;
}

function readBoundedBytes(value: unknown): PublicBetaVerifiedBytes | false {
  const reference = snapshotReference(value);
  if (reference === false) return false;
  if (!validBoundedReference(reference)) return false;
  const candidatePath = lexicalCandidatePath(reference.root, reference.path);
  if (candidatePath === false) return false;

  let descriptor: number | null = null;
  let result: PublicBetaVerifiedBytes | false = false;
  try {
    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW) |
      (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0));
    descriptor = openSync(candidatePath, flags);
    const before = descriptorSnapshot(descriptor);
    if (
      before === false ||
      before.sizeBytes > reference.maxBytes ||
      (reference.sizeBytes !== undefined && before.sizeBytes !== reference.sizeBytes) ||
      !descriptorBindsVerifiedPath(
        descriptor,
        reference.root,
        reference.path,
        candidatePath,
        before,
      )
    ) {
      return false;
    }

    const bytes = readExact(descriptor, before.sizeBytes);
    if (bytes === false) return false;
    const after = descriptorSnapshot(descriptor);
    if (
      after === false ||
      !sameSnapshot(before, after) ||
      !descriptorBindsVerifiedPath(descriptor, reference.root, reference.path, candidatePath, after)
    ) {
      return false;
    }

    const digest = computePublicBetaSha256(bytes);
    if (reference.digest !== undefined && digest !== reference.digest) return false;
    result = { bytes, digest, sizeBytes: before.sizeBytes };
  } catch {
    result = false;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        result = false;
      }
    }
  }
  return result;
}

export function readPublicBetaVerifiedBytes(
  reference: Readonly<PublicBetaFileReference>,
): PublicBetaVerifiedBytes | false {
  try {
    const snapshot = snapshotReference(reference);
    if (
      snapshot === false ||
      !validLimits(snapshot.sizeBytes, snapshot.maxBytes) ||
      typeof snapshot.digest !== 'string' ||
      !DIGEST.test(snapshot.digest)
    ) {
      return false;
    }
    return readBoundedBytes(snapshot);
  } catch {
    return false;
  }
}

export function readPublicBetaBoundedBytes(
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'maxBytes'>>,
): PublicBetaVerifiedBytes | false {
  try {
    return readBoundedBytes(reference);
  } catch {
    return false;
  }
}

/** Verifies a potentially large candidate file without materializing it in memory. */
export function verifyPublicBetaFile(
  reference: Readonly<
    Pick<PublicBetaFileReference, 'root' | 'path' | 'digest' | 'maxBytes'> &
      Partial<Pick<PublicBetaFileReference, 'sizeBytes'>>
  >,
): boolean {
  let descriptor: number | null = null;
  let result = false;
  try {
    const snapshot = snapshotReference(reference);
    if (snapshot === false || !validStreamingReference(snapshot)) return false;
    const candidatePath = lexicalCandidatePath(snapshot.root, snapshot.path);
    if (candidatePath === false) return false;

    const flags =
      constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW) |
      (process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0));
    descriptor = openSync(candidatePath, flags);
    const before = descriptorSnapshot(descriptor);
    if (
      before === false ||
      before.sizeBytes > snapshot.maxBytes ||
      (snapshot.sizeBytes !== undefined && before.sizeBytes !== snapshot.sizeBytes) ||
      !descriptorBindsVerifiedPath(descriptor, snapshot.root, snapshot.path, candidatePath, before)
    ) {
      return false;
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(STREAM_HASH_BUFFER_BYTES);
    let position = 0;
    while (position < before.sizeBytes) {
      const requested = Math.min(buffer.byteLength, before.sizeBytes - position);
      const bytesRead = readSync(descriptor, buffer, 0, requested, position);
      if (bytesRead <= 0) return false;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = descriptorSnapshot(descriptor);
    if (
      after === false ||
      !sameSnapshot(before, after) ||
      !descriptorBindsVerifiedPath(descriptor, snapshot.root, snapshot.path, candidatePath, after)
    ) {
      return false;
    }
    result = `sha256:${hash.digest('hex')}` === snapshot.digest;
  } catch {
    result = false;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        result = false;
      }
    }
  }
  return result;
}

export function readPublicBetaVerifiedJson(
  reference: Readonly<PublicBetaFileReference>,
): { file: PublicBetaVerifiedBytes; value: unknown } | false {
  const file = readPublicBetaVerifiedBytes(reference);
  if (file === false) return false;
  try {
    return {
      file,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)),
    };
  } catch {
    return false;
  }
}

export function readPublicBetaBoundedJson(
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'maxBytes'>>,
): { file: PublicBetaVerifiedBytes; value: unknown } | false {
  const file = readPublicBetaBoundedBytes(reference);
  if (file === false) return false;
  try {
    return {
      file,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)),
    };
  } catch {
    return false;
  }
}
