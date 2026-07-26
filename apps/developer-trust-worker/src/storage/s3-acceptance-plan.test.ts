import { describe, expect, test } from 'bun:test';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  encodeModuleBetaAcceptancePlan,
  moduleBetaAcceptanceObjectKey,
  type ModuleBetaAcceptancePlanV1,
} from '@openopc/module-runtime-contracts';

import { createS3AcceptancePlanConsumer } from './s3-acceptance-plan';

const now = new Date('2026-07-26T12:00:00.000Z');
const key = new Uint8Array(32).fill(7);
const accountId = '10000000-0000-4000-a000-000000000001';
const artifactId = '20000000-0000-4000-a000-000000000002';
const runId = '30000000-0000-4000-a000-000000000003';
const artifactDigest = `sha256:${'a'.repeat(64)}` as const;
const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;

function plan(overrides: Partial<ModuleBetaAcceptancePlanV1> = {}): ModuleBetaAcceptancePlanV1 {
  return {
    schemaVersion: 1,
    registrationId: '40000000-0000-4000-a000-000000000004',
    acceptanceRunId: 'gha:12345:1',
    scenario: 'scanner-crash',
    accountId,
    artifactId,
    artifactDigest,
    issuedAt: '2026-07-26T11:59:59.000Z',
    expiresAt: '2026-07-26T12:10:00.000Z',
    controllerIdentity,
    ...overrides,
  };
}

function body(bytes: Uint8Array) {
  return (async function* () {
    yield bytes.subarray(0, Math.floor(bytes.byteLength / 2));
    yield bytes.subarray(Math.floor(bytes.byteLength / 2));
  })();
}

function planResponse(value = plan()) {
  const bytes = encodeModuleBetaAcceptancePlan(value, key);
  return {
    Body: body(bytes),
    ContentLength: bytes.byteLength,
    ContentType: 'application/vnd.openopc.module-beta-acceptance-plan.v1+json',
  };
}

const claim = { accountId, artifactId, artifactDigest, runId };

describe('S3 acceptance plan consumer', () => {
  test('verifies a bound plan before atomically consuming it for one verification run', async () => {
    const commands: unknown[] = [];
    const consumer = createS3AcceptancePlanConsumer({
      bucket: 'developer-artifacts',
      key,
      controllerIdentity,
      now: () => now,
      client: {
        async send(command) {
          commands.push(command);
          if (command instanceof GetObjectCommand) return planResponse();
          return {};
        },
      },
    });

    await expect(consumer.consume(claim)).resolves.toEqual(plan());
    expect(commands).toHaveLength(2);
    expect((commands[0] as GetObjectCommand).input.Key).toBe(
      moduleBetaAcceptanceObjectKey({ accountId, artifactId, kind: 'plan' }),
    );
    expect((commands[1] as PutObjectCommand).input).toMatchObject({
      Bucket: 'developer-artifacts',
      Key: moduleBetaAcceptanceObjectKey({ accountId, artifactId, kind: 'consumption' }),
      ContentType: 'application/vnd.openopc.module-beta-acceptance-consumption.v1+json',
      IfNoneMatch: '*',
    });
  });

  test('returns no plan only when the deterministic plan object is absent', async () => {
    const consumer = createS3AcceptancePlanConsumer({
      bucket: 'developer-artifacts',
      key,
      controllerIdentity,
      now: () => now,
      client: {
        async send() {
          throw Object.assign(new Error('missing'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        },
      },
    });

    await expect(consumer.consume(claim)).resolves.toBeNull();
  });

  test('fails closed before consumption when artifact or controller bindings differ', async () => {
    for (const candidate of [
      plan({ artifactDigest: `sha256:${'b'.repeat(64)}` }),
      plan({ controllerIdentity: `other-controller#sha256:${'2'.repeat(64)}` }),
    ]) {
      let writes = 0;
      const consumer = createS3AcceptancePlanConsumer({
        bucket: 'developer-artifacts',
        key,
        controllerIdentity,
        now: () => now,
        client: {
          async send(command) {
            if (command instanceof PutObjectCommand) writes += 1;
            return planResponse(candidate);
          },
        },
      });

      await expect(consumer.consume(claim)).rejects.toThrow(
        'DEVELOPER_TRUST_ACCEPTANCE_PLAN_BINDING_INVALID',
      );
      expect(writes).toBe(0);
    }
  });

  test('accepts an idempotent retry only when the existing marker is byte-identical', async () => {
    let marker = new Uint8Array();
    const first = createS3AcceptancePlanConsumer({
      bucket: 'developer-artifacts',
      key,
      controllerIdentity,
      now: () => now,
      client: {
        async send(command) {
          if (command instanceof GetObjectCommand) return planResponse();
          marker = new Uint8Array((command as PutObjectCommand).input.Body as Uint8Array);
          return {};
        },
      },
    });
    await first.consume(claim);

    const retry = createS3AcceptancePlanConsumer({
      bucket: 'developer-artifacts',
      key,
      controllerIdentity,
      now: () => now,
      client: {
        async send(command) {
          if (command instanceof PutObjectCommand) {
            throw Object.assign(new Error('exists'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            });
          }
          return (command as GetObjectCommand).input.Key?.endsWith('plan.v1.json')
            ? planResponse()
            : {
                Body: body(marker),
                ContentLength: marker.byteLength,
                ContentType: 'application/vnd.openopc.module-beta-acceptance-consumption.v1+json',
              };
        },
      },
    });

    await expect(retry.consume(claim)).resolves.toEqual(plan());
  });

  test('rejects a consumption marker owned by another verification run', async () => {
    const conflicting = new TextEncoder().encode(
      JSON.stringify({
        acceptanceRunId: 'gha:12345:1',
        planDigest: `sha256:${'f'.repeat(64)}`,
        registrationId: '40000000-0000-4000-a000-000000000004',
        runId: '30000000-0000-4000-a000-000000000099',
        schemaVersion: 1,
      }),
    );
    const consumer = createS3AcceptancePlanConsumer({
      bucket: 'developer-artifacts',
      key,
      controllerIdentity,
      now: () => now,
      client: {
        async send(command) {
          if (command instanceof PutObjectCommand) {
            throw Object.assign(new Error('exists'), {
              name: 'PreconditionFailed',
              $metadata: { httpStatusCode: 412 },
            });
          }
          return (command as GetObjectCommand).input.Key?.endsWith('plan.v1.json')
            ? planResponse()
            : {
                Body: body(conflicting),
                ContentLength: conflicting.byteLength,
                ContentType: 'application/vnd.openopc.module-beta-acceptance-consumption.v1+json',
              };
        },
      },
    });

    await expect(consumer.consume(claim)).rejects.toThrow(
      'DEVELOPER_TRUST_ACCEPTANCE_PLAN_ALREADY_CONSUMED',
    );
  });
});
