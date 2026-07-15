import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { StudioS3StorageConfig } from '../config';
import {
  S3StudioObjectStore,
  type StudioS3Client,
  type StudioS3Presigner,
  createS3StudioObjectStore,
} from './s3-object-store';

const BYTES = new Uint8Array([1, 2, 3, 4]);
const CHECKSUM_HEX = new Bun.CryptoHasher('sha256').update(BYTES).digest('hex');
const CHECKSUM_BASE64 = Buffer.from(CHECKSUM_HEX, 'hex').toString('base64');

const BASE_CONFIG: StudioS3StorageConfig = {
  mode: 's3',
  bucket: 'configured-private-bucket',
  prefix: 'fixed-prefix',
  endpoint: new URL('https://internal-s3.example.test'),
  publicEndpoint: new URL('https://public-s3.example.test'),
  region: 'us-east-1',
  forcePathStyle: true,
  expectedBucketOwner: '123456789012',
  credentialMode: 'static',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  sessionToken: 'test-session-token',
  sse: 'AES256',
  kmsKeyId: null,
};

class RecordingClient implements StudioS3Client {
  readonly commands: unknown[] = [];

  constructor(
    private readonly handler: (command: unknown) => Promise<unknown> = async () => ({}),
  ) {}

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    return this.handler(command);
  }
}

function makeStore(
  input: {
    config?: StudioS3StorageConfig;
    client?: RecordingClient;
    signingClient?: object;
    presign?: StudioS3Presigner;
    ready?: () => Promise<void>;
  } = {},
) {
  const client = input.client ?? new RecordingClient();
  const signingClient = input.signingClient ?? { endpoint: 'public-signing-client' };
  const presign =
    input.presign ??
    (async () => 'https://public-s3.example.test/signed?X-Amz-Signature=test-only');
  return {
    store: new S3StudioObjectStore({
      config: input.config ?? BASE_CONFIG,
      client,
      signingClient,
      presign,
      readiness: input.ready ?? (async () => {}),
    }),
    client,
    signingClient,
  };
}

describe('S3StudioObjectStore', () => {
  test('releases injected client resources idempotently', () => {
    let disposeCalls = 0;
    const store = new S3StudioObjectStore({
      config: BASE_CONFIG,
      client: new RecordingClient(),
      signingClient: {},
      presign: async () => 'https://public-s3.example.test/signed',
      readiness: async () => {},
      dispose: () => {
        disposeCalls += 1;
      },
    } as never);

    (store as unknown as { destroy(): void }).destroy();
    (store as unknown as { destroy(): void }).destroy();

    expect(disposeCalls).toBe(1);
  });

  test('factory signs with the configured public endpoint instead of the internal endpoint', async () => {
    const store = createS3StudioObjectStore({ config: BASE_CONFIG, role: 'api' });

    const signed = await store.createSignedUploadUrl({
      key: 'file.png',
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      expires_in_seconds: 60,
    });

    const signedUrl = new URL(signed);
    expect(signedUrl.origin).toBe(BASE_CONFIG.publicEndpoint?.origin as string);
    expect(signed).not.toContain(BASE_CONFIG.endpoint.origin);
    const signedHeaders = signedUrl.searchParams.get('X-Amz-SignedHeaders')?.split(';');
    expect(signedHeaders).toEqual(
      expect.arrayContaining([
        'content-length',
        'content-type',
        'x-amz-checksum-sha256',
        'x-amz-server-side-encryption',
      ]),
    );
    expect(signedUrl.searchParams.has('x-amz-checksum-sha256')).toBeFalse();
    expect(signedUrl.searchParams.has('x-amz-server-side-encryption')).toBeFalse();
    expect(signedUrl.searchParams.get('x-amz-meta-studio-required-sse')).toBe('AES256');
    store.destroy();
  });

  test('factory rejects incomplete static credentials instead of using the default chain', () => {
    expect(() =>
      createS3StudioObjectStore({
        config: { ...BASE_CONFIG, accessKeyId: null },
        role: 'api',
      }),
    ).toThrow('Invalid Studio S3 credential configuration');
  });

  test('factory signs KMS encryption headers and publishes signed reconstruction markers', async () => {
    const store = createS3StudioObjectStore({
      config: { ...BASE_CONFIG, sse: 'aws:kms', kmsKeyId: 'kms-key-id' },
      role: 'worker',
    });

    const signed = new URL(
      await store.createSignedUploadUrl({
        key: 'file.png',
        content_type: 'image/png',
        size_bytes: BYTES.byteLength,
        checksum_sha256: CHECKSUM_HEX,
        expires_in_seconds: 60,
      }),
    );
    const signedHeaders = signed.searchParams.get('X-Amz-SignedHeaders')?.split(';');
    expect(signedHeaders).toEqual(
      expect.arrayContaining([
        'x-amz-server-side-encryption',
        'x-amz-server-side-encryption-aws-kms-key-id',
      ]),
    );
    expect(signed.searchParams.get('x-amz-meta-studio-required-sse')).toBe('aws:kms');
    expect(signed.searchParams.get('x-amz-meta-studio-required-kms-key-id')).toBe('kms-key-id');
    store.destroy();
  });

  test('rejects configured prefixes containing dot segments', () => {
    expect(() =>
      makeStore({ config: { ...BASE_CONFIG, prefix: 'fixed-prefix/../escape' } }),
    ).toThrow('Invalid Studio object prefix');
  });

  test('rejects caller keys containing dot segments before any S3 or presigner call', async () => {
    const client = consumingClient();
    let presignCalls = 0;
    const { store } = makeStore({
      client,
      presign: async () => {
        presignCalls += 1;
        return 'https://public-s3.example.test/unsafe';
      },
    });
    const key = 'projects/p/../escape.png';

    await expect(
      store.putObject({
        key,
        body: new Blob([BYTES]).stream(),
        content_type: 'image/png',
        size_bytes: BYTES.byteLength,
        checksum_sha256: CHECKSUM_HEX,
        metadata: {},
      }),
    ).rejects.toThrow('Invalid Studio object key');
    await expect(store.headObject({ key })).rejects.toThrow('Invalid Studio object key');
    await expect(store.getObject({ key })).rejects.toThrow('Invalid Studio object key');
    await expect(store.deleteObject({ key })).rejects.toThrow('Invalid Studio object key');
    await expect(
      store.createSignedUploadUrl({
        key,
        content_type: 'image/png',
        size_bytes: BYTES.byteLength,
        checksum_sha256: CHECKSUM_HEX,
        expires_in_seconds: 60,
      }),
    ).rejects.toThrow('Invalid Studio object key');
    await expect(
      store.createSignedDownloadUrl({ key, filename: 'escape.png', expires_in_seconds: 60 }),
    ).rejects.toThrow('Invalid Studio object key');
    expect(client.commands).toHaveLength(0);
    expect(presignCalls).toBe(0);
  });

  test('streams a put to the configured bucket and prefix with length, checksum, metadata, and AES256', async () => {
    let uploaded: Uint8Array = new Uint8Array();
    const client = new RecordingClient(async (command) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      uploaded = await readNodeBody((command as PutObjectCommand).input.Body);
      return { ETag: '"etag-1"' };
    });
    const { store } = makeStore({ client });

    const result = await store.putObject({
      key: 'projects/p/file.png',
      body: new Blob([BYTES]).stream(),
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      metadata: {
        project_id: 'p',
        'Studio-Checksum-Sha256': 'caller-controlled',
        'Studio-Required-Sse': 'caller-controlled',
        'Studio-Required-Kms-Key-Id': 'caller-controlled',
      },
      bucket: 'caller-controlled-bucket',
    } as never);

    const command = client.commands[0] as PutObjectCommand;
    expect(command.input).toMatchObject({
      Bucket: 'configured-private-bucket',
      Key: 'fixed-prefix/projects/p/file.png',
      ContentType: 'image/png',
      ContentLength: BYTES.byteLength,
      ChecksumSHA256: CHECKSUM_BASE64,
      ServerSideEncryption: 'AES256',
      ExpectedBucketOwner: '123456789012',
    });
    expect(command.input.Metadata).toEqual({
      project_id: 'p',
      'studio-checksum-sha256': CHECKSUM_HEX,
    });
    expect(command.input).not.toHaveProperty('SSEKMSKeyId');
    expect(uploaded).toEqual(BYTES);
    expect(result).toEqual({
      namespace: 'configured-private-bucket',
      key: 'projects/p/file.png',
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      etag: '"etag-1"',
      metadata: { project_id: 'p' },
    });
  });

  test('adds the configured KMS key to write and signed-upload commands', async () => {
    const config: StudioS3StorageConfig = {
      ...BASE_CONFIG,
      sse: 'aws:kms',
      kmsKeyId: 'kms-key-id',
    };
    const signedCommands: unknown[] = [];
    const client = consumingClient();
    const { store } = makeStore({
      config,
      client,
      presign: async (_client, command) => {
        signedCommands.push(command);
        return 'https://public-s3.example.test/upload';
      },
    });

    await store.putObject({
      key: 'file.png',
      body: new Blob([BYTES]).stream(),
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      metadata: {},
    });
    await store.createSignedUploadUrl({
      key: 'file.png',
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      expires_in_seconds: 60,
    });

    expect((client.commands[0] as PutObjectCommand).input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kms-key-id',
    });
    expect((signedCommands[0] as PutObjectCommand).input).toMatchObject({
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: 'kms-key-id',
      Metadata: {
        'studio-checksum-sha256': CHECKSUM_HEX,
        'studio-required-sse': 'aws:kms',
        'studio-required-kms-key-id': 'kms-key-id',
      },
    });
  });

  test('normalizes head and get metadata and conditionally deletes the fixed key', async () => {
    const client = new RecordingClient(async (command) => {
      if (command instanceof HeadObjectCommand) return storedOutput();
      if (command instanceof GetObjectCommand) {
        return { ...storedOutput(), Body: Readable.from([BYTES.slice(0, 2), BYTES.slice(2)]) };
      }
      if (command instanceof DeleteObjectCommand) return {};
      throw new Error('unexpected command');
    });
    const { store } = makeStore({ client });

    const head = await store.headObject({ key: 'projects/p/file.png' });
    const object = await store.getObject({ key: 'projects/p/file.png' });
    await store.deleteObject({ key: 'projects/p/file.png', if_match: '"etag-1"' });

    expect(head).toEqual({
      namespace: 'configured-private-bucket',
      key: 'projects/p/file.png',
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      etag: '"etag-1"',
      metadata: { project_id: 'p' },
    });
    expect(await readWebBody(object.body)).toEqual(BYTES);
    expect(client.commands[0]).toBeInstanceOf(HeadObjectCommand);
    expect((client.commands[0] as HeadObjectCommand).input).toMatchObject({
      Bucket: 'configured-private-bucket',
      Key: 'fixed-prefix/projects/p/file.png',
      ChecksumMode: 'ENABLED',
      ExpectedBucketOwner: '123456789012',
    });
    expect(client.commands[1]).toBeInstanceOf(GetObjectCommand);
    expect(client.commands[2]).toBeInstanceOf(HeadObjectCommand);
    expect((client.commands[2] as HeadObjectCommand).input).toMatchObject({
      Bucket: 'configured-private-bucket',
      Key: 'fixed-prefix/projects/p/file.png',
      IfMatch: '"etag-1"',
      ExpectedBucketOwner: '123456789012',
    });
    expect((client.commands[3] as DeleteObjectCommand).input).toMatchObject({
      Bucket: 'configured-private-bucket',
      Key: 'fixed-prefix/projects/p/file.png',
      IfMatch: '"etag-1"',
      ExpectedBucketOwner: '123456789012',
    });
  });

  test('rejects conflicting native and metadata checksums from storage', async () => {
    const client = new RecordingClient(async (command) => {
      if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
      return {
        ...storedOutput(),
        Metadata: {
          ...storedOutput().Metadata,
          'studio-checksum-sha256': '0'.repeat(64),
        },
      };
    });

    await expect(makeStore({ client }).store.headObject({ key: 'file.png' })).rejects.toMatchObject(
      {
        code: 'STUDIO_STORAGE_UNAVAILABLE',
      },
    );
  });

  test('presigns constrained upload and attachment download with the public client and clamped TTLs', async () => {
    const calls: Array<{ client: unknown; command: unknown; expiresIn: number }> = [];
    const signingClient = { endpoint: 'public-signing-client' };
    const { store } = makeStore({
      signingClient,
      presign: async (client, command, options) => {
        calls.push({ client, command, expiresIn: options.expiresIn });
        return `https://public-s3.example.test/signed/${calls.length}`;
      },
    });

    await expect(
      store.createSignedUploadUrl({
        key: 'file.png',
        content_type: 'image/png',
        size_bytes: BYTES.byteLength,
        checksum_sha256: CHECKSUM_HEX,
        expires_in_seconds: 1,
      }),
    ).resolves.toContain('public-s3.example.test');
    await store.createSignedDownloadUrl({
      key: 'file.png',
      filename: '..\\unsafe\r\n"file.png',
      expires_in_seconds: 5_000,
    });

    expect(calls.map((call) => call.client)).toEqual([signingClient, signingClient]);
    expect(calls.map((call) => call.expiresIn)).toEqual([60, 900]);
    expect((calls[0]?.command as PutObjectCommand).input).toMatchObject({
      Bucket: 'configured-private-bucket',
      Key: 'fixed-prefix/file.png',
      ContentType: 'image/png',
      ContentLength: BYTES.byteLength,
      ChecksumSHA256: CHECKSUM_BASE64,
      ServerSideEncryption: 'AES256',
    });
    const disposition = (calls[1]?.command as GetObjectCommand).input.ResponseContentDisposition;
    expect(disposition).toStartWith('attachment;');
    expect(disposition).not.toContain('\r');
    expect(disposition).not.toContain('\n');
    expect(disposition).not.toContain('\\');
    expect(disposition).not.toContain('"file.png');
  });

  test('truncates long Unicode attachment filenames without splitting surrogate pairs', async () => {
    const signedCommands: unknown[] = [];
    const { store } = makeStore({
      presign: async (_client, command) => {
        signedCommands.push(command);
        return 'https://public-s3.example.test/download';
      },
    });

    await expect(
      store.createSignedDownloadUrl({
        key: 'file.png',
        filename: `${'a'.repeat(179)}😀.png`,
        expires_in_seconds: 60,
      }),
    ).resolves.toContain('public-s3.example.test');
    const disposition = (signedCommands[0] as GetObjectCommand).input.ResponseContentDisposition;
    expect(disposition).toContain('%F0%9F%98%80');
  });

  test('maps integrity, not-found, precondition, authorization, and upstream failures without leaking diagnostics', async () => {
    const wrongSize = makeStore({
      client: consumingClient(),
    }).store.putObject({
      key: 'file.png',
      body: new Blob([BYTES]).stream(),
      content_type: 'image/png',
      size_bytes: BYTES.byteLength + 1,
      checksum_sha256: CHECKSUM_HEX,
      metadata: {},
    });
    await expect(wrongSize).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });

    const wrongChecksum = makeStore({ client: consumingClient() }).store.putObject({
      key: 'file.png?X-Amz-Signature=must-not-leak',
      body: new Blob([BYTES]).stream(),
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: '0'.repeat(64),
      metadata: {},
    });
    await expect(wrongChecksum).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(wrongChecksum).rejects.not.toThrow('X-Amz-Signature');

    for (const [error, expectedCode] of [
      [{ name: 'NotFound', $metadata: { httpStatusCode: 404 } }, 'NOT_FOUND'],
      [{ name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } }, 'PRECONDITION_FAILED'],
      [
        {
          name: 'AccessDenied',
          message:
            'https://private.example/file?X-Amz-Credential=leak&X-Amz-Signature=leak token=session-leak',
          $metadata: { httpStatusCode: 403 },
        },
        'STUDIO_STORAGE_UNAVAILABLE',
      ],
      [{ name: 'InternalError', $metadata: { httpStatusCode: 503 } }, 'STUDIO_STORAGE_UNAVAILABLE'],
    ] as const) {
      const client = new RecordingClient(async () => {
        throw error;
      });
      let caught: unknown;
      try {
        if (expectedCode === 'PRECONDITION_FAILED') {
          await makeStore({ client }).store.deleteObject({ key: 'file.png', if_match: 'etag' });
        } else {
          await makeStore({ client }).store.headObject({ key: 'file.png' });
        }
      } catch (failure) {
        caught = failure;
      }
      expect(caught).toMatchObject({ code: expectedCode });
      expect(String(caught)).not.toContain('X-Amz-');
      expect(String(caught)).not.toContain('session-leak');
      expect(String(caught)).not.toContain('private.example');
    }

    const presignFailure = makeStore({
      presign: async () => {
        throw new Error('https://public.example/signed?X-Amz-Signature=leak');
      },
    }).store.createSignedDownloadUrl({
      key: 'file.png',
      filename: 'file.png',
      expires_in_seconds: 60,
    });
    await expect(presignFailure).rejects.toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    await expect(presignFailure).rejects.not.toThrow('public.example');
  });

  test('propagates source stream failures without waiting for the upload consumer timeout', async () => {
    let consumerTimedOut = false;
    const client = new RecordingClient(async (command) => {
      if (!(command instanceof PutObjectCommand)) throw new Error('unexpected command');
      await Promise.race([
        readNodeBody(command.input.Body),
        Bun.sleep(100).then(() => {
          consumerTimedOut = true;
          throw new Error('test upload consumer timed out');
        }),
      ]);
      return { ETag: 'etag' };
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          new Error('https://private.example.test/file?X-Amz-Signature=leak&token=session-leak'),
        );
      },
    });

    const upload = makeStore({ client }).store.putObject({
      key: 'file.png',
      body,
      content_type: 'image/png',
      size_bytes: BYTES.byteLength,
      checksum_sha256: CHECKSUM_HEX,
      metadata: {},
    });

    await expect(upload).rejects.toMatchObject({ code: 'STUDIO_STORAGE_UNAVAILABLE' });
    expect(consumerTimedOut).toBeFalse();
    await expect(upload).rejects.not.toThrow('private.example.test');
  });

  test('rejects an oversized source chunk without waiting for the source to close', async () => {
    let consumerTimedOut = false;
    const client = new RecordingClient(async (command) => {
      if (!(command instanceof PutObjectCommand)) throw new Error('unexpected command');
      await Promise.race([
        readNodeBody(command.input.Body),
        Bun.sleep(100).then(() => {
          consumerTimedOut = true;
          throw new Error('test upload consumer timed out');
        }),
      ]);
      return { ETag: 'etag' };
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(BYTES);
      },
    });

    const upload = makeStore({ client }).store.putObject({
      key: 'file.png',
      body,
      content_type: 'image/png',
      size_bytes: BYTES.byteLength - 1,
      checksum_sha256: CHECKSUM_HEX,
      metadata: {},
    });

    await expect(upload).rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(consumerTimedOut).toBeFalse();
  });

  test('aborts the S3 request and preserves the typed integrity error', async () => {
    let abortSignal: AbortSignal | undefined;
    const client = {
      async send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
        if (!(command instanceof PutObjectCommand)) throw new Error('unexpected command');
        abortSignal = options?.abortSignal;
        try {
          await readNodeBody(command.input.Body);
        } catch {
          expect(abortSignal?.aborted).toBeTrue();
          throw new Error('SDK wrapped the streaming failure');
        }
        return { ETag: 'etag' };
      },
    } as StudioS3Client;
    const store = new S3StudioObjectStore({
      config: BASE_CONFIG,
      client,
      signingClient: {},
      presign: async () => 'https://public-s3.example.test/signed',
      readiness: async () => {},
    });

    await expect(
      store.putObject({
        key: 'file.png',
        body: new Blob([BYTES]).stream(),
        content_type: 'image/png',
        size_bytes: BYTES.byteLength,
        checksum_sha256: '0'.repeat(64),
        metadata: {},
      }),
    ).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    expect(abortSignal?.aborted).toBeTrue();
  });

  test('delegates readiness without invoking it from CRUD methods', async () => {
    let readinessCalls = 0;
    const client = new RecordingClient(async (command) => {
      if (command instanceof HeadObjectCommand) return storedOutput();
      throw new Error('unexpected command');
    });
    const { store } = makeStore({
      client,
      ready: async () => {
        readinessCalls += 1;
      },
    });

    await store.headObject({ key: 'file.png' });
    expect(readinessCalls).toBe(0);
    await store.assertReady();
    expect(readinessCalls).toBe(1);
  });
});

function storedOutput() {
  return {
    ContentType: 'image/png',
    ContentLength: BYTES.byteLength,
    ChecksumSHA256: CHECKSUM_BASE64,
    ETag: '"etag-1"',
    Metadata: {
      project_id: 'p',
      'studio-checksum-sha256': CHECKSUM_HEX,
      'studio-required-sse': 'AES256',
      'studio-required-kms-key-id': 'internal-key-id',
    },
  };
}

function consumingClient(): RecordingClient {
  return new RecordingClient(async (command) => {
    if (command instanceof PutObjectCommand) await readNodeBody(command.input.Body);
    return { ETag: '"etag"' };
  });
}

async function readNodeBody(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(new Uint8Array(chunk));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function readWebBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
