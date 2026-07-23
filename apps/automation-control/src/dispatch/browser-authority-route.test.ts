import { describe, expect, test } from 'bun:test';
import {
  AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
  AutomationBrowserAuthorityCheckInputSchema,
} from '@kortix/intelligence-contracts';
import { createBrowserAuthorityRoute } from './browser-authority-route';
import { createWorkerTlsAttestationHeaders } from './heartbeat-route';
import { createMemoryWorkerNonceStore, createWorkerServiceAuthenticator } from './worker-auth';

const NOW = new Date('2099-07-23T09:00:00.000Z');
const TLS_SECRET = 'trusted-tls-proxy-secret-at-least-32-bytes';
const WORKER_SECRET = 'browser-worker-shared-secret-at-least-32-bytes';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'sha256:browser-worker-certificate';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const LEASE_ID = '80000000-0000-4000-a000-000000000001';
const REQUEST_HASH = `sha256:${'b'.repeat(64)}`;
const WORKER_CERTIFICATE = {
  authorized: true as const,
  serviceId: WORKER_ID,
  fingerprint256: WORKER_FINGERPRINT,
  validTo: '2099-07-24T09:00:00.000Z',
};
const AUTHORITY = AutomationBrowserAuthorityCheckInputSchema.parse({
  account_id: '10000000-0000-4000-a000-000000000001',
  project_id: '20000000-0000-4000-a000-000000000001',
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  lease_owner: `${WORKER_ID}:${LEASE_ID}`,
  request_hash: REQUEST_HASH,
  kill_switch_generation: 7,
  requested_at: NOW.toISOString(),
  check: {
    kind: 'action',
    step_id: '50000000-0000-4000-a000-000000000001',
    action_hash: `sha256:${'a'.repeat(64)}`,
  },
});

type StoreResult =
  | {
      accepted: true;
      checkedAt: string;
      currentGeneration: number;
      fullAccessGrantCurrent: boolean;
    }
  | { accepted: false; reason: 'stale_lease' | 'dispatch_mismatch' };

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
  const route = createBrowserAuthorityRoute({
    tlsAttestationSecret: TLS_SECRET,
    authenticator,
    now: () => NOW,
    maxBodyBytes: options?.maxBodyBytes,
    bodyReadTimeoutMs: options?.bodyReadTimeoutMs,
    store: {
      async check(input, now) {
        calls.push({ input, now });
        if (options?.throwDependency) throw new Error('postgresql://secret@internal/control');
        return (
          options?.result ?? {
            accepted: true,
            checkedAt: NOW.toISOString(),
            currentGeneration: 7,
            fullAccessGrantCurrent: false,
          }
        );
      },
    },
  });
  return { authenticator, calls, route };
}

function signedAuthorityBody(
  authenticator: ReturnType<typeof createWorkerServiceAuthenticator>,
  nonce = 41,
  authority = AUTHORITY,
) {
  const proof = authenticator.sign({
    serviceId: WORKER_ID,
    certificateFingerprint256: WORKER_FINGERPRINT,
    timestamp: NOW,
    nonce,
    body: authority,
  });
  return JSON.stringify({ protocol_version: 'automation.v1', proof, authority });
}

function attestedAuthorityRequest(body: string): Request {
  const headers = createWorkerTlsAttestationHeaders({
    secret: TLS_SECRET,
    timestamp: NOW,
    method: 'POST',
    path: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
    body,
    certificate: WORKER_CERTIFICATE,
  });
  return new Request(`https://control.internal${AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body,
  });
}

describe('Browser authority route', () => {
  test('authenticates the Worker and returns only the authority receipt', async () => {
    const current = harness();
    const response = await current.route.fetch(
      attestedAuthorityRequest(signedAuthorityBody(current.authenticator)),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'automation.v1',
      authorized: true,
      check: 'action',
      job_id: JOB_ID,
      lease_id: LEASE_ID,
      kill_switch_generation: 7,
      full_access_grant_current: false,
      checked_at: NOW.toISOString(),
    });
    expect(current.calls).toEqual([{ input: AUTHORITY, now: NOW }]);
  });

  test('rejects a replayed Worker proof before the store is called again', async () => {
    const current = harness();
    const body = signedAuthorityBody(current.authenticator);

    expect((await current.route.fetch(attestedAuthorityRequest(body))).status).toBe(200);
    const response = await current.route.fetch(attestedAuthorityRequest(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'AUTOMATION_CONFLICT', retryable: false });
    expect(current.calls).toHaveLength(1);
  });

  test('bounds oversized and timed-out request bodies before proof verification', async () => {
    const oversized = harness({ maxBodyBytes: 128 });
    expect(
      (await oversized.route.fetch(
        attestedAuthorityRequest(signedAuthorityBody(oversized.authenticator)),
      )).status,
    ).toBe(413);
    expect(oversized.calls).toHaveLength(0);

    const timedOut = harness({ bodyReadTimeoutMs: 100 });
    const headers = createWorkerTlsAttestationHeaders({
      secret: TLS_SECRET,
      timestamp: NOW,
      method: 'POST',
      path: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
      body: '',
      certificate: WORKER_CERTIFICATE,
    });
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
    const response = await timedOut.route.fetch(
      new Request(`https://control.internal${AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH}`, {
        method: 'POST',
        headers,
        body: stream,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' }),
    );
    expect(response.status).toBe(408);
    expect(timedOut.calls).toHaveLength(0);
  });

  test('rejects malformed strict requests without invoking the store', async () => {
    const current = harness();
    const body = JSON.stringify({
      protocol_version: 'automation.v1',
      proof: current.authenticator.sign({
        serviceId: WORKER_ID,
        certificateFingerprint256: WORKER_FINGERPRINT,
        timestamp: NOW,
        nonce: 41,
        body: AUTHORITY,
      }),
      authority: AUTHORITY,
      unexpected: true,
    });

    const response = await current.route.fetch(attestedAuthorityRequest(body));
    expect(response.status).toBe(401);
    expect(current.calls).toHaveLength(0);
  });

  test('maps stale leases and redacts authority and dependency details', async () => {
    const stale = harness({ result: { accepted: false, reason: 'stale_lease' } });
    const staleResponse = await stale.route.fetch(
      attestedAuthorityRequest(signedAuthorityBody(stale.authenticator)),
    );
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toMatchObject({
      code: 'AUTOMATION_LEASE_EXPIRED',
      retryable: false,
    });

    const failed = harness({ throwDependency: true });
    const response = await failed.route.fetch(
      attestedAuthorityRequest(signedAuthorityBody(failed.authenticator)),
    );
    expect(response.status).toBe(503);
    const responseText = await response.text();
    expect(JSON.parse(responseText)).toMatchObject({
      code: 'AUTOMATION_UNAVAILABLE',
      retryable: true,
    });
    expect(responseText).not.toContain('postgresql://');
    expect(responseText).not.toContain(REQUEST_HASH);
  });
});
