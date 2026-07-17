import { createRequire } from 'node:module';

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

type OssClient = {
  send(command: unknown): Promise<Record<string, unknown>>;
  destroy(): void;
};

if (process.env.STUDIO_ALIYUN_OSS_SMOKE !== 'true') {
  console.info('Alibaba OSS smoke skipped: STUDIO_ALIYUN_OSS_SMOKE is not true');
} else {
  await main().catch(() => {
    console.error('Alibaba OSS smoke failed (details redacted)');
    process.exitCode = 1;
  });
}

const BODY = new TextEncoder().encode('kortix studio OSS smoke');
const CHECKSUM = Buffer.from(
  new Bun.CryptoHasher('sha256').update(BODY).digest('hex'),
  'hex',
).toString('base64');

async function main(): Promise<void> {
  const config = loadConfig();
  const client: OssClient = new S3Client({
    endpoint: config.endpoint.toString(),
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  let prefixWasEmpty = false;
  try {
    await assertExactPrefixEmpty(client, config.bucket, config.prefix);
    prefixWasEmpty = true;
    if (config.expectedOwnerSupported) {
      await client.send(
        new HeadBucketCommand({ Bucket: config.bucket, ExpectedBucketOwner: config.expectedOwner }),
      );
    }
    const directKey = `${config.prefix}/direct.bin`;
    const signedKey = `${config.prefix}/signed.bin`;
    await putAndAssert(client, config, directKey);
    await signedPutAndAssert(client, config, signedKey);
    await signedGetAndAssert(client, config, directKey);
    await assertAnonymousGetDenied(config, directKey);
  } finally {
    try {
      if (prefixWasEmpty) {
        await cleanupExactPrefix(client, config.bucket, config.prefix, [
          `${config.prefix}/direct.bin`,
          `${config.prefix}/signed.bin`,
        ]);
      }
    } finally {
      client.destroy();
    }
  }
  console.info(
    'Alibaba OSS smoke passed: put/head/get/signed transfer/privacy/SSE assertions completed',
  );
  console.info('Alibaba OSS smoke cleanup confirmed: dedicated prefix is empty');
}

type Config = {
  endpoint: URL;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  sse: 'AES256' | 'aws:kms';
  kmsKeyId: string | undefined;
  expectedOwner: string | undefined;
  expectedOwnerSupported: boolean;
};

function loadConfig(): Config {
  const endpoint = new URL(requiredEnvironment('STUDIO_S3_ENDPOINT'));
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username ||
    endpoint.password ||
    endpoint.pathname !== '/' ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error('STUDIO_S3_ENDPOINT must be a clean HTTPS origin');
  }
  if (requiredEnvironment('STUDIO_OBJECT_STORE_MODE') !== 's3') {
    throw new Error('STUDIO_OBJECT_STORE_MODE must be s3');
  }
  const forcePathStyleValue = requiredEnvironment('STUDIO_S3_FORCE_PATH_STYLE');
  if (forcePathStyleValue !== 'true' && forcePathStyleValue !== 'false') {
    throw new Error('STUDIO_S3_FORCE_PATH_STYLE must be true or false');
  }
  const sse = requiredEnvironment('STUDIO_S3_SSE');
  if (sse !== 'AES256' && sse !== 'aws:kms') throw new Error('STUDIO_S3_SSE is invalid');
  const objectStorePrefix = requiredEnvironment('STUDIO_OBJECT_STORE_PREFIX').replace(/\/$/, '');
  const prefix = requiredEnvironment('STUDIO_ALIYUN_OSS_SMOKE_PREFIX').replace(/\/$/, '');
  const expectedPrefix = `${objectStorePrefix}/studio-smoke/`;
  if (
    !prefix.startsWith(expectedPrefix) ||
    !/^[a-z0-9][a-z0-9/_-]{2,120}$/i.test(prefix) ||
    prefix.includes('..')
  ) {
    throw new Error(
      'STUDIO_ALIYUN_OSS_SMOKE_PREFIX must be an exact dedicated object-store prefix',
    );
  }
  if (process.env.STUDIO_ALIYUN_OSS_CLEANUP_CONFIRMATION !== 'EXACT_PREFIX_ONLY') {
    throw new Error('exact-prefix cleanup confirmation is required');
  }
  const expectedOwnerSupported =
    process.env.STUDIO_ALIYUN_OSS_EXPECTED_BUCKET_OWNER_SUPPORTED === 'true';
  const configuredExpectedOwner = process.env.STUDIO_S3_EXPECTED_BUCKET_OWNER?.trim();
  if (expectedOwnerSupported && !configuredExpectedOwner) {
    throw new Error('STUDIO_S3_EXPECTED_BUCKET_OWNER is required when owner checks are supported');
  }
  const kmsKeyId = process.env.STUDIO_S3_KMS_KEY_ID?.trim();
  if (sse === 'aws:kms' && !kmsKeyId)
    throw new Error('STUDIO_S3_KMS_KEY_ID is required for aws:kms');
  if (sse === 'AES256' && kmsKeyId) throw new Error('STUDIO_S3_KMS_KEY_ID is forbidden for AES256');
  return {
    endpoint,
    region: requiredEnvironment('STUDIO_S3_REGION'),
    bucket: requiredEnvironment('STUDIO_OBJECT_STORE_BUCKET'),
    prefix,
    forcePathStyle: forcePathStyleValue === 'true',
    accessKeyId: requiredEnvironment('STUDIO_S3_ACCESS_KEY_ID'),
    secretAccessKey: requiredEnvironment('STUDIO_S3_SECRET_ACCESS_KEY'),
    sse,
    kmsKeyId,
    expectedOwner: expectedOwnerSupported ? configuredExpectedOwner : undefined,
    expectedOwnerSupported,
  };
}

async function putAndAssert(client: OssClient, config: Config, key: string): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: BODY,
      ContentType: 'application/octet-stream',
      ContentLength: BODY.byteLength,
      ChecksumSHA256: CHECKSUM,
      Metadata: { 'studio-smoke': 'true' },
      ServerSideEncryption: config.sse,
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
  if (!object.Body || !equalBytes(await readBody(object.Body), BODY)) {
    throw new Error('GetObject body checksum assertion failed');
  }
}

async function signedPutAndAssert(client: OssClient, config: Config, key: string): Promise<void> {
  const command = new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: 'application/octet-stream',
    ContentLength: BODY.byteLength,
    ChecksumSHA256: CHECKSUM,
    Metadata: { 'studio-smoke': 'true' },
    ServerSideEncryption: config.sse,
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
      'x-amz-server-side-encryption': config.sse,
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

async function signedGetAndAssert(client: OssClient, config: Config, key: string): Promise<void> {
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

async function headAndAssert(client: OssClient, config: Config, key: string): Promise<void> {
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
    object.ServerSideEncryption !== config.sse ||
    (config.kmsKeyId !== undefined && object.SSEKMSKeyId !== config.kmsKeyId)
  ) {
    throw new Error('HeadObject metadata, checksum, or SSE/KMS assertion failed');
  }
}

async function assertAnonymousGetDenied(config: Config, key: string): Promise<void> {
  const url = anonymousObjectUrl(config, key);
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 401 && response.status !== 403) {
    throw new Error('anonymous GET was not denied');
  }
}

function anonymousObjectUrl(config: Config, key: string): URL {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  if (config.forcePathStyle)
    return new URL(`${encodeURIComponent(config.bucket)}/${encodedKey}`, config.endpoint);
  const url = new URL(config.endpoint);
  url.hostname = `${config.bucket}.${url.hostname}`;
  url.pathname = `/${encodedKey}`;
  return url;
}

async function assertExactPrefixEmpty(
  client: OssClient,
  bucket: string,
  prefix: string,
): Promise<void> {
  const listed = await client.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }),
  );
  if ((listed.Contents ?? []).length > 0) throw new Error('dedicated smoke prefix is not empty');
}

async function cleanupExactPrefix(
  client: OssClient,
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
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }),
  );
  if ((remaining.Contents ?? []).length > 0)
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

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
