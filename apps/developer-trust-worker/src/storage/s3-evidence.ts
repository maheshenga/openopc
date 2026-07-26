import { createHash, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { canonicalJson } from '../scanners/types';

export const CYCLONEDX_JSON_MEDIA_TYPE = 'application/vnd.cyclonedx+json' as const;
export const MAX_SBOM_EVIDENCE_BYTES = 16 * 1024 * 1024;

export class S3EvidenceStoreError extends Error {
  override readonly name = 'S3EvidenceStoreError';

  constructor(readonly code: string) {
    super(code);
  }
}

export interface S3EvidenceReference {
  kind: 'sbom';
  bucket: string;
  storageKey: string;
  digest: `sha256:${string}`;
  sizeBytes: number;
  mediaType: typeof CYCLONEDX_JSON_MEDIA_TYPE;
}

interface S3EvidenceCommandClient {
  send(command: GetObjectCommand | HeadBucketCommand | PutObjectCommand): Promise<unknown>;
}

export interface S3EvidenceStore {
  assertReady(): Promise<void>;
  putSbom(input: {
    accountId: string;
    runId: string;
    digest: `sha256:${string}`;
    bytes: Uint8Array;
  }): Promise<S3EvidenceReference>;
  getSbom(input: {
    accountId: string;
    runId: string;
    digest: `sha256:${string}`;
  }): Promise<{ reference: S3EvidenceReference; bytes: Uint8Array }>;
}

export function createS3EvidenceStore(input: {
  client: S3EvidenceCommandClient;
  bucket: string;
  prefix?: string;
  maxSbomBytes?: number;
}): S3EvidenceStore {
  const prefix = input.prefix ?? 'developer-trust/evidence';
  const maxSbomBytes = input.maxSbomBytes ?? MAX_SBOM_EVIDENCE_BYTES;
  validateConfig(input.bucket, prefix, maxSbomBytes);
  return {
    async assertReady() {
      try {
        await input.client.send(new HeadBucketCommand({ Bucket: input.bucket }));
      } catch {
        fail('DEVELOPER_TRUST_EVIDENCE_UNAVAILABLE');
      }
    },
    async putSbom(request) {
      validateCoordinates(request);
      validateSbomSize(request.bytes, maxSbomBytes);
      const actualDigest = `sha256:${createHash('sha256').update(request.bytes).digest('hex')}`;
      if (actualDigest !== request.digest) {
        fail('DEVELOPER_TRUST_EVIDENCE_DIGEST_MISMATCH');
      }
      validateSbomDocument(request.bytes);
      const storageKey = evidenceKey(prefix, request.accountId, request.runId, request.digest);
      const reference: S3EvidenceReference = {
        kind: 'sbom',
        bucket: input.bucket,
        storageKey,
        digest: request.digest,
        sizeBytes: request.bytes.byteLength,
        mediaType: CYCLONEDX_JSON_MEDIA_TYPE,
      };
      try {
        await input.client.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: storageKey,
            Body: request.bytes,
            ContentLength: request.bytes.byteLength,
            ContentType: CYCLONEDX_JSON_MEDIA_TYPE,
            ChecksumSHA256: Buffer.from(request.digest.slice('sha256:'.length), 'hex').toString(
              'base64',
            ),
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (!preconditionFailed(error)) fail('DEVELOPER_TRUST_EVIDENCE_WRITE_FAILED');
        const existing = await readStoredObject(input.client, reference);
        if (
          existing.byteLength !== request.bytes.byteLength ||
          !timingSafeEqual(existing, request.bytes)
        ) {
          fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
        }
      }
      return reference;
    },
    async getSbom(request) {
      validateCoordinates(request);
      const storageKey = evidenceKey(prefix, request.accountId, request.runId, request.digest);
      let response: unknown;
      try {
        response = await input.client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: storageKey,
            ChecksumMode: 'ENABLED',
          }),
        );
      } catch {
        fail('DEVELOPER_TRUST_EVIDENCE_READ_FAILED');
      }
      const stored = response as { Body?: unknown; ContentLength?: number; ContentType?: string };
      if (
        !Number.isSafeInteger(stored.ContentLength) ||
        (stored.ContentLength ?? 0) < 1 ||
        (stored.ContentLength ?? 0) > maxSbomBytes ||
        stored.ContentType !== CYCLONEDX_JSON_MEDIA_TYPE
      ) {
        fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
      }
      const reference: S3EvidenceReference = {
        kind: 'sbom',
        bucket: input.bucket,
        storageKey,
        digest: request.digest,
        sizeBytes: stored.ContentLength as number,
        mediaType: CYCLONEDX_JSON_MEDIA_TYPE,
      };
      const bytes = await readBody(stored.Body, reference.sizeBytes);
      const actualDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (actualDigest !== reference.digest) {
        fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
      }
      validateSbomDocument(bytes);
      return { reference, bytes };
    },
  };
}

async function readStoredObject(
  client: S3EvidenceCommandClient,
  reference: S3EvidenceReference,
): Promise<Uint8Array> {
  let response: unknown;
  try {
    response = await client.send(
      new GetObjectCommand({
        Bucket: reference.bucket,
        Key: reference.storageKey,
        ChecksumMode: 'ENABLED',
      }),
    );
  } catch {
    fail('DEVELOPER_TRUST_EVIDENCE_READ_FAILED');
  }
  const stored = response as { Body?: unknown; ContentLength?: number; ContentType?: string };
  if (stored.ContentLength !== reference.sizeBytes || stored.ContentType !== reference.mediaType) {
    fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
  }
  const bytes = await readBody(stored.Body, reference.sizeBytes);
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (digest !== reference.digest) fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
  return bytes;
}

async function readBody(body: unknown, expectedSize: number): Promise<Uint8Array> {
  if (!body || typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] !== 'function') {
    fail('DEVELOPER_TRUST_EVIDENCE_READ_FAILED');
  }
  const result = new Uint8Array(expectedSize);
  let offset = 0;
  try {
    for await (const value of body as AsyncIterable<Uint8Array | string>) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : new Uint8Array(value);
      if (offset + chunk.byteLength > expectedSize) {
        fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
      }
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof S3EvidenceStoreError) throw error;
    fail('DEVELOPER_TRUST_EVIDENCE_READ_FAILED');
  }
  if (offset !== expectedSize) fail('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
  return result;
}

function preconditionFailed(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return (
    candidate.name === 'PreconditionFailed' ||
    candidate.name === 'ConditionalRequestConflict' ||
    candidate.$metadata?.httpStatusCode === 412 ||
    candidate.$metadata?.httpStatusCode === 409
  );
}

function evidenceKey(
  prefix: string,
  accountId: string,
  runId: string,
  digest: `sha256:${string}`,
): string {
  return `${prefix}/accounts/${accountId}/runs/${runId}/sbom/sha256/${digest.slice('sha256:'.length)}.cdx.json`;
}

function validateConfig(bucket: string, prefix: string, maxSbomBytes: number): void {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
    !safeKeyPath(prefix, 512) ||
    !Number.isSafeInteger(maxSbomBytes) ||
    maxSbomBytes < 1 ||
    maxSbomBytes > MAX_SBOM_EVIDENCE_BYTES
  ) {
    fail('DEVELOPER_TRUST_EVIDENCE_CONFIG_INVALID');
  }
}

function validateCoordinates(input: {
  accountId: string;
  runId: string;
  digest: string;
}): void {
  const coordinate = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (
    !coordinate.test(input.accountId) ||
    !coordinate.test(input.runId) ||
    !/^sha256:[0-9a-f]{64}$/.test(input.digest)
  ) {
    fail('DEVELOPER_TRUST_EVIDENCE_REQUEST_INVALID');
  }
}

function validateSbomSize(bytes: Uint8Array, maxSbomBytes: number): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maxSbomBytes) {
    fail('DEVELOPER_TRUST_EVIDENCE_REQUEST_INVALID');
  }
}

function validateSbomDocument(bytes: Uint8Array): void {
  try {
    const serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const document = JSON.parse(serialized) as unknown;
    if (!isSbomDocument(document) || canonicalJson(document) !== serialized) {
      fail('DEVELOPER_TRUST_EVIDENCE_DOCUMENT_INVALID');
    }
  } catch (error) {
    if (error instanceof S3EvidenceStoreError) throw error;
    fail('DEVELOPER_TRUST_EVIDENCE_DOCUMENT_INVALID');
  }
}

function isSbomDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = value as Record<string, unknown>;
  if (document.bomFormat !== 'CycloneDX' || document.specVersion !== '1.6') return false;
  const keys = Object.keys(document);
  if (document.unavailable === true) {
    return (
      keys.length === 3 &&
      keys.every((key) => ['bomFormat', 'specVersion', 'unavailable'].includes(key))
    );
  }
  return (
    document.version === 1 &&
    Array.isArray(document.components) &&
    keys.every((key) =>
      ['bomFormat', 'components', 'dependencies', 'specVersion', 'version'].includes(key),
    )
  );
}

function safeKeyPath(value: string, maxLength: number): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    !/[\0\r\n]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function fail(code: string): never {
  throw new S3EvidenceStoreError(code);
}
