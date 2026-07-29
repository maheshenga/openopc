import { constants as bufferConstants } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import {
  type PublicBetaSha256Digest,
  computePublicBetaSha256,
} from './public-beta-canonical-json';

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

interface PublicBetaBoundedFileReference {
  root: string;
  path: string;
  maxBytes: number;
  digest?: PublicBetaSha256Digest;
  sizeBytes?: number;
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
  reference: Readonly<PublicBetaBoundedFileReference>,
): reference is Readonly<Required<PublicBetaBoundedFileReference>> | Readonly<PublicBetaBoundedFileReference> {
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
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'digest' | 'maxBytes'>>,
): boolean {
  return (
    typeof reference === 'object' &&
    reference !== null &&
    typeof reference.root === 'string' &&
    validPath(reference.path) &&
    typeof reference.digest === 'string' &&
    DIGEST.test(reference.digest) &&
    typeof reference.maxBytes === 'number' &&
    Number.isSafeInteger(reference.maxBytes) &&
    reference.maxBytes >= 0
  );
}

function lexicalCandidatePath(root: string, path: string): string | false {
  try {
    const lexicalRoot = resolve(root);
    const realRoot = realpathSync.native(lexicalRoot);
    const rootStat = lstatSync(lexicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;

    let cursor = realRoot;
    for (const segment of path.split('/')) {
      cursor = resolve(cursor, segment);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || realpathSync.native(cursor) !== cursor) return false;
    }
    return cursor;
  } catch {
    return false;
  }
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

function readBoundedBytes(
  reference: Readonly<PublicBetaBoundedFileReference>,
): PublicBetaVerifiedBytes | false {
  if (!validBoundedReference(reference)) return false;
  const candidatePath = lexicalCandidatePath(reference.root, reference.path);
  if (candidatePath === false) return false;

  let descriptor: number | null = null;
  let result: PublicBetaVerifiedBytes | false = false;
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    descriptor = openSync(candidatePath, flags);
    if (realpathSync.native(candidatePath) !== candidatePath) return false;

    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > reference.maxBytes ||
      (reference.sizeBytes !== undefined && before.size !== reference.sizeBytes)
    ) {
      return false;
    }

    const bytes = readExact(descriptor, before.size);
    if (bytes === false) return false;
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== before.size) return false;

    const digest = computePublicBetaSha256(bytes);
    if (reference.digest !== undefined && digest !== reference.digest) return false;
    result = { bytes, digest, sizeBytes: before.size };
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
  if (
    !validLimits(reference?.sizeBytes, reference?.maxBytes) ||
    typeof reference?.digest !== 'string' ||
    !DIGEST.test(reference.digest)
  ) {
    return false;
  }
  return readBoundedBytes(reference);
}

export function readPublicBetaBoundedBytes(
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'maxBytes'>>,
): PublicBetaVerifiedBytes | false {
  return readBoundedBytes(reference);
}

/** Verifies a potentially large candidate file without materializing it in memory. */
export function verifyPublicBetaFile(
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'digest' | 'maxBytes'>>,
): boolean {
  if (!validStreamingReference(reference)) return false;
  const candidatePath = lexicalCandidatePath(reference.root, reference.path);
  if (candidatePath === false) return false;

  let descriptor: number | null = null;
  let result = false;
  try {
    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW);
    descriptor = openSync(candidatePath, flags);
    if (realpathSync.native(candidatePath) !== candidatePath) return false;

    const before = fstatSync(descriptor);
    if (
      !before.isFile() ||
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > reference.maxBytes
    ) {
      return false;
    }

    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(STREAM_HASH_BUFFER_BYTES);
    while (true) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }

    const after = fstatSync(descriptor);
    if (!after.isFile() || after.size !== before.size) return false;
    result = `sha256:${hash.digest('hex')}` === reference.digest;
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
    return { file, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)) };
  } catch {
    return false;
  }
}

export function readPublicBetaBoundedJson(
  reference: Readonly<Pick<PublicBetaFileReference, 'root' | 'path' | 'maxBytes'>>,
): { file: PublicBetaVerifiedBytes; value: unknown } | false {
  const file = readBoundedBytes(reference);
  if (file === false) return false;
  try {
    return { file, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes)) };
  } catch {
    return false;
  }
}
