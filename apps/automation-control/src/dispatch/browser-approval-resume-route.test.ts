import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AutomationBrowserApprovalConsumeInputSchema,
} from '@kortix/intelligence-contracts';
import { createBrowserApprovalResumeRoute } from './browser-approval-resume-route';
import { createWorkerTlsAttestationHeaders } from './heartbeat-route';
import { createMemoryWorkerNonceStore, createWorkerServiceAuthenticator } from './worker-auth';

const NOW = new Date('2099-07-23T09:00:00.000Z');
const TLS_SECRET = 'trusted-tls-proxy-secret-at-least-32-bytes';
const WORKER_SECRET = 'browser-worker-shared-secret-at-least-32-bytes';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'sha256:browser-worker-certificate';
const ATTEMPT_ID = '70000000-0000-4000-a000-000000000001';
const TOKEN = `approval-resume.v1.${'A'.repeat(43)}`;
const WORKER_CERTIFICATE = {
  authorized: true as const,
  serviceId: WORKER_ID,
  fingerprint256: WORKER_FINGERPRINT,
  validTo: '2099-07-24T09:00:00.000Z',
};
const CONSUME_INPUT = AutomationBrowserApprovalConsumeInputSchema.parse({
  account_id: '10000000-0000-4000-a000-000000000001',
  project_id: '20000000-0000-4000-a000-000000000001',
  job_id: '40000000-0000-4000-a000-000000000001',
  approval_id: '60000000-0000-4000-a000-000000000001',
  attempt_id: ATTEMPT_ID,
  step_id: '50000000-0000-4000-a000-000000000002',
  action_hash: `sha256:${'a'.repeat(64)}`,
  lease_id: '80000000-0000-4000-a000-000000000001',
  lease_owner: 'browser-worker-1:80000000-0000-4000-a000-000000000001',
  kill_switch_generation: 7,
  resume_after_sequence: 1,
  token: TOKEN,
  requested_at: NOW.toISOString(),
});

type StoreResult =
  | { accepted: true; idempotent: boolean; startedAt: string }
  | {
      accepted: false;
      reason:
        | 'credential_invalid'
        | 'stale_lease'
        | 'dispatch_mismatch'
        | 'approval_terminal'
        | 'conflict';
    };

function harness(options?: {
  result?: StoreResult;
  throwDependency?: boolean;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
}) {
  const authenticator = createWorkerServiceAuthenticator({
    trustedPeers: {
      [WORKER_ID]: {
        role: 'browser-worker',
        fingerprints: [WORKER_FINGERPRINT],
        sharedSecret: WORKER_SECRET,
      },
    },
    nonceStore: createMemoryWorkerNonceStore(),
    now: () => NOW,
  });
  const calls: unknown[] = [];
  const route = createBrowserApprovalResumeRoute({
    tlsAttestationSecret: TLS_SECRET,
    authenticator,
    now: () => NOW,
    maxBodyBytes: options?.maxBodyBytes,
    bodyReadTimeoutMs: options?.bodyReadTimeoutMs,
    store: {
      async consumeAndStart(input) {
        calls.push(input);
        if (options?.throwDependency) throw new Error('postgresql://secret@internal/control');
        return (
          options?.result ?? {
            accepted: true,
            idempotent: false,
            startedAt: NOW.toISOString(),
          }
        );
      },
    },
  });
  return { authenticator, calls, route };
}

function signedRequestBody(
  authenticator: ReturnType<typeof createWorkerServiceAuthenticator>,
  options?: { nonce?: number; consume?: typeof CONSUME_INPUT; proofServiceId?: string },
) {
  const consume = options?.consume ?? CONSUME_INPUT;
  const proof = authenticator.sign({
    serviceId: WORKER_ID,
    certificateFingerprint256: WORKER_FINGERPRINT,
    timestamp: NOW,
    nonce: options?.nonce ?? 41,
    body: consume,
  });
  return JSON.stringify({
    protocol_version: 'automation.v1',
    proof: { ...proof, service_id: options?.proofServiceId ?? proof.service_id },
    consume,
  });
}

function attestedRequest(body: string, certificate = WORKER_CERTIFICATE): Request {
  const headers = createWorkerTlsAttestationHeaders({
    secret: TLS_SECRET,
    timestamp: NOW,
    method: 'POST',
    path: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
    body,
    certificate,
  });
  return new Request(`https://control.internal${AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

describe('Browser approval resume consume route', () => {
  test('authenticates the Worker and returns a redacted accepted receipt', async () => {
    const current = harness();
    const body = signedRequestBody(current.authenticator);

    const response = await current.route.fetch(attestedRequest(body));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        consumed: true,
        attempt_id: ATTEMPT_ID,
        idempotent: false,
      }),
    );
    expect(current.calls).toEqual([
      expect.objectContaining({ workerId: WORKER_ID, token: TOKEN, now: NOW }),
    ]);
    const responseText = await current.route.fetch(
      attestedRequest(signedRequestBody(current.authenticator, { nonce: 42 })),
    );
    expect(await responseText.text()).not.toContain(TOKEN);
  });

  test('rejects a body changed after attestation and an untrusted certificate', async () => {
    const changed = harness();
    const body = signedRequestBody(changed.authenticator);
    const original = attestedRequest(body);
    const changedBody = `${body} `;
    const altered = new Request(original.url, {
      method: 'POST',
      headers: original.headers,
      body: changedBody,
    });
    expect((await changed.route.fetch(altered)).status).toBe(401);

    const wrongCertificate = {
      ...WORKER_CERTIFICATE,
      fingerprint256: 'sha256:untrusted-certificate',
    };
    expect((await changed.route.fetch(attestedRequest(body, wrongCertificate))).status).toBe(401);
    expect(changed.calls).toHaveLength(0);
  });

  test('rejects proof identity mismatch and maps proof replay to conflict', async () => {
    const identity = harness();
    const wrongIdentity = signedRequestBody(identity.authenticator, {
      proofServiceId: 'browser-worker-2',
    });
    expect((await identity.route.fetch(attestedRequest(wrongIdentity))).status).toBe(401);

    const replay = harness();
    const body = signedRequestBody(replay.authenticator);
    expect((await replay.route.fetch(attestedRequest(body))).status).toBe(200);
    const second = await replay.route.fetch(attestedRequest(body));
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'AUTOMATION_CONFLICT', retryable: false });
  });

  test('bounds oversized and timed-out request bodies before proof verification', async () => {
    const oversized = harness({ maxBodyBytes: 128 });
    const body = signedRequestBody(oversized.authenticator);
    expect((await oversized.route.fetch(attestedRequest(body))).status).toBe(413);
    expect(oversized.calls).toHaveLength(0);

    const timedOut = harness({ bodyReadTimeoutMs: 100 });
    const emptyHeaders = createWorkerTlsAttestationHeaders({
      secret: TLS_SECRET,
      timestamp: NOW,
      method: 'POST',
      path: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
      body: '',
      certificate: WORKER_CERTIFICATE,
    });
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    });
    const request = new Request(
      `https://control.internal${AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH}`,
      {
        method: 'POST',
        headers: emptyHeaders,
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' },
    );
    expect((await timedOut.route.fetch(request)).status).toBe(408);
    expect(timedOut.calls).toHaveLength(0);
  });

  test('maps stale leases and every other store rejection without credential disclosure', async () => {
    for (const current of [
      {
        result: { accepted: false, reason: 'stale_lease' } as const,
        code: 'AUTOMATION_LEASE_EXPIRED',
      },
      {
        result: { accepted: false, reason: 'credential_invalid' } as const,
        code: 'AUTOMATION_CONFLICT',
      },
      {
        result: { accepted: false, reason: 'dispatch_mismatch' } as const,
        code: 'AUTOMATION_CONFLICT',
      },
    ]) {
      const testRoute = harness({ result: current.result });
      const body = signedRequestBody(testRoute.authenticator);
      const response = await testRoute.route.fetch(attestedRequest(body));
      expect(response.status).toBe(409);
      const responseText = await response.text();
      expect(JSON.parse(responseText)).toMatchObject({ code: current.code, retryable: false });
      expect(responseText).not.toContain(TOKEN);
      expect(responseText).not.toContain('tokenHash');
      expect(responseText).not.toContain('credential_invalid');
    }
  });

  test('hides dependency failures behind a retryable unavailable response', async () => {
    const current = harness({ throwDependency: true });
    const body = signedRequestBody(current.authenticator);
    const response = await current.route.fetch(attestedRequest(body));
    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      code: 'AUTOMATION_UNAVAILABLE',
      retryable: true,
    });
    expect(responseText).not.toContain('postgresql://');
  });
});
