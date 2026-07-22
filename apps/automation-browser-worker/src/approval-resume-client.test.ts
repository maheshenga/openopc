import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AutomationBrowserApprovalConsumeInputSchema,
  AutomationErrorSchema,
} from '@kortix/intelligence-contracts';
import {
  BrowserApprovalResumeClientError,
  type BrowserApprovalResumeTransport,
  createBrowserApprovalResumeClient,
  createBrowserApprovalResumeMtlsTransport,
} from './approval-resume-client';

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

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: 'automation.v1',
    consumed: true,
    idempotent: false,
    approval_id: APPROVAL_ID,
    attempt_id: ATTEMPT_ID,
    job_id: JOB_ID,
    step_id: STEP_ID,
    started_at: NOW.toISOString(),
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function rejected(
  code: 'AUTOMATION_LEASE_EXPIRED' | 'AUTOMATION_CONFLICT' | 'AUTOMATION_UNAVAILABLE',
) {
  return response(
    AutomationErrorSchema.parse({
      protocol_version: 'automation.v1',
      code,
      message: 'Browser approval resume was rejected',
      retryable: code === 'AUTOMATION_UNAVAILABLE',
      approval_status: null,
      audit_event_id: null,
    }),
    code === 'AUTOMATION_UNAVAILABLE' ? 503 : 409,
  );
}

function clientWith(
  transport: BrowserApprovalResumeTransport,
  nextNonce: () => number = () => 101,
  requestTimeoutMs = 5_000,
) {
  return createBrowserApprovalResumeClient({
    controlUrl: 'https://control.internal',
    serviceId: WORKER_ID,
    certificateFingerprint256: WORKER_FINGERPRINT,
    sharedSecret: WORKER_SECRET,
    requestTimeoutMs,
    transport,
    nextNonce,
    now: () => NOW,
  });
}

describe('Browser approval resume client', () => {
  test('sends one signed mTLS consume request and returns the bound receipt', async () => {
    const calls: Array<{ url: string; init: BunFetchRequestInit }> = [];
    const client = clientWith(async (url, init) => {
      calls.push({ url: String(url), init });
      return response(accepted());
    });

    const result = await client.consume(CONSUME_INPUT);

    expect(result).toEqual({
      consumed: true,
      idempotent: false,
      approvalId: APPROVAL_ID,
      attemptId: ATTEMPT_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      startedAt: NOW.toISOString(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://control.internal${AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH}`,
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(
      expect.objectContaining({
        protocol_version: 'automation.v1',
        proof: expect.objectContaining({ service_id: WORKER_ID, nonce: 101 }),
        consume: CONSUME_INPUT,
      }),
    );
  });

  test('does not retry transport or unknown-result failures', async () => {
    const calls: unknown[] = [];
    const client = clientWith(async (...args) => {
      calls.push(args);
      throw new Error('connection reset after write');
    });

    await expect(client.consume(CONSUME_INPUT)).rejects.toMatchObject({ reason: 'transport' });
    expect(calls).toHaveLength(1);
  });

  test('rejects non-monotonic nonces before a second transport call', async () => {
    const calls: unknown[] = [];
    const nonces = [101, 101];
    const client = clientWith(
      async (...args) => {
        calls.push(args);
        return response(accepted());
      },
      () => nonces.shift() ?? 101,
    );

    await expect(client.consume(CONSUME_INPUT)).resolves.toMatchObject({ consumed: true });
    await expect(client.consume(CONSUME_INPUT)).rejects.toMatchObject({
      reason: 'configuration',
    });
    expect(calls).toHaveLength(1);
  });

  test('maps caller aborts and request timeouts to a single transport failure', async () => {
    for (const transport of [
      (async () => {
        throw new DOMException('caller aborted', 'AbortError');
      }) satisfies BrowserApprovalResumeTransport,
      ((_, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('timed out', 'AbortError')),
            { once: true },
          );
        })) satisfies BrowserApprovalResumeTransport,
    ]) {
      await expect(
        clientWith(transport, () => 101, 1).consume(CONSUME_INPUT),
      ).rejects.toMatchObject({ reason: 'transport' });
    }
  });

  test('rejects oversized, malformed, and identity-mismatched success responses', async () => {
    const oversized = new Response('x'.repeat(64 * 1024 + 1));
    const cases = [
      oversized,
      new Response('{not-json', { status: 200 }),
      response(accepted({ attempt_id: '70000000-0000-4000-a000-000000000099' })),
    ];
    for (const current of cases) {
      const client = clientWith(async () => current.clone());
      await expect(client.consume(CONSUME_INPUT)).rejects.toMatchObject({ reason: 'protocol' });
    }
  });

  test('preserves stable Control rejection codes without retrying', async () => {
    for (const code of [
      'AUTOMATION_LEASE_EXPIRED',
      'AUTOMATION_CONFLICT',
      'AUTOMATION_UNAVAILABLE',
    ] as const) {
      let calls = 0;
      const client = clientWith(async () => {
        calls += 1;
        return rejected(code);
      });
      await expect(client.consume(CONSUME_INPUT)).rejects.toEqual(
        expect.objectContaining({
          reason: 'rejected',
          response: expect.objectContaining({ code }),
        }),
      );
      expect(calls).toBe(1);
    }
  });

  test('pins explicit absolute mTLS certificate files and the Control server name', async () => {
    const certificatePath = resolve('secrets/browser-worker.crt');
    const privateKeyPath = resolve('secrets/browser-worker.key');
    const caPath = resolve('secrets/control-ca.crt');
    let captured: BunFetchRequestInit | undefined;
    const transport = createBrowserApprovalResumeMtlsTransport({
      controlUrl: 'https://control.internal',
      mtlsCertificatePath: certificatePath,
      mtlsPrivateKeyPath: privateKeyPath,
      mtlsCaPath: caPath,
      baseFetch: async (_url, init) => {
        captured = init;
        return response(accepted());
      },
    });

    await transport('https://control.internal/test', { method: 'POST' });

    expect((captured?.tls?.cert as Bun.BunFile).name).toBe(certificatePath);
    expect((captured?.tls?.key as Bun.BunFile).name).toBe(privateKeyPath);
    expect((captured?.tls?.ca as Bun.BunFile).name).toBe(caPath);
    expect(captured?.tls?.rejectUnauthorized).toBeTrue();
    expect(captured?.tls?.serverName).toBe('control.internal');
    expect(() =>
      createBrowserApprovalResumeMtlsTransport({
        controlUrl: 'https://control.internal',
        mtlsCertificatePath: 'relative.crt',
        mtlsPrivateKeyPath: privateKeyPath,
        mtlsCaPath: caPath,
      }),
    ).toThrow(BrowserApprovalResumeClientError);
  });
});
