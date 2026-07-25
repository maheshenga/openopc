import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { GetObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import {
  DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
  type RegistryModuleLockGraph,
} from '@kortix/registry';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export class S3ArtifactReaderError extends Error {
  override readonly name = 'S3ArtifactReaderError';

  constructor(readonly code: string) {
    super(code);
  }
}

interface S3CommandClient {
  send(command: GetObjectCommand | HeadBucketCommand): Promise<unknown>;
}

export interface PreparedDeveloperArtifact {
  workspacePath: string;
  lockGraph: RegistryModuleLockGraph | null;
  dependencyLicenses: ReadonlyArray<{ name: string; version: string; license: string }>;
}

export interface S3ArtifactReader {
  assertReady(): Promise<void>;
  release(workspacePath: string): Promise<void>;
  prepare(input: {
    storageKey: string;
    expectedDigest: `sha256:${string}`;
    expectedSize: number;
    signal?: AbortSignal;
  }): Promise<PreparedDeveloperArtifact>;
}

export function createS3ArtifactReader(input: {
  client: S3CommandClient;
  bucket: string;
  workspaceRoot: string;
  maxArtifactBytes: number;
}): S3ArtifactReader {
  assertConfig(input);
  return {
    async assertReady() {
      try {
        await input.client.send(new HeadBucketCommand({ Bucket: input.bucket }));
      } catch {
        fail('DEVELOPER_TRUST_OBJECT_STORAGE_UNAVAILABLE');
      }
    },

    async prepare(request) {
      validateRequest(request, input.maxArtifactBytes);
      if (request.signal?.aborted) fail('DEVELOPER_TRUST_ARTIFACT_READ_CANCELLED');
      let response: unknown;
      try {
        response = await input.client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: request.storageKey,
            ChecksumMode: 'ENABLED',
          }),
        );
      } catch {
        fail('DEVELOPER_TRUST_ARTIFACT_UNAVAILABLE');
      }
      const stored = response as { Body?: unknown; ContentLength?: number };
      if (stored.ContentLength !== undefined && stored.ContentLength !== request.expectedSize) {
        fail('DEVELOPER_TRUST_ARTIFACT_SIZE_MISMATCH');
      }

      const body = await readBody(
        stored.Body,
        request.expectedSize,
        input.maxArtifactBytes,
        request.signal,
      );
      if (body.digest !== request.expectedDigest) {
        fail('DEVELOPER_TRUST_ARTIFACT_DIGEST_MISMATCH');
      }
      const artifact = parsePackage(body.bytes, input.maxArtifactBytes);
      const workspacePath = await mkdtemp(join(input.workspaceRoot, 'openopc-artifact-'));
      try {
        const dependencyLicenses: Array<{ name: string; version: string; license: string }> = [];
        for (const file of artifact.files) {
          const target = safeWorkspaceTarget(workspacePath, file.path);
          await mkdir(resolve(target, '..'), { recursive: true });
          await writeFile(target, file.bytes, { flag: 'wx' });
          const dependency = packageLicense(file.path, file.bytes);
          if (dependency) dependencyLicenses.push(dependency);
        }
        dependencyLicenses.sort((left, right) =>
          `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`, 'en'),
        );
        return {
          workspacePath,
          lockGraph: artifact.lockGraph,
          dependencyLicenses,
        };
      } catch (error) {
        await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof S3ArtifactReaderError) throw error;
        fail('DEVELOPER_TRUST_ARTIFACT_MATERIALIZATION_FAILED');
      }
    },
    async release(workspacePath) {
      const root = resolve(input.workspaceRoot);
      const target = resolve(workspacePath);
      if (!target.startsWith(`${root}${sep}openopc-artifact-`)) {
        fail('DEVELOPER_TRUST_ARTIFACT_WORKSPACE_INVALID');
      }
      await rm(target, { recursive: true, force: true, maxRetries: 2 });
    },
  };
}

function assertConfig(input: {
  bucket: string;
  workspaceRoot: string;
  maxArtifactBytes: number;
}): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    !isAbsolute(input.workspaceRoot) ||
    !Number.isSafeInteger(input.maxArtifactBytes) ||
    input.maxArtifactBytes < 1 ||
    input.maxArtifactBytes > 512 * 1024 * 1024
  ) {
    fail('DEVELOPER_TRUST_OBJECT_STORAGE_CONFIG_INVALID');
  }
}

function validateRequest(
  input: { storageKey: string; expectedDigest: string; expectedSize: number },
  maxArtifactBytes: number,
): void {
  if (
    !DIGEST.test(input.expectedDigest) ||
    !Number.isSafeInteger(input.expectedSize) ||
    input.expectedSize < 1 ||
    input.expectedSize > maxArtifactBytes ||
    input.storageKey.length < 1 ||
    input.storageKey.length > 2_048 ||
    input.storageKey.startsWith('/') ||
    input.storageKey.includes('\\') ||
    input.storageKey.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    /[\0\r\n]/.test(input.storageKey)
  ) {
    fail('DEVELOPER_TRUST_ARTIFACT_REQUEST_INVALID');
  }
}

async function readBody(
  body: unknown,
  expectedSize: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; digest: `sha256:${string}` }> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    fail('DEVELOPER_TRUST_ARTIFACT_BODY_INVALID');
  }
  const chunks: Uint8Array[] = [];
  const hash = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      if (signal?.aborted) fail('DEVELOPER_TRUST_ARTIFACT_READ_CANCELLED');
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk);
      total += bytes.byteLength;
      if (total > expectedSize || total > maxBytes) {
        fail('DEVELOPER_TRUST_ARTIFACT_SIZE_MISMATCH');
      }
      hash.update(bytes);
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof S3ArtifactReaderError) throw error;
    fail('DEVELOPER_TRUST_ARTIFACT_READ_FAILED');
  }
  if (total !== expectedSize) fail('DEVELOPER_TRUST_ARTIFACT_SIZE_MISMATCH');
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: result, digest: `sha256:${hash.digest('hex')}` };
}

function parsePackage(
  bytes: Uint8Array,
  maxExpandedBytes: number,
): {
  files: Array<{ path: string; bytes: Uint8Array }>;
  lockGraph: RegistryModuleLockGraph | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
  }
  if (!record(value)) fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
  const root = value as Record<string, unknown>;
  if (
    !exactKeys(root, ['files', 'formatVersion', 'item', 'lockGraph', 'mediaType', 'source']) ||
    root.formatVersion !== 2 ||
    root.mediaType !== DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE ||
    !record(root.item) ||
    !Array.isArray(root.files) ||
    root.files.length > 2_048 ||
    JSON.stringify(canonicalValue(value)) !== new TextDecoder().decode(bytes)
  ) {
    fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
  }
  let expandedBytes = 0;
  const seen = new Set<string>();
  const files = root.files.map((entry) => {
    if (!record(entry)) fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    const file = entry as Record<string, unknown>;
    const keys =
      file.kind === undefined
        ? ['bytes', 'mediaType', 'path', 'target']
        : ['bytes', 'kind', 'mediaType', 'path', 'target'];
    if (
      !exactKeys(file, keys) ||
      (file.kind !== undefined && file.kind !== 'file') ||
      typeof file.path !== 'string' ||
      !safeRelativePath(file.path) ||
      typeof file.target !== 'string' ||
      typeof file.mediaType !== 'string' ||
      typeof file.bytes !== 'string' ||
      !file.bytes.startsWith('base64:') ||
      !safeRelativePath(file.target) ||
      seen.has(file.target)
    ) {
      fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    }
    const encoded = file.bytes.slice('base64:'.length);
    if (!BASE64.test(encoded)) fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
    if (Buffer.from(decoded).toString('base64') !== encoded) {
      fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    }
    expandedBytes += decoded.byteLength;
    if (expandedBytes > maxExpandedBytes) fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    seen.add(file.target);
    return { path: file.target, bytes: decoded };
  });
  return { files, lockGraph: structuredClone(root.lockGraph) as RegistryModuleLockGraph | null };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (record(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  fail('DEVELOPER_TRUST_ARTIFACT_PACKAGE_INVALID');
}

function safeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !/^[A-Za-z]:/.test(value) &&
    !value.includes('\\') &&
    !/[\0\r\n]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function safeWorkspaceTarget(workspacePath: string, relativePath: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) fail('DEVELOPER_TRUST_ARTIFACT_PATH_INVALID');
  return target;
}

function packageLicense(
  path: string,
  bytes: Uint8Array,
): { name: string; version: string; license: string } | null {
  if (!path.endsWith('package.json') || bytes.byteLength > 1024 * 1024) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    if (!record(value)) return null;
    const { name, version, license } = value;
    return typeof name === 'string' &&
      name.length <= 214 &&
      typeof version === 'string' &&
      version.length <= 128 &&
      typeof license === 'string' &&
      license.length <= 128
      ? { name, version, license }
      : null;
  } catch {
    return null;
  }
}

function fail(code: string): never {
  throw new S3ArtifactReaderError(code);
}
