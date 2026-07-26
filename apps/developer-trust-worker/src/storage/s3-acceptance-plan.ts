import { createHash, timingSafeEqual } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  moduleBetaAcceptanceObjectKey,
  type ModuleBetaAcceptancePlanV1,
  verifyModuleBetaAcceptancePlan,
} from '@openopc/module-runtime-contracts';

const PLAN_MEDIA_TYPE = 'application/vnd.openopc.module-beta-acceptance-plan.v1+json';
const CONSUMPTION_MEDIA_TYPE =
  'application/vnd.openopc.module-beta-acceptance-consumption.v1+json';
const MAX_PLAN_BYTES = 16 * 1024;
const DEPENDENCY_IDENTITY =
  /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;

interface AcceptanceS3Client {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
}

export interface S3AcceptancePlanConsumer {
  consume(input: {
    accountId: string;
    artifactId: string;
    artifactDigest: `sha256:${string}`;
    runId: string;
  }): Promise<ModuleBetaAcceptancePlanV1 | null>;
}

export class S3AcceptancePlanError extends Error {
  override readonly name = 'S3AcceptancePlanError';

  constructor(readonly code: string) {
    super(code);
  }
}

export function createS3AcceptancePlanConsumer(input: {
  client: AcceptanceS3Client;
  bucket: string;
  key: Uint8Array;
  controllerIdentity: string;
  prefix?: string;
  now?: () => Date;
}): S3AcceptancePlanConsumer {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket) ||
    input.key.byteLength < 32 ||
    input.key.byteLength > 128 ||
    !DEPENDENCY_IDENTITY.test(input.controllerIdentity)
  ) {
    fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_CONFIG_INVALID');
  }
  const key = new Uint8Array(input.key);
  const now = input.now ?? (() => new Date());

  return {
    async consume(claim) {
      let planKey: string;
      let consumptionKey: string;
      try {
        planKey = moduleBetaAcceptanceObjectKey({
          accountId: claim.accountId,
          artifactId: claim.artifactId,
          kind: 'plan',
          prefix: input.prefix,
        });
        consumptionKey = moduleBetaAcceptanceObjectKey({
          accountId: claim.accountId,
          artifactId: claim.artifactId,
          kind: 'consumption',
          prefix: input.prefix,
        });
      } catch {
        fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_BINDING_INVALID');
      }

      let stored: unknown;
      try {
        stored = await input.client.send(
          new GetObjectCommand({ Bucket: input.bucket, Key: planKey, ChecksumMode: 'ENABLED' }),
        );
      } catch (error) {
        if (notFound(error)) return null;
        fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_READ_FAILED');
      }
      let bytes: Uint8Array;
      try {
        bytes = await readObject(stored, PLAN_MEDIA_TYPE, MAX_PLAN_BYTES);
      } catch {
        fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_INVALID');
      }
      let plan: ModuleBetaAcceptancePlanV1;
      try {
        plan = verifyModuleBetaAcceptancePlan(bytes, { key, now: now() });
      } catch {
        fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_INVALID');
      }
      if (
        plan.accountId !== claim.accountId ||
        plan.artifactId !== claim.artifactId ||
        plan.artifactDigest !== claim.artifactDigest ||
        plan.controllerIdentity !== input.controllerIdentity
      ) {
        fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_BINDING_INVALID');
      }

      const planDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const marker = new TextEncoder().encode(
        JSON.stringify({
          acceptanceRunId: plan.acceptanceRunId,
          planDigest,
          registrationId: plan.registrationId,
          runId: claim.runId,
          schemaVersion: 1,
        }),
      );
      try {
        await input.client.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: consumptionKey,
            Body: marker,
            ContentLength: marker.byteLength,
            ContentType: CONSUMPTION_MEDIA_TYPE,
            ChecksumSHA256: createHash('sha256').update(marker).digest('base64'),
            IfNoneMatch: '*',
          }),
        );
      } catch (error) {
        if (!preconditionFailed(error)) {
          fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_CONSUME_FAILED');
        }
        let existing: Uint8Array;
        try {
          const response = await input.client.send(
            new GetObjectCommand({
              Bucket: input.bucket,
              Key: consumptionKey,
              ChecksumMode: 'ENABLED',
            }),
          );
          existing = await readObject(response, CONSUMPTION_MEDIA_TYPE, MAX_PLAN_BYTES);
        } catch {
          fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_ALREADY_CONSUMED');
        }
        if (existing.byteLength !== marker.byteLength || !timingSafeEqual(existing, marker)) {
          fail('DEVELOPER_TRUST_ACCEPTANCE_PLAN_ALREADY_CONSUMED');
        }
      }
      return plan;
    },
  };
}

async function readObject(
  response: unknown,
  mediaType: string,
  maximum: number,
): Promise<Uint8Array> {
  const stored = response as { Body?: unknown; ContentLength?: number; ContentType?: string };
  if (
    stored.ContentType !== mediaType ||
    !Number.isSafeInteger(stored.ContentLength) ||
    Number(stored.ContentLength) < 1 ||
    Number(stored.ContentLength) > maximum
  ) {
    throw new Error('INVALID_OBJECT');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const source = stored.Body as
    | AsyncIterable<Uint8Array>
    | Uint8Array
    | { transformToByteArray(): Promise<Uint8Array> }
    | undefined;
  if (source instanceof Uint8Array) {
    chunks.push(source);
    total = source.byteLength;
  } else if (source && typeof (source as { transformToByteArray?: unknown }).transformToByteArray === 'function') {
    const value = await (source as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    chunks.push(value);
    total = value.byteLength;
  } else if (source && Symbol.asyncIterator in Object(source)) {
    for await (const chunk of source as AsyncIterable<Uint8Array>) {
      if (!(chunk instanceof Uint8Array)) throw new Error('INVALID_OBJECT');
      total += chunk.byteLength;
      if (total > maximum) throw new Error('INVALID_OBJECT');
      chunks.push(chunk);
    }
  } else {
    throw new Error('INVALID_OBJECT');
  }
  if (total !== stored.ContentLength) throw new Error('INVALID_OBJECT');
  return new Uint8Array(Buffer.concat(chunks));
}

function notFound(error: unknown): boolean {
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.$metadata?.httpStatusCode === 404 &&
    ['NoSuchKey', 'NotFound', 'NoSuchObject'].includes(candidate.name ?? candidate.Code ?? '')
  );
}

function preconditionFailed(error: unknown): boolean {
  const candidate = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.$metadata?.httpStatusCode === 412 ||
    ['PreconditionFailed', 'ConditionalRequestConflict'].includes(
      candidate?.name ?? candidate?.Code ?? '',
    )
  );
}

function fail(code: string): never {
  throw new S3AcceptancePlanError(code);
}
