import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { runStudioObjectStoreConformance } from '@kortix/studio-runtime/conformance';
import type { StudioS3StorageConfig } from '../config';
import { type S3StudioObjectStore, createS3StudioObjectStore } from './s3-object-store';

const integrationEndpoint = process.env.STUDIO_S3_INTEGRATION_URL;
const accessKeyId = process.env.STUDIO_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.STUDIO_S3_SECRET_ACCESS_KEY;
const integrationEnabled = Boolean(integrationEndpoint && accessKeyId && secretAccessKey);
const bucket = 'studio-test';
const runPrefix = `integration/${crypto.randomUUID()}`;
const TEST_BYTES = new Uint8Array([137, 80, 78, 71]);
const TEST_CHECKSUM_HEX = new Bun.CryptoHasher('sha256').update(TEST_BYTES).digest('hex');
const TEST_CHECKSUM_BASE64 = Buffer.from(TEST_CHECKSUM_HEX, 'hex').toString('base64');

describe.skipIf(!integrationEnabled)('S3StudioObjectStore - real MinIO', () => {
  let adminClient: S3Client;
  let storeSequence = 0;
  const stores: S3StudioObjectStore[] = [];

  beforeAll(async () => {
    adminClient = new S3Client(clientConfig());
    try {
      await adminClient.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (httpStatusCode(error) !== 409) throw error;
    }
    await emptyBucket(adminClient);
  });

  afterAll(async () => {
    for (const store of stores) store.destroy();
    if (!adminClient) return;
    try {
      await emptyBucket(adminClient);
      await adminClient.send(new DeleteBucketCommand({ Bucket: bucket }));
    } finally {
      adminClient.destroy();
    }
  });

  runStudioObjectStoreConformance('MinIO S3StudioObjectStore', () => {
    storeSequence += 1;
    return createStore({
      config: storageConfig(`${runPrefix}/conformance-${storeSequence}`),
      role: 'api',
    });
  });

  test('keeps objects private and supports header-constrained signed upload and download', async () => {
    const prefix = `${runPrefix}/signed-browser`;
    const key = 'accounts/a/projects/p/file.png';
    const store = createStore({ config: storageConfig(prefix), role: 'worker' });
    const uploadUrl = await store.createSignedUploadUrl({
      key,
      content_type: 'image/png',
      size_bytes: TEST_BYTES.byteLength,
      checksum_sha256: TEST_CHECKSUM_HEX,
      expires_in_seconds: 60,
    });

    const rejectedUploads = [
      await fetchWithoutSensitiveDiagnostics(uploadUrl, {
        method: 'PUT',
        headers: signedUploadHeaders(uploadUrl, { omitEncryption: true }),
        body: TEST_BYTES,
      }),
      await fetchWithoutSensitiveDiagnostics(uploadUrl, {
        method: 'PUT',
        headers: signedUploadHeaders(uploadUrl, { contentType: 'application/octet-stream' }),
        body: TEST_BYTES,
      }),
      await fetchWithoutSensitiveDiagnostics(uploadUrl, {
        method: 'PUT',
        headers: signedUploadHeaders(uploadUrl, { sizeBytes: TEST_BYTES.byteLength - 1 }),
        body: TEST_BYTES.slice(0, -1),
      }),
      await fetchWithoutSensitiveDiagnostics(uploadUrl, {
        method: 'PUT',
        headers: signedUploadHeaders(uploadUrl, {
          checksumBase64: Buffer.alloc(32).toString('base64'),
        }),
        body: TEST_BYTES,
      }),
    ];
    for (const rejected of rejectedUploads) {
      expect([400, 403]).toContain(rejected.status);
      await rejected.arrayBuffer();
    }
    await expect(store.headObject({ key })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const upload = await fetchWithoutSensitiveDiagnostics(uploadUrl, {
      method: 'PUT',
      headers: signedUploadHeaders(uploadUrl),
      body: TEST_BYTES,
    });
    expect(upload.status).toBe(200);

    await expect(store.headObject({ key })).resolves.toMatchObject({
      content_type: 'image/png',
      size_bytes: TEST_BYTES.byteLength,
      checksum_sha256: TEST_CHECKSUM_HEX,
    });
    const encrypted = await adminClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: `${prefix}/${key}` }),
    );
    expect(encrypted.ServerSideEncryption).toBe('AES256');

    const anonymous = await fetch(anonymousObjectUrl(prefix, key), { redirect: 'manual' });
    expect(anonymous.status).toBe(403);

    const downloadUrl = await store.createSignedDownloadUrl({
      key,
      filename: 'safe file.png',
      expires_in_seconds: 60,
    });
    const download = await fetchWithoutSensitiveDiagnostics(downloadUrl);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toStartWith('attachment;');
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(TEST_BYTES);

    await store.deleteObject({ key });
  });

  function createStore(input: {
    config: StudioS3StorageConfig;
    role: 'api' | 'worker';
  }): S3StudioObjectStore {
    const store = createS3StudioObjectStore(input);
    stores.push(store);
    return store;
  }
});

function storageConfig(prefix: string): StudioS3StorageConfig {
  return {
    mode: 's3',
    bucket,
    prefix,
    endpoint: endpointUrl(),
    publicEndpoint: endpointUrl(),
    region: 'us-east-1',
    forcePathStyle: true,
    expectedBucketOwner: null,
    credentialMode: 'static',
    accessKeyId: requiredEnvironmentValue(accessKeyId),
    secretAccessKey: requiredEnvironmentValue(secretAccessKey),
    sessionToken: null,
    sse: 'AES256',
    kmsKeyId: null,
  };
}

function clientConfig() {
  return {
    endpoint: endpointUrl().toString(),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requiredEnvironmentValue(accessKeyId),
      secretAccessKey: requiredEnvironmentValue(secretAccessKey),
    },
  };
}

function endpointUrl(): URL {
  return new URL(requiredEnvironmentValue(integrationEndpoint));
}

function requiredEnvironmentValue(value: string | undefined): string {
  if (!value) throw new Error('MinIO integration environment is incomplete');
  return value;
}

function anonymousObjectUrl(prefix: string, key: string): string {
  const encodedKey = `${prefix}/${key}`.split('/').map(encodeURIComponent).join('/');
  return new URL(`${encodeURIComponent(bucket)}/${encodedKey}`, endpointUrl()).toString();
}

function signedUploadHeaders(
  signedUrl: string,
  overrides: {
    contentType?: string;
    sizeBytes?: number;
    checksumBase64?: string;
    omitEncryption?: boolean;
  } = {},
): Record<string, string> {
  const signed = new URL(signedUrl);
  const headers: Record<string, string> = {
    'content-type': overrides.contentType ?? 'image/png',
    'content-length': String(overrides.sizeBytes ?? TEST_BYTES.byteLength),
    'x-amz-checksum-sha256': overrides.checksumBase64 ?? TEST_CHECKSUM_BASE64,
  };
  if (!overrides.omitEncryption) {
    const sse = signed.searchParams.get('x-amz-meta-studio-required-sse');
    const kmsKeyId = signed.searchParams.get('x-amz-meta-studio-required-kms-key-id');
    if (sse) headers['x-amz-server-side-encryption'] = sse;
    if (kmsKeyId) headers['x-amz-server-side-encryption-aws-kms-key-id'] = kmsKeyId;
  }
  return headers;
}

async function fetchWithoutSensitiveDiagnostics(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error('MinIO signed request failed');
  }
}

async function emptyBucket(client: S3Client): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }),
    );
    const objects = (listed.Contents ?? []).flatMap((object) =>
      object.Key ? [{ Key: object.Key }] : [],
    );
    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
      );
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

function httpStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('$metadata' in error)) return undefined;
  const metadata = error.$metadata;
  if (typeof metadata !== 'object' || metadata === null || !('httpStatusCode' in metadata)) {
    return undefined;
  }
  return typeof metadata.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}
