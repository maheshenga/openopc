import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { createS3ArtifactReader } from './s3-artifacts';

const workspaces: string[] = [];
const digest = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('S3 artifact reader', () => {
  test('streams, re-hashes, and materializes a private canonical artifact', async () => {
    const packageBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [
          {
            bytes: `base64:${Buffer.from('export const ready = true;').toString('base64')}`,
            mediaType: 'text/typescript',
            path: 'src/index.ts',
            target: 'src/index.ts',
          },
        ],
        formatVersion: 2,
        item: { id: 'acme.clean', version: '1.0.0' },
        lockGraph: null,
        mediaType: 'application/vnd.openopc.developer-module.v2+json',
        source: null,
      }),
    );
    const commands: unknown[] = [];
    const reader = createS3ArtifactReader({
      bucket: 'developer-artifacts',
      maxArtifactBytes: 1024 * 1024,
      workspaceRoot: tmpdir(),
      client: {
        async send(command) {
          commands.push(command);
          return {
            Body: (async function* () {
              yield packageBytes.subarray(0, 17);
              yield packageBytes.subarray(17);
            })(),
            ContentLength: packageBytes.byteLength,
          };
        },
      },
    });

    const prepared = await reader.prepare({
      storageKey: 'developer-modules/artifacts/private/content',
      expectedDigest: digest(packageBytes),
      expectedSize: packageBytes.byteLength,
    });
    workspaces.push(prepared.workspacePath);

    expect(commands).toHaveLength(1);
    expect(prepared.lockGraph).toBeNull();
    expect(await Bun.file(`${prepared.workspacePath}/src/index.ts`).text()).toBe(
      'export const ready = true;',
    );
  });

  const s3Endpoint = process.env.DEVELOPER_TRUST_S3_ENDPOINT;
  const s3IntegrationTest = s3Endpoint ? test : test.skip;
  s3IntegrationTest('reads and re-hashes a private MinIO object', async () => {
    const bucket = process.env.DEVELOPER_TRUST_S3_BUCKET ?? 'developer-artifacts';
    const client = new S3Client({
      endpoint: s3Endpoint,
      region: process.env.DEVELOPER_TRUST_S3_REGION ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.DEVELOPER_TRUST_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.DEVELOPER_TRUST_S3_SECRET_ACCESS_KEY ?? '',
      },
    });
    const packageBytes = new TextEncoder().encode(
      JSON.stringify({
        files: [],
        formatVersion: 2,
        item: { id: 'acme.clean', version: '1.0.0' },
        lockGraph: null,
        mediaType: 'application/vnd.openopc.developer-module.v2+json',
        source: null,
      }),
    );
    const key = `developer-modules/artifacts/acceptance/${randomUUID()}`;
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: packageBytes }));
    const reader = createS3ArtifactReader({
      client,
      bucket,
      maxArtifactBytes: 1024 * 1024,
      workspaceRoot: process.env.TEMP ?? '/tmp',
    });
    let workspacePath: string | undefined;
    try {
      const prepared = await reader.prepare({
        storageKey: key,
        expectedDigest: digest(packageBytes),
        expectedSize: packageBytes.byteLength,
      });
      workspacePath = prepared.workspacePath;
      expect(prepared.lockGraph).toBeNull();
    } finally {
      if (workspacePath) await reader.release(workspacePath);
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      client.destroy();
    }
  });
});
