import { describe, expect, test } from 'bun:test';
import {
  AutomationBrowserApprovalConsumeAcceptedSchema,
  AutomationBrowserApprovalConsumeInputSchema,
  AutomationErrorSchema,
} from '@kortix/intelligence-contracts';
import { createWorkerControlClient, createWorkerProofNonceSource } from './worker-control-client';

const NOW = new Date('2099-07-23T10:00:00.000Z');
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'sha256:browser-worker-certificate';
const WORKER_SECRET = 'browser-worker-shared-secret-at-least-32-bytes';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '70000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000002';
const CONSUME_INPUT = AutomationBrowserApprovalConsumeInputSchema.parse({
  account_id: '10000000-0000-4000-a000-000000000001',
  project_id: '20000000-0000-4000-a000-000000000001',
  job_id: JOB_ID,
  approval_id: APPROVAL_ID,
  attempt_id: ATTEMPT_ID,
  step_id: STEP_ID,
  action_hash: `sha256:${'a'.repeat(64)}`,
  lease_id: '80000000-0000-4000-a000-000000000001',
  lease_owner: 'browser-worker-1:80000000-0000-4000-a000-000000000001',
  kill_switch_generation: 7,
  resume_after_sequence: 1,
  token: `approval-resume.v1.${'A'.repeat(43)}`,
  requested_at: NOW.toISOString(),
});

function accepted() {
  return {
    protocol_version: 'automation.v1',
    consumed: true,
    idempotent: false,
    approval_id: APPROVAL_ID,
    attempt_id: ATTEMPT_ID,
    job_id: JOB_ID,
    step_id: STEP_ID,
    started_at: NOW.toISOString(),
  };
}

describe('Worker Control client', () => {
  test('keeps the proof nonce monotonic when the clock moves backwards', () => {
    const times = [NOW, new Date(NOW.getTime() - 1_000)];
    const nextNonce = createWorkerProofNonceSource(() => times.shift() ?? NOW);

    const first = nextNonce();
    const second = nextNonce();

    expect(first).toBe(NOW.getTime() * 1_000);
    expect(second).toBe(first + 1);
  });

  test('signs and parses requests through one monotonic nonce source', async () => {
    const calls: Array<{ url: string; init: BunFetchRequestInit }> = [];
    let nonce = 100;
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5_000,
      transport: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(accepted());
      },
      nextNonce: () => ++nonce,
      now: () => NOW,
    });

    const first = await client.request({
      path: '/internal/automation/browser/approval/consume',
      bodyKey: 'consume',
      body: CONSUME_INPUT,
      schema: AutomationBrowserApprovalConsumeAcceptedSchema,
    });
    const second = await client.request({
      path: '/internal/automation/browser/approval/consume',
      bodyKey: 'consume',
      body: CONSUME_INPUT,
      schema: AutomationBrowserApprovalConsumeAcceptedSchema,
    });

    expect(first).toMatchObject({ status: 200, ok: true, body: accepted() });
    expect(second).toMatchObject({ status: 200, ok: true, body: accepted() });
    expect(calls).toHaveLength(2);
    expect(calls.map(({ url }) => url)).toEqual([
      'https://control.internal/internal/automation/browser/approval/consume',
      'https://control.internal/internal/automation/browser/approval/consume',
    ]);
    expect(
      calls.map(
        ({ init }) => (JSON.parse(String(init.body)) as { proof: { nonce: number } }).proof.nonce,
      ),
    ).toEqual([101, 102]);
  });

  test('returns stable rejection metadata without exposing Control response text', async () => {
    const secret = 'approval-resume.v1.secret-token';
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5_000,
      transport: async () =>
        Response.json(
          AutomationErrorSchema.parse({
            protocol_version: 'automation.v1',
            code: 'AUTOMATION_UNAVAILABLE',
            message: `internal detail ${secret}`,
            retryable: true,
            approval_status: null,
            audit_event_id: null,
          }),
          { status: 503 },
        ),
      nextNonce: () => 201,
      now: () => NOW,
    });

    const result = await client.request({
      path: '/internal/automation/browser/approval/consume',
      bodyKey: 'consume',
      body: CONSUME_INPUT,
      schema: AutomationBrowserApprovalConsumeAcceptedSchema,
    });

    expect(result).toMatchObject({
      status: 503,
      ok: false,
      body: { code: 'AUTOMATION_UNAVAILABLE', retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test('fails a transport that ignores abort at the request deadline', async () => {
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5,
      transport: async () => new Promise<Response>(() => undefined),
      nextNonce: () => 301,
      now: () => NOW,
    });

    await expect(
      client.request({
        path: '/internal/automation/browser/approval/consume',
        bodyKey: 'consume',
        body: CONSUME_INPUT,
        schema: AutomationBrowserApprovalConsumeAcceptedSchema,
      }),
    ).rejects.toMatchObject({ reason: 'transport' });
  });

  test('rejects oversized and malformed Control responses with bounded protocol errors', async () => {
    for (const response of [
      new Response('x'.repeat(64 * 1024 + 1), { status: 200 }),
      new Response('{not-json', { status: 200 }),
    ]) {
      const client = createWorkerControlClient({
        controlUrl: 'https://control.internal',
        serviceId: WORKER_ID,
        certificateFingerprint256: WORKER_FINGERPRINT,
        sharedSecret: WORKER_SECRET,
        requestTimeoutMs: 5_000,
        transport: async () => response.clone(),
        nextNonce: () => 401,
        now: () => NOW,
      });

      await expect(
        client.request({
          path: '/internal/automation/browser/approval/consume',
          bodyKey: 'consume',
          body: CONSUME_INPUT,
          schema: AutomationBrowserApprovalConsumeAcceptedSchema,
        }),
      ).rejects.toMatchObject({
        reason: 'protocol',
        message: 'Worker Control response is invalid',
      });
    }
  });

  test('rejects a body key that could overwrite the signed protocol envelope', async () => {
    let calls = 0;
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5_000,
      transport: async () => {
        calls += 1;
        return Response.json(accepted());
      },
      nextNonce: () => 501,
      now: () => NOW,
    });

    await expect(
      client.request({
        path: '/internal/automation/browser/approval/consume',
        bodyKey: 'protocol_version',
        body: CONSUME_INPUT,
        schema: AutomationBrowserApprovalConsumeAcceptedSchema,
      }),
    ).rejects.toMatchObject({ reason: 'configuration' });
    expect(calls).toBe(0);
  });

  test('rejects a Control path with query ambiguity before signing or transport', async () => {
    let calls = 0;
    const client = createWorkerControlClient({
      controlUrl: 'https://control.internal',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      requestTimeoutMs: 5_000,
      transport: async () => {
        calls += 1;
        return Response.json(accepted());
      },
      nextNonce: () => 601,
      now: () => NOW,
    });

    await expect(
      client.request({
        path: '/internal/automation/browser/approval/consume?unexpected=true',
        bodyKey: 'consume',
        body: CONSUME_INPUT,
        schema: AutomationBrowserApprovalConsumeAcceptedSchema,
      }),
    ).rejects.toMatchObject({ reason: 'configuration' });
    expect(calls).toBe(0);
  });
});
