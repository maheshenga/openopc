import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { GetObjectCommand, HeadBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

import { createS3EvidenceStore } from './s3-evidence';

const sha256 = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;

describe('S3 evidence store', () => {
  test('checks the private evidence bucket for readiness', async () => {
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          return {};
        },
      },
    });

    await store.assertReady();

    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(HeadBucketCommand);
    expect((commands[0] as HeadBucketCommand).input).toEqual({ Bucket: 'developer-artifacts' });
  });

  test('writes an SBOM once under an immutable account, run, and digest key', async () => {
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          return {};
        },
      },
    });
    const bytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    const digest = sha256(bytes);

    const reference = await store.putSbom({
      accountId: 'account-1',
      runId: 'run-1',
      digest,
      bytes,
    });

    expect(reference).toEqual({
      kind: 'sbom',
      bucket: 'developer-artifacts',
      storageKey: `developer-trust/evidence/accounts/account-1/runs/run-1/sbom/sha256/${digest.slice('sha256:'.length)}.cdx.json`,
      digest,
      sizeBytes: bytes.byteLength,
      mediaType: 'application/vnd.cyclonedx+json',
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(PutObjectCommand);
    expect((commands[0] as PutObjectCommand).input).toMatchObject({
      Bucket: 'developer-artifacts',
      Key: reference.storageKey,
      Body: bytes,
      ContentLength: bytes.byteLength,
      ContentType: 'application/vnd.cyclonedx+json',
      IfNoneMatch: '*',
    });
    expect((commands[0] as PutObjectCommand).input.ACL).toBeUndefined();
  });

  test('fails closed before writing when the declared digest does not match the bytes', async () => {
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          return {};
        },
      },
    });

    await expect(
      store.putSbom({
        accountId: 'account-1',
        runId: 'run-1',
        digest: `sha256:${'0'.repeat(64)}`,
        bytes: new TextEncoder().encode('{}'),
      }),
    ).rejects.toThrow('DEVELOPER_TRUST_EVIDENCE_DIGEST_MISMATCH');
    expect(commands).toHaveLength(0);
  });

  test('accepts an idempotent retry only after re-reading and verifying the existing bytes', async () => {
    const bytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    const digest = sha256(bytes);
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          if (command instanceof PutObjectCommand) {
            throw Object.assign(new Error('already exists'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            });
          }
          return {
            Body: (async function* () {
              yield bytes.subarray(0, 13);
              yield bytes.subarray(13);
            })(),
            ContentLength: bytes.byteLength,
            ContentType: 'application/vnd.cyclonedx+json',
          };
        },
      },
    });

    const reference = await store.putSbom({
      accountId: 'account-1',
      runId: 'run-1',
      digest,
      bytes,
    });

    expect(reference.digest).toBe(digest);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(GetObjectCommand);
  });

  test('rejects a conditional-write conflict when the existing object is not identical', async () => {
    const bytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    const conflictingBytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","specVersion":"1.6","unavailable":true}',
    );
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          if (command instanceof PutObjectCommand) {
            throw Object.assign(new Error('already exists'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            });
          }
          return {
            Body: (async function* () {
              yield conflictingBytes;
            })(),
            ContentLength: conflictingBytes.byteLength,
            ContentType: 'application/vnd.cyclonedx+json',
          };
        },
      },
    });

    await expect(
      store.putSbom({
        accountId: 'account-1',
        runId: 'run-1',
        digest: sha256(bytes),
        bytes,
      }),
    ).rejects.toThrow('DEVELOPER_TRUST_EVIDENCE_CONTENT_CONFLICT');
  });

  test('reads an SBOM by controlled coordinates and verifies its reference', async () => {
    const bytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    const digest = sha256(bytes);
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          return {
            Body: (async function* () {
              yield bytes;
            })(),
            ContentLength: bytes.byteLength,
            ContentType: 'application/vnd.cyclonedx+json',
          };
        },
      },
    });

    const stored = await store.getSbom({ accountId: 'account-1', runId: 'run-1', digest });

    expect(stored.bytes).toEqual(bytes);
    expect(stored.reference).toMatchObject({ digest, sizeBytes: bytes.byteLength });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toBeInstanceOf(GetObjectCommand);
  });

  test('rejects digest-valid stored bytes that are not a canonical SBOM document', async () => {
    const bytes = new TextEncoder().encode(
      '{ "bomFormat": "CycloneDX", "specVersion": "1.6", "unavailable": true }',
    );
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send() {
          return {
            Body: (async function* () {
              yield bytes;
            })(),
            ContentLength: bytes.byteLength,
            ContentType: 'application/vnd.cyclonedx+json',
          };
        },
      },
    });

    await expect(
      store.getSbom({ accountId: 'account-1', runId: 'run-1', digest: sha256(bytes) }),
    ).rejects.toThrow('DEVELOPER_TRUST_EVIDENCE_DOCUMENT_INVALID');
  });

  test('rejects unsafe evidence coordinates before constructing an object key', async () => {
    const bytes = new TextEncoder().encode(
      '{"bomFormat":"CycloneDX","components":[],"specVersion":"1.6","version":1}',
    );
    const commands: unknown[] = [];
    const store = createS3EvidenceStore({
      bucket: 'developer-artifacts',
      client: {
        async send(command) {
          commands.push(command);
          return {};
        },
      },
    });

    await expect(
      store.putSbom({
        accountId: '../other-account',
        runId: 'run-1',
        digest: sha256(bytes),
        bytes,
      }),
    ).rejects.toThrow('DEVELOPER_TRUST_EVIDENCE_REQUEST_INVALID');
    expect(commands).toHaveLength(0);
  });
});
