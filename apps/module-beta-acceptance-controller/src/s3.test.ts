import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { moduleBetaAcceptanceObjectKey } from '@openopc/module-runtime-contracts';

import { createS3ModuleBetaAcceptanceStore } from './s3';

const now = new Date('2026-07-26T12:00:00.000Z');
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;
const request = {
  schemaVersion: 1,
  acceptanceRunId: 'gha:12345:1',
  scenario: 'clean-wasi',
  accountId,
  artifactId,
  artifactDigest,
} as const;

const consumptionMediaType = 'application/vnd.openopc.module-beta-acceptance-consumption.v1+json';

describe('module beta acceptance S3 store', () => {
  test('rejects any server-side encryption mode other than AES256', () => {
    expect(() =>
      createS3ModuleBetaAcceptanceStore({
        bucket: 'developer-artifacts',
        serverSideEncryption: 'aws:kms' as 'AES256',
        key: new Uint8Array(32).fill(7),
        controllerIdentity,
        planTtlSeconds: 600,
        presignTtlSeconds: 300,
        presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
        allowedPresignHosts: ['minio.staging.openopc.example'],
        client: { async send() {} },
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_S3_CONFIG_INVALID');
  });

  test('creates one private signed plan and returns it idempotently', async () => {
    let object: Uint8Array | null = null;
    let writes = 0;
    let ids = 0;
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      now: () => now,
      randomUuid: () => {
        ids += 1;
        return '40000000-0000-4000-a000-000000000004';
      },
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          if (command instanceof GetObjectCommand) {
            if (!object) {
              throw Object.assign(new Error('missing'), {
                name: 'NoSuchKey',
                $metadata: { httpStatusCode: 404 },
              });
            }
            return {
              Body: object,
              ContentLength: object.byteLength,
              ContentType: 'application/vnd.openopc.module-beta-acceptance-plan.v1+json',
            };
          }
          if (command instanceof PutObjectCommand) {
            writes += 1;
            object = new Uint8Array(command.input.Body as Uint8Array);
            return {};
          }
          throw new Error('unexpected command');
        },
      },
    });

    const first = await store.registerPlan(request);
    const second = await store.registerPlan(request);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      acceptanceRunId: request.acceptanceRunId,
      registrationId: '40000000-0000-4000-a000-000000000004',
      issuedAt: '2026-07-26T12:00:00.000Z',
      expiresAt: '2026-07-26T12:10:00.000Z',
      controllerIdentity,
    });
    expect(writes).toBe(1);
    expect(ids).toBe(1);
  });

  test('verifies the exact worker consumption marker binding', async () => {
    const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
    let currentTime = now;
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      now: () => currentTime,
      randomUuid: () => '40000000-0000-4000-a000-000000000004',
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          const objectKey = command instanceof HeadBucketCommand ? undefined : command.input.Key;
          if (command instanceof GetObjectCommand) {
            const object = objectKey ? objects.get(objectKey) : undefined;
            if (!object) {
              throw Object.assign(new Error('missing'), {
                name: 'NoSuchKey',
                $metadata: { httpStatusCode: 404 },
              });
            }
            return {
              Body: object.bytes,
              ContentLength: object.bytes.byteLength,
              ContentType: object.contentType,
            };
          }
          if (command instanceof PutObjectCommand && objectKey) {
            objects.set(objectKey, {
              bytes: new Uint8Array(command.input.Body as Uint8Array),
              contentType: command.input.ContentType ?? '',
            });
            return {};
          }
          throw new Error('unexpected command');
        },
      },
    });
    const plan = await store.registerPlan(request);
    const planKey = moduleBetaAcceptanceObjectKey({ accountId, artifactId, kind: 'plan' });
    const planBytes = objects.get(planKey)?.bytes;
    if (!planBytes) throw new Error('missing test plan');
    const consumptionKey = moduleBetaAcceptanceObjectKey({
      accountId,
      artifactId,
      kind: 'consumption',
    });
    const marker = new TextEncoder().encode(
      JSON.stringify({
        acceptanceRunId: request.acceptanceRunId,
        planDigest: `sha256:${createHash('sha256').update(planBytes).digest('hex')}`,
        registrationId: plan.registrationId,
        runId: '30000000-0000-4000-a000-000000000003',
        schemaVersion: 1,
      }),
    );
    objects.set(consumptionKey, { bytes: marker, contentType: consumptionMediaType });

    await expect(
      store.verifyConsumption({
        acceptanceRunId: request.acceptanceRunId,
        accountId,
        artifactId,
        artifactDigest,
        runId: '30000000-0000-4000-a000-000000000003',
      }),
    ).resolves.toEqual(plan);

    currentTime = new Date('2026-07-26T12:30:00.000Z');
    await expect(
      store.verifyConsumption({
        acceptanceRunId: request.acceptanceRunId,
        accountId,
        artifactId,
        artifactDigest,
        runId: '30000000-0000-4000-a000-000000000003',
      }),
    ).resolves.toEqual(plan);

    const conflicting = new TextEncoder().encode(
      new TextDecoder().decode(marker).replace('000000000003', '000000000099'),
    );
    objects.set(consumptionKey, { bytes: conflicting, contentType: consumptionMediaType });
    await expect(
      store.verifyConsumption({
        acceptanceRunId: request.acceptanceRunId,
        accountId,
        artifactId,
        artifactDigest,
        runId: '30000000-0000-4000-a000-000000000003',
      }),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
  });

  test('returns presigned GET URLs only over HTTPS on a pinned host', async () => {
    const signed: Array<{ command: GetObjectCommand; expiresIn: number }> = [];
    const contentDigest = `sha256:${'f'.repeat(64)}` as const;
    const contentType = 'application/vnd.openopc.developer-module.v2+json';
    const createStore = (url: string) =>
      createS3ModuleBetaAcceptanceStore({
        bucket: 'developer-artifacts',
        serverSideEncryption: 'AES256',
        key: new Uint8Array(32).fill(7),
        controllerIdentity,
        planTtlSeconds: 600,
        presignTtlSeconds: 300,
        now: () => now,
        randomUuid: () => '40000000-0000-4000-a000-000000000004',
        presign: async (command, expiresIn) => {
          signed.push({ command, expiresIn });
          return url;
        },
        allowedPresignHosts: ['minio.staging.openopc.example'],
        client: {
          async send(command) {
            if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
            return {
              ContentLength: 128,
              ContentType: contentType,
              ChecksumSHA256: Buffer.from(contentDigest.slice('sha256:'.length), 'hex').toString(
                'base64',
              ),
              Metadata: { 'studio-checksum-sha256': contentDigest.slice('sha256:'.length) },
            };
          },
        },
      });

    await expect(
      createStore(
        'https://minio.staging.openopc.example/evidence/object?X-Amz-Signature=opaque',
      ).verifyAndPresignGet({
        storageKey: 'developer-trust/evidence/object',
        expectedDigest: contentDigest,
        expectedSizeBytes: 128,
        expectedContentType: contentType,
      }),
    ).resolves.toBe('https://minio.staging.openopc.example/evidence/object?X-Amz-Signature=opaque');
    expect(signed[0]?.command).toBeInstanceOf(GetObjectCommand);
    expect(signed[0]?.command.input).toEqual({
      Bucket: 'developer-artifacts',
      Key: 'developer-trust/evidence/object',
    });
    expect(signed[0]?.expiresIn).toBe(300);

    for (const url of [
      'http://minio.staging.openopc.example/evidence/object?X-Amz-Signature=opaque',
      'https://other.internal/evidence/object?X-Amz-Signature=opaque',
      'https://minio.staging.openopc.example:444/evidence/object?X-Amz-Signature=opaque',
    ]) {
      await expect(
        createStore(url).verifyAndPresignGet({
          storageKey: 'developer-trust/evidence/object',
          expectedDigest: contentDigest,
          expectedSizeBytes: 128,
          expectedContentType: contentType,
        }),
      ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_PRESIGN_INVALID');
    }
  });

  test('refuses to presign an object whose stored identity does not match evidence', async () => {
    const contentDigest = `sha256:${'f'.repeat(64)}` as const;
    const contentType = 'application/vnd.cyclonedx+json';
    const valid = {
      ContentLength: 64,
      ContentType: contentType,
      ChecksumSHA256: Buffer.from(contentDigest.slice('sha256:'.length), 'hex').toString('base64'),
      Metadata: { 'studio-checksum-sha256': contentDigest.slice('sha256:'.length) },
    };
    const candidates = [
      { ...valid, ContentLength: 63 },
      { ...valid, ContentType: 'application/json' },
      { ...valid, ChecksumSHA256: Buffer.from('0'.repeat(64), 'hex').toString('base64') },
      { ...valid, Metadata: { 'studio-checksum-sha256': '0'.repeat(64) } },
      { ContentLength: 64, ContentType: contentType },
    ];

    for (const stored of candidates) {
      let presignCalls = 0;
      const store = createS3ModuleBetaAcceptanceStore({
        bucket: 'developer-artifacts',
        serverSideEncryption: 'AES256',
        key: new Uint8Array(32).fill(7),
        controllerIdentity,
        planTtlSeconds: 600,
        presignTtlSeconds: 300,
        presign: async () => {
          presignCalls += 1;
          return 'https://minio.staging.openopc.example/object?signature=opaque';
        },
        allowedPresignHosts: ['minio.staging.openopc.example'],
        client: {
          async send(command) {
            if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
            return stored;
          },
        },
      });

      await expect(
        store.verifyAndPresignGet({
          storageKey: 'developer-trust/evidence/object',
          expectedDigest: contentDigest,
          expectedSizeBytes: 64,
          expectedContentType: contentType,
        }),
      ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_IDENTITY_INVALID');
      expect(presignCalls).toBe(0);
    }
  });

  test('rejects a malformed native checksum even when metadata matches evidence', async () => {
    const contentDigest = `sha256:${'f'.repeat(64)}` as const;
    const contentType = 'application/vnd.cyclonedx+json';
    let presignCalls = 0;
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      presign: async () => {
        presignCalls += 1;
        return 'https://minio.staging.openopc.example/object?signature=opaque';
      },
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
          return {
            ContentLength: 64,
            ContentType: contentType,
            ChecksumSHA256: 'not-a-canonical-sha256-checksum',
            Metadata: { 'studio-checksum-sha256': contentDigest.slice('sha256:'.length) },
          };
        },
      },
    });

    await expect(
      store.verifyAndPresignGet({
        storageKey: 'developer-trust/evidence/object',
        expectedDigest: contentDigest,
        expectedSizeBytes: 64,
        expectedContentType: contentType,
      }),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_IDENTITY_INVALID');
    expect(presignCalls).toBe(0);
  });

  test('checks bucket readiness through S3', async () => {
    const commands: unknown[] = [];
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          commands.push(command);
          return {};
        },
      },
    });

    await expect(store.assertReady()).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(HeadBucketCommand);
    expect((commands[0] as HeadBucketCommand).input).toEqual({ Bucket: 'developer-artifacts' });
  });

  test('proves a cancelled staging object is absent instead of deleting it', async () => {
    let exists = false;
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          if (!(command instanceof HeadObjectCommand)) throw new Error('unexpected command');
          if (exists) return {};
          throw Object.assign(new Error('missing'), {
            name: 'NotFound',
            $metadata: { httpStatusCode: 404 },
          });
        },
      },
    });

    await expect(
      store.assertObjectAbsent('developer-modules/staging/partition/cancelled'),
    ).resolves.toBeUndefined();
    exists = true;
    await expect(
      store.assertObjectAbsent('developer-modules/staging/partition/cancelled'),
    ).rejects.toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_STILL_PRESENT');
  });

  test('deletes deterministic plan and consumption markers and confirms absence', async () => {
    const planKey = moduleBetaAcceptanceObjectKey({ accountId, artifactId, kind: 'plan' });
    const consumptionKey = moduleBetaAcceptanceObjectKey({
      accountId,
      artifactId,
      kind: 'consumption',
    });
    const objects = new Set([planKey, consumptionKey]);
    const commands: unknown[] = [];
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          commands.push(command);
          const objectKey = command instanceof HeadBucketCommand ? undefined : command.input.Key;
          if (command instanceof DeleteObjectCommand && objectKey) {
            objects.delete(objectKey);
            return {};
          }
          if (command instanceof HeadObjectCommand && objectKey && !objects.has(objectKey)) {
            throw Object.assign(new Error('missing'), {
              name: 'NotFound',
              $metadata: { httpStatusCode: 404 },
            });
          }
          throw new Error('unexpected command');
        },
      },
    });

    await expect(
      store.deleteAcceptanceObjects({ accountId, artifactIds: [artifactId] }),
    ).resolves.toBeUndefined();
    expect(objects.size).toBe(0);
    expect(
      commands
        .filter((command) => command instanceof DeleteObjectCommand)
        .map((command) => command.input.Key),
    ).toEqual([planKey, consumptionKey]);
    expect(commands.filter((command) => command instanceof HeadObjectCommand)).toHaveLength(2);
  });

  test('prepares retention probes without deleting them before the worker runs', async () => {
    const objects = new Set<string>();
    const commands: unknown[] = [];
    const ids = ['70000000-0000-4000-a000-000000000007', '80000000-0000-4000-a000-000000000008'];
    const store = createS3ModuleBetaAcceptanceStore({
      bucket: 'developer-artifacts',
      serverSideEncryption: 'AES256',
      key: new Uint8Array(32).fill(7),
      controllerIdentity,
      planTtlSeconds: 600,
      presignTtlSeconds: 300,
      now: () => now,
      randomUuid: () => ids.shift() ?? '90000000-0000-4000-a000-000000000009',
      presign: async () => 'https://minio.staging.openopc.example/object?signature=opaque',
      allowedPresignHosts: ['minio.staging.openopc.example'],
      client: {
        async send(command) {
          commands.push(command);
          const objectKey = command instanceof HeadBucketCommand ? undefined : command.input.Key;
          if (command instanceof PutObjectCommand && objectKey) {
            objects.add(objectKey);
            return {};
          }
          if (command instanceof HeadObjectCommand && objectKey) {
            if (!objects.has(objectKey)) {
              throw Object.assign(new Error('missing'), {
                name: 'NotFound',
                $metadata: { httpStatusCode: 404 },
              });
            }
            return {};
          }
          throw new Error('unexpected command');
        },
      },
    });

    await expect(
      store.prepareCleanupProbes({ acceptanceRunId: request.acceptanceRunId }),
    ).resolves.toMatchObject({
      expiredRetention: {
        storageKey: expect.stringMatching(/^developer-modules\/staging\/acceptance-probes\//),
      },
      orphanObject: {
        storageKey: expect.stringMatching(/^developer-modules\/staging\/acceptance-probes\//),
      },
    });
    expect(objects.size).toBe(2);
    const puts = commands.filter((command) => command instanceof PutObjectCommand);
    expect(puts).toHaveLength(2);
    for (const command of puts) {
      expect(command.input.ServerSideEncryption).toBe('AES256');
      expect(command.input.SSEKMSKeyId).toBeUndefined();
    }
    expect(commands.filter((command) => command instanceof DeleteObjectCommand)).toHaveLength(0);
    expect(commands.filter((command) => command instanceof HeadObjectCommand)).toHaveLength(2);
  });
});
