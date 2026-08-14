import { createRequire } from 'node:module';

import {
  loadS3CloudSmokeConfig,
  selectS3CloudSmokeTarget,
  type S3CloudSmokeConfig,
} from '../src/smoke/s3-cloud-smoke';

// The worker depends on the adapters workspace package, which owns the S3 SDK.
// Resolve it from that package rather than adding a second, drifting SDK pin.
const requireFromAdapters = createRequire(
  new URL('../../../packages/studio-adapters/package.json', import.meta.url),
);
const {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = requireFromAdapters('@aws-sdk/client-s3');
const { getSignedUrl } = requireFromAdapters('@aws-sdk/s3-request-presigner');

type CloudClient = {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy(): void;
};

const selectedTarget = selectS3CloudSmokeTarget(process.env as Record<string, string | undefined>);
if (selectedTarget === null) {
  console.info('S3 cloud smoke skipped: no target gate is armed');
} else {
  await main(selectedTarget).catch(() => {
    console.error('S3 cloud smoke failed (details redacted)');
    process.exitCode = 1;
  });
}

const BODY = new TextEncoder().encode('kortix studio cloud smoke');
const CHECKSUM = Buffer.from(
  new Bun.CryptoHasher('sha256').update(BODY).digest('hex'),
  'hex',
).toString('base64');

async function main(target: Parameters<typeof loadS3CloudSmokeConfig>[1]): Promise<void> {
  const config = loadS3CloudSmokeConfig(process.env as Record<string, string | undefined>, target);
  const client: CloudClient = new S3Client({
    endpoint: config.endpoint.toString(),
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  let prefixWasEmpty = false;
  try {
    await assertExactPrefixEmpty(client, config.bucket, config.prefix);
    prefixWasEmpty = true;
    if (config.expectedOwnerSupported && config.expectedOwner) {
      await client.send(
        new HeadBucketCommand({ Bucket: config.bucket, ExpectedBucketOwner: config.expectedOwner }),
      );
    }
    const directKey = config.prefix + '/direct.bin';
    const signedKey = config.prefix + '/signed.bin';
    await putAndAssert(client, config, directKey);
    await signedPutAndAssert(client, config, signedKey);
    await signedGetAndAssert(client, config, directKey);
    await assertAnonymousGetDenied(config, directKey);
  } finally {
    try {
      if (prefixWasEmpty) {
        await cleanupExactPrefix(client, config.bucket, config.prefix, [
          config.prefix + '/direct.bin',
          config.prefix + '/signed.bin',
        ]);
      }
    } finally {
      client.destroy();
    }
  }
  console.info('S3 cloud smoke passed for ' + config.profile.target + ': put/head/get/signed transfer/privacy assertions completed');
  console.info('S3 cloud smoke cleanup confirmed: dedicated prefix is empty');
}

async function putAndAssert(client: CloudClient, config: S3CloudSmokeConfig, key: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: BODY,
      ContentType: 'application/octet-stream',
      ContentLength: BODY.byteLength,
      ChecksumSHA256: CHECKSUM,
      Metadata: { 'studio-smoke': 'true' },
      ...(config.sse !== 'none' ? { ServerSideEncryption: config.sse } : {}),
      ...(config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
      ...(config.expectedOwner ? { ExpectedBucketOwner: config.expectedOwner } : {}),
    }),
  );
  await headAndAssert(client, config, key);
  const object = await client.send(
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ChecksumMode: 'ENABLED',
      ...(config.expectedOwner ? { ExpectedBucketOwner: config.expectedOwner } : {}),
    }),
  );
  if (!object.Body || !equalBytes(await readBody(object.Body as AsyncIterable<unknown>), BODY)) {
    throw new Error('GetObject body checksum assertion failed');
  }
}

async function signedPutAndAssert(client: CloudClient, config: S3CloudSmokeConfig, key: string): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: 'application/octet-stream',
    ContentLength: BODY.byteLength,
    ChecksumSHA256: CHECKSUM,
    Metadata: { 'studio-smoke': 'true' },
    ...(config.sse !== 'none' ? { ServerSideEncryption: config.sse } : {}),
    ...(config.kmsKeyId ? { SSEKMSKeyId: config.kmsKeyId } : {}),
    ...(config.expectedOwner ? { ExpectedBucketOwner: config.expectedOwner } : {}),
  });
  const signedUrl = await getSignedUrl(client, command, { expiresIn: 60 });
  const response = await fetch(signedUrl, {
    method: 'PUT',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(BODY.byteLength),
      'x-amz-checksum-sha256': CHECKSUM,
      'x-amz-meta-studio-smoke': 'true',
      ...(config.sse !== 'none' ? { 'x-amz-server-side-encryption': config.sse } : {}),
      ...(config.kmsKeyId
        ? { 'x-amz-server-side-encryption-aws-kms-key-id': config.kmsKeyId }
        : {}),
      ...(config.expectedOwner ? { 'x-amz-expected-bucket-owner': config.expectedOwner } : {}),
    },
    body: BODY,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error('signed upload assertion failed');
  await headAndAssert(client, config, key);
}

async function signedGetAndAssert(client: CloudClient, config: S3CloudSmokeConfig, key: string): Promise<void> {
  const signedUrl = await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ResponseContentDisposition: 'attachment',
      ...(config.expectedOwner ? { ExpectedBucketOwner: config.expectedOwner } : {}),
    }),
    { expiresIn: 60 },
  );
  const response = await fetch(signedUrl, {
    headers: config.expectedOwner ? { 'x-amz-expected-bucket-owner': config.expectedOwner } : {},
    signal: AbortSignal.timeout(30_000),
  });
  if (
    !response.ok ||
    !response.headers.get('content-disposition')?.startsWith('attachment') ||
    !equalBytes(new Uint8Array(await response.arrayBuffer()), BODY)
  ) {
    throw new Error('signed download assertion failed');
  }
}

async function headAndAssert(client: CloudClient, config: S3CloudSmokeConfig, key: string): Promise<void> {
  const object = await client.send(
    new HeadObjectCommand({
      Bucket: config.bucket,
      Key: key,
      ChecksumMode: 'ENABLED',
      ...(config.expectedOwner ? { ExpectedBucketOwner: config.expectedOwner } : {}),
    }),
  );
  if (
    object.ContentType !== 'application/octet-stream' ||
    object.ContentLength !== BODY.byteLength ||
    object.ChecksumSHA256 !== CHECKSUM ||
    object.Metadata?.['studio-smoke'] !== 'true' ||
    (config.sse !== 'none' && object.ServerSideEncryption !== config.sse) ||
    (config.kmsKeyId !== undefined && object.SSEKMSKeyId !== config.kmsKeyId)
  ) {
    throw new Error('HeadObject metadata, checksum, or SSE/KMS assertion failed');
  }
}

async function assertAnonymousGetDenied(config: S3CloudSmokeConfig, key: string): Promise<void> {
  const url = anonymousObjectUrl(config, key);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 401 && response.status !== 403) {
    throw new Error('anonymous GET was not denied');
  }
}

function anonymousObjectUrl(config: S3CloudSmokeConfig, key: string): URL {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  if (config.forcePathStyle)
    return new URL(encodeURIComponent(config.bucket) + '/' + encodedKey, config.endpoint);
  const url = new URL(config.endpoint);
  url.hostname = config.bucket + '.' + url.hostname;
  url.pathname = '/' + encodedKey;
  return url;
}

async function assertExactPrefixEmpty(
  client: CloudClient,
  bucket: string,
  prefix: string,
): Promise<void> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + '/' }),
  );
  const contents = (listed.Contents ?? []) as unknown[];
  if (contents.length > 0) throw new Error('dedicated smoke prefix is not empty');
}

async function cleanupExactPrefix(
  client: CloudClient,
  bucket: string,
  prefix: string,
  keys: string[],
): Promise<void> {
  await client.send(
    new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
    }),
  );
  const remaining = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix + '/' }),
  );
  const remainingContents = (remaining.Contents ?? []) as unknown[];
  if (remainingContents.length > 0)
    throw new Error('exact-prefix cleanup assertion failed');
}

async function readBody(body: AsyncIterable<unknown>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk as ArrayBuffer);
    size += bytes.byteLength;
    if (size > 1024 * 1024) throw new Error('GetObject body exceeded smoke limit');
    chunks.push(bytes);
  }
  return Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}
