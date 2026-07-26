import { createHash, timingSafeEqual } from 'node:crypto';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  type ModuleBetaAcceptancePlanV1,
  type ModuleBetaArtifactRegistrationRequestV1,
  authenticateModuleBetaAcceptancePlan,
  encodeModuleBetaAcceptancePlan,
  moduleBetaAcceptanceObjectKey,
  verifyModuleBetaAcceptancePlan,
} from '@openopc/module-runtime-contracts';

const PLAN_MEDIA_TYPE = 'application/vnd.openopc.module-beta-acceptance-plan.v1+json';
const CONSUMPTION_MEDIA_TYPE = 'application/vnd.openopc.module-beta-acceptance-consumption.v1+json';
const MAX_PRIVATE_OBJECT_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTENT_TYPES = new Set([
  'application/vnd.openopc.developer-module.v2+json',
  'application/vnd.cyclonedx+json',
]);
const DEPENDENCY_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;

type AcceptanceS3Command =
  | DeleteObjectCommand
  | GetObjectCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | PutObjectCommand;

interface AcceptanceS3Client {
  send(command: AcceptanceS3Command): Promise<unknown>;
}

type AcceptancePlanBinding = {
  acceptanceRunId: string;
  scenario?: ModuleBetaArtifactRegistrationRequestV1['scenario'];
  accountId: string;
  artifactId: string;
  artifactDigest: `sha256:${string}`;
};

export interface S3ModuleBetaAcceptanceStore {
  assertReady(): Promise<void>;
  assertObjectAbsent(storageKey: string): Promise<void>;
  deleteAcceptanceObjects(input: {
    accountId: string;
    artifactIds: readonly string[];
  }): Promise<void>;
  prepareCleanupProbes(input: {
    acceptanceRunId: string;
  }): Promise<ModuleBetaCleanupProbeCoordinates>;
  assertCleanupProbesAbsent(input: { acceptanceRunId: string }): Promise<void>;
  registerPlan(input: ModuleBetaArtifactRegistrationRequestV1): Promise<ModuleBetaAcceptancePlanV1>;
  verifyConsumption(input: {
    acceptanceRunId: string;
    accountId: string;
    artifactId: string;
    artifactDigest: `sha256:${string}`;
    runId: string;
  }): Promise<ModuleBetaAcceptancePlanV1>;
  verifyAndPresignGet(input: {
    storageKey: string;
    expectedDigest: `sha256:${string}`;
    expectedSizeBytes: number;
    expectedContentType:
      | 'application/vnd.openopc.developer-module.v2+json'
      | 'application/vnd.cyclonedx+json';
  }): Promise<string>;
}

export interface ModuleBetaCleanupProbeCoordinates {
  expiredRetention: {
    uploadId: string;
    storageKey: string;
    contentDigest: `sha256:${string}`;
    sizeBytes: number;
  };
  orphanObject: {
    storageKey: string;
    contentDigest: `sha256:${string}`;
    sizeBytes: number;
  };
}

export class S3ModuleBetaAcceptanceError extends Error {
  override readonly name = 'S3ModuleBetaAcceptanceError';

  constructor(readonly code: string) {
    super(code);
  }
}

export function createS3ModuleBetaAcceptanceStore(input: {
  client: AcceptanceS3Client;
  bucket: string;
  serverSideEncryption: 'AES256';
  key: Uint8Array;
  controllerIdentity: string;
  planTtlSeconds: number;
  presignTtlSeconds: number;
  allowedPresignHosts: readonly string[];
  presign(command: GetObjectCommand, expiresIn: number): Promise<string>;
  now?: () => Date;
  randomUuid?: () => string;
}): S3ModuleBetaAcceptanceStore {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    input.serverSideEncryption !== 'AES256' ||
    !(input.key instanceof Uint8Array) ||
    input.key.byteLength < 32 ||
    input.key.byteLength > 128 ||
    !DEPENDENCY_IDENTITY.test(input.controllerIdentity) ||
    !Number.isSafeInteger(input.planTtlSeconds) ||
    input.planTtlSeconds < 60 ||
    input.planTtlSeconds > 900 ||
    !Number.isSafeInteger(input.presignTtlSeconds) ||
    input.presignTtlSeconds < 30 ||
    input.presignTtlSeconds > 900 ||
    input.allowedPresignHosts.length < 1 ||
    input.allowedPresignHosts.length > 32 ||
    new Set(input.allowedPresignHosts).size !== input.allowedPresignHosts.length ||
    input.allowedPresignHosts.some((host) => !safePresignHost(host))
  ) {
    fail('MODULE_BETA_ACCEPTANCE_S3_CONFIG_INVALID');
  }
  const key = new Uint8Array(input.key);
  const allowedPresignHosts = new Set(input.allowedPresignHosts);
  const now = input.now ?? (() => new Date());
  const randomUuid = input.randomUuid ?? crypto.randomUUID;

  const assertObjectAbsent = async (storageKey: string): Promise<void> => {
    if (!safeStorageKey(storageKey)) fail('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');
    try {
      await input.client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: storageKey }));
    } catch (error) {
      if (notFound(error)) return;
      fail('MODULE_BETA_ACCEPTANCE_OBJECT_STATE_UNKNOWN');
    }
    fail('MODULE_BETA_ACCEPTANCE_OBJECT_STILL_PRESENT');
  };

  const readPlan = async (
    request: AcceptancePlanBinding,
    objectKey: string,
    requireActive = true,
  ): Promise<ModuleBetaAcceptancePlanV1 | null> => {
    let response: unknown;
    try {
      response = await input.client.send(
        new GetObjectCommand({ Bucket: input.bucket, Key: objectKey, ChecksumMode: 'ENABLED' }),
      );
    } catch (error) {
      if (notFound(error)) return null;
      fail('MODULE_BETA_ACCEPTANCE_PLAN_READ_FAILED');
    }
    let plan: ModuleBetaAcceptancePlanV1;
    try {
      const bytes = await readPrivateObject(response, PLAN_MEDIA_TYPE);
      plan = requireActive
        ? verifyModuleBetaAcceptancePlan(bytes, { key, now: now() })
        : authenticateModuleBetaAcceptancePlan(bytes, key);
    } catch {
      fail('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    }
    assertPlanBinding(plan, request, input.controllerIdentity);
    return plan;
  };

  return {
    async assertReady() {
      try {
        await input.client.send(new HeadBucketCommand({ Bucket: input.bucket }));
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_S3_UNAVAILABLE');
      }
    },

    assertObjectAbsent,

    async registerPlan(request) {
      let objectKey: string;
      try {
        objectKey = moduleBetaAcceptanceObjectKey({
          accountId: request.accountId,
          artifactId: request.artifactId,
          kind: 'plan',
        });
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_PLAN_BINDING_INVALID');
      }
      const existing = await readPlan(request, objectKey);
      if (existing) return existing;

      const issuedAt = now();
      if (!Number.isFinite(issuedAt.valueOf())) fail('MODULE_BETA_ACCEPTANCE_CLOCK_INVALID');
      const plan: ModuleBetaAcceptancePlanV1 = {
        schemaVersion: 1,
        registrationId: randomUuid(),
        acceptanceRunId: request.acceptanceRunId,
        scenario: request.scenario,
        accountId: request.accountId,
        artifactId: request.artifactId,
        artifactDigest: request.artifactDigest,
        issuedAt: issuedAt.toISOString(),
        expiresAt: new Date(issuedAt.valueOf() + input.planTtlSeconds * 1_000).toISOString(),
        controllerIdentity: input.controllerIdentity,
      };
      let bytes: Uint8Array;
      try {
        bytes = encodeModuleBetaAcceptancePlan(plan, key);
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
      }
      try {
        await input.client.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: objectKey,
            Body: bytes,
            ContentLength: bytes.byteLength,
            ContentType: PLAN_MEDIA_TYPE,
            CacheControl: 'no-store',
            ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
            IfNoneMatch: '*',
          }),
        );
        return plan;
      } catch (error) {
        if (!preconditionFailed(error)) fail('MODULE_BETA_ACCEPTANCE_PLAN_WRITE_FAILED');
      }
      const winner = await readPlan(request, objectKey);
      if (!winner) fail('MODULE_BETA_ACCEPTANCE_PLAN_WRITE_FAILED');
      return winner;
    },

    async verifyConsumption(request) {
      if (!UUID.test(request.runId) || !DIGEST.test(request.artifactDigest)) {
        fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      }
      let planKey: string;
      let consumptionKey: string;
      try {
        planKey = moduleBetaAcceptanceObjectKey({
          accountId: request.accountId,
          artifactId: request.artifactId,
          kind: 'plan',
        });
        consumptionKey = moduleBetaAcceptanceObjectKey({
          accountId: request.accountId,
          artifactId: request.artifactId,
          kind: 'consumption',
        });
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      }
      const plan = await readPlan(request, planKey, false);
      if (!plan) fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      let stored: unknown;
      try {
        stored = await input.client.send(
          new GetObjectCommand({
            Bucket: input.bucket,
            Key: consumptionKey,
            ChecksumMode: 'ENABLED',
          }),
        );
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      }
      let marker: Uint8Array;
      try {
        marker = await readPrivateObject(stored, CONSUMPTION_MEDIA_TYPE);
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      }
      const planBytes = encodeModuleBetaAcceptancePlan(plan, key);
      const expected = new TextEncoder().encode(
        JSON.stringify({
          acceptanceRunId: plan.acceptanceRunId,
          planDigest: `sha256:${createHash('sha256').update(planBytes).digest('hex')}`,
          registrationId: plan.registrationId,
          runId: request.runId,
          schemaVersion: 1,
        }),
      );
      if (marker.byteLength !== expected.byteLength || !timingSafeEqual(marker, expected)) {
        fail('MODULE_BETA_ACCEPTANCE_CONSUMPTION_INVALID');
      }
      return plan;
    },

    async verifyAndPresignGet(request) {
      if (
        !safeStorageKey(request.storageKey) ||
        !DIGEST.test(request.expectedDigest) ||
        !Number.isSafeInteger(request.expectedSizeBytes) ||
        request.expectedSizeBytes < 1 ||
        request.expectedSizeBytes > 512 * 1024 * 1024 ||
        !CONTENT_TYPES.has(request.expectedContentType)
      ) {
        fail('MODULE_BETA_ACCEPTANCE_OBJECT_IDENTITY_INVALID');
      }
      let head: unknown;
      try {
        head = await input.client.send(
          new HeadObjectCommand({
            Bucket: input.bucket,
            Key: request.storageKey,
            ChecksumMode: 'ENABLED',
          }),
        );
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_OBJECT_IDENTITY_INVALID');
      }
      const stored = head as {
        ContentLength?: number;
        ContentType?: string;
        ChecksumSHA256?: string;
        Metadata?: Record<string, string | undefined>;
      };
      const expectedHex = request.expectedDigest.slice('sha256:'.length);
      const nativeChecksum = base64Sha256(stored.ChecksumSHA256);
      const metadataValue = stored.Metadata?.['studio-checksum-sha256'];
      const metadataChecksum =
        metadataValue === undefined || /^[0-9a-f]{64}$/.test(metadataValue) ? metadataValue : null;
      if (
        stored.ContentLength !== request.expectedSizeBytes ||
        stored.ContentType !== request.expectedContentType ||
        (stored.ChecksumSHA256 !== undefined && nativeChecksum === null) ||
        (nativeChecksum === null && metadataChecksum === undefined) ||
        (nativeChecksum !== null && nativeChecksum !== expectedHex) ||
        metadataChecksum === null ||
        (metadataChecksum !== undefined && metadataChecksum !== expectedHex)
      ) {
        fail('MODULE_BETA_ACCEPTANCE_OBJECT_IDENTITY_INVALID');
      }
      let value: string;
      try {
        value = await input.presign(
          new GetObjectCommand({ Bucket: input.bucket, Key: request.storageKey }),
          input.presignTtlSeconds,
        );
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_PRESIGN_FAILED');
      }
      try {
        const url = new URL(value);
        if (
          url.protocol !== 'https:' ||
          !allowedPresignHosts.has(url.hostname) ||
          url.port !== '' ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname === '/'
        ) {
          fail('MODULE_BETA_ACCEPTANCE_PRESIGN_INVALID');
        }
      } catch (error) {
        if (error instanceof S3ModuleBetaAcceptanceError) throw error;
        fail('MODULE_BETA_ACCEPTANCE_PRESIGN_INVALID');
      }
      return value;
    },

    async deleteAcceptanceObjects(request) {
      if (
        request.artifactIds.length > 128 ||
        new Set(request.artifactIds).size !== request.artifactIds.length
      ) {
        fail('MODULE_BETA_ACCEPTANCE_CLEANUP_BINDING_INVALID');
      }
      const objectKeys: string[] = [];
      try {
        for (const artifactId of request.artifactIds) {
          objectKeys.push(
            moduleBetaAcceptanceObjectKey({
              accountId: request.accountId,
              artifactId,
              kind: 'plan',
            }),
            moduleBetaAcceptanceObjectKey({
              accountId: request.accountId,
              artifactId,
              kind: 'consumption',
            }),
          );
        }
      } catch {
        fail('MODULE_BETA_ACCEPTANCE_CLEANUP_BINDING_INVALID');
      }
      for (const objectKey of objectKeys) {
        try {
          await input.client.send(
            new DeleteObjectCommand({ Bucket: input.bucket, Key: objectKey }),
          );
        } catch {
          fail('MODULE_BETA_ACCEPTANCE_CLEANUP_DELETE_FAILED');
        }
      }
      for (const objectKey of objectKeys) await assertObjectAbsent(objectKey);
    },

    async prepareCleanupProbes(request) {
      const coordinates = moduleBetaCleanupProbeCoordinates(request.acceptanceRunId);
      const runProbe = async (
        kind: 'expired-retention' | 'orphan',
        storageKey: string,
      ): Promise<void> => {
        const bytes = cleanupProbeBytes(request.acceptanceRunId, kind);
        try {
          await input.client.send(
            new PutObjectCommand({
              Bucket: input.bucket,
              Key: storageKey,
              Body: bytes,
              ContentLength: bytes.byteLength,
              ContentType: 'application/json',
              CacheControl: 'no-store',
              ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
              IfNoneMatch: '*',
              ServerSideEncryption: input.serverSideEncryption,
            }),
          );
        } catch (error) {
          if (!preconditionFailed(error)) {
            fail('MODULE_BETA_ACCEPTANCE_CLEANUP_PROBE_FAILED');
          }
          let existing: Uint8Array;
          try {
            existing = await readPrivateObject(
              await input.client.send(
                new GetObjectCommand({
                  Bucket: input.bucket,
                  Key: storageKey,
                  ChecksumMode: 'ENABLED',
                }),
              ),
              'application/json',
            );
          } catch {
            fail('MODULE_BETA_ACCEPTANCE_CLEANUP_PROBE_FAILED');
          }
          if (existing.byteLength !== bytes.byteLength || !timingSafeEqual(existing, bytes)) {
            fail('MODULE_BETA_ACCEPTANCE_CLEANUP_PROBE_FAILED');
          }
        }
        try {
          await input.client.send(
            new HeadObjectCommand({
              Bucket: input.bucket,
              Key: storageKey,
              ChecksumMode: 'ENABLED',
            }),
          );
        } catch {
          fail('MODULE_BETA_ACCEPTANCE_CLEANUP_PROBE_FAILED');
        }
      };
      await runProbe('expired-retention', coordinates.expiredRetention.storageKey);
      await runProbe('orphan', coordinates.orphanObject.storageKey);
      return coordinates;
    },

    async assertCleanupProbesAbsent(request) {
      const coordinates = moduleBetaCleanupProbeCoordinates(request.acceptanceRunId);
      await assertObjectAbsent(coordinates.expiredRetention.storageKey);
      await assertObjectAbsent(coordinates.orphanObject.storageKey);
    },
  };
}

export function moduleBetaCleanupProbeCoordinates(
  acceptanceRunId: string,
): ModuleBetaCleanupProbeCoordinates {
  if (!RUN_ID.test(acceptanceRunId)) {
    fail('MODULE_BETA_ACCEPTANCE_CLEANUP_BINDING_INVALID');
  }
  const runPartition = createHash('sha256')
    .update(`openopc-module-beta-cleanup\0${acceptanceRunId}`, 'utf8')
    .digest('hex');
  const expiredBytes = cleanupProbeBytes(acceptanceRunId, 'expired-retention');
  const orphanBytes = cleanupProbeBytes(acceptanceRunId, 'orphan');
  const prefix = `developer-modules/staging/acceptance-probes/${runPartition}`;
  return {
    expiredRetention: {
      uploadId: deterministicProbeUuid(acceptanceRunId),
      storageKey: `${prefix}/expired-retention.v1.json`,
      contentDigest: sha256(expiredBytes),
      sizeBytes: expiredBytes.byteLength,
    },
    orphanObject: {
      storageKey: `${prefix}/orphan.v1.json`,
      contentDigest: sha256(orphanBytes),
      sizeBytes: orphanBytes.byteLength,
    },
  };
}

function cleanupProbeBytes(
  acceptanceRunId: string,
  kind: 'expired-retention' | 'orphan',
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ acceptanceRunId, kind, schemaVersion: 1 }));
}

function deterministicProbeUuid(acceptanceRunId: string): string {
  const hex = createHash('sha256')
    .update(`openopc-module-beta-expired-upload\0${acceptanceRunId}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '4';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16] ?? '0', 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertPlanBinding(
  plan: ModuleBetaAcceptancePlanV1,
  request: AcceptancePlanBinding,
  controllerIdentity: string,
): void {
  if (
    plan.acceptanceRunId !== request.acceptanceRunId ||
    (request.scenario !== undefined && plan.scenario !== request.scenario) ||
    plan.accountId !== request.accountId ||
    plan.artifactId !== request.artifactId ||
    plan.artifactDigest !== request.artifactDigest ||
    plan.controllerIdentity !== controllerIdentity
  ) {
    fail('MODULE_BETA_ACCEPTANCE_PLAN_BINDING_INVALID');
  }
}

async function readPrivateObject(response: unknown, mediaType: string): Promise<Uint8Array> {
  const stored = response as { Body?: unknown; ContentLength?: number; ContentType?: string };
  if (
    stored.ContentType !== mediaType ||
    !Number.isSafeInteger(stored.ContentLength) ||
    Number(stored.ContentLength) < 1 ||
    Number(stored.ContentLength) > MAX_PRIVATE_OBJECT_BYTES
  ) {
    throw new Error('INVALID_PRIVATE_OBJECT');
  }
  const source = stored.Body as
    | Uint8Array
    | AsyncIterable<Uint8Array>
    | { transformToByteArray(): Promise<Uint8Array> }
    | undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (source instanceof Uint8Array) {
    chunks.push(source);
    total = source.byteLength;
  } else if (
    source &&
    typeof (source as { transformToByteArray?: unknown }).transformToByteArray === 'function'
  ) {
    const bytes = await (
      source as { transformToByteArray(): Promise<Uint8Array> }
    ).transformToByteArray();
    chunks.push(bytes);
    total = bytes.byteLength;
  } else if (source && Symbol.asyncIterator in Object(source)) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) throw new Error('INVALID_PRIVATE_OBJECT');
      total += chunk.byteLength;
      if (total > MAX_PRIVATE_OBJECT_BYTES) throw new Error('INVALID_PRIVATE_OBJECT');
      chunks.push(chunk);
    }
  } else {
    throw new Error('INVALID_PRIVATE_OBJECT');
  }
  if (total !== stored.ContentLength) throw new Error('INVALID_PRIVATE_OBJECT');
  return new Uint8Array(Buffer.concat(chunks));
}

function notFound(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.$metadata?.httpStatusCode === 404 &&
    ['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(candidate.name ?? candidate.Code ?? '')
  );
}

function preconditionFailed(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate?.$metadata?.httpStatusCode === 412 ||
    ['PreconditionFailed', 'ConditionalRequestConflict'].includes(
      candidate?.name ?? candidate?.Code ?? '',
    )
  );
}

function safePresignHost(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.includes(':') ||
    /prod(?:uction)?/i.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && url.pathname === '/';
  } catch {
    return false;
  }
}

function safeStorageKey(value: string): boolean {
  return (
    Buffer.byteLength(value, 'utf8') >= 1 &&
    Buffer.byteLength(value, 'utf8') <= 2_048 &&
    !value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\0\r\n]/.test(value) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function base64Sha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    return bytes.byteLength === 32 && bytes.toString('base64') === value
      ? bytes.toString('hex')
      : null;
  } catch {
    return null;
  }
}

function fail(code: string): never {
  throw new S3ModuleBetaAcceptanceError(code);
}
