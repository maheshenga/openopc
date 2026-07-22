import { describe, expect, test } from 'bun:test';
import { WorkerHeartbeatError } from './heartbeat';
import {
  AUTOMATION_BROWSER_HEARTBEAT_PATH,
  createBrowserWorkerHeartbeatRoute,
  createWorkerTlsAttestationHeaders,
} from './heartbeat-route';
import { WorkerAuthenticationError } from './worker-auth';

const NOW = new Date('2026-07-23T01:00:00.000Z');
const TLS_ATTESTATION_SECRET = 'trusted-tls-proxy-secret-at-least-32-bytes';
const WORKER_CERTIFICATE = {
  authorized: true as const,
  serviceId: 'browser-worker-1',
  fingerprint256: 'sha256:worker-certificate-fingerprint',
  validTo: '2026-07-24T01:00:00.000Z',
};

function attestedHeaders(body: string, path = AUTOMATION_BROWSER_HEARTBEAT_PATH) {
  return createWorkerTlsAttestationHeaders({
    secret: TLS_ATTESTATION_SECRET,
    timestamp: NOW,
    method: 'POST',
    path,
    body,
    certificate: WORKER_CERTIFICATE,
  });
}

function workerRequestBody(heartbeat: unknown = {}) {
  return JSON.stringify({
    protocol_version: 'automation.v1',
    proof: {
      service_id: WORKER_CERTIFICATE.serviceId,
      timestamp: NOW.toISOString(),
      nonce: 1,
      signature: `hmac-sha256:${'a'.repeat(64)}`,
    },
    heartbeat,
  });
}

describe('Browser Worker heartbeat route', () => {
  test('does not let the TLS proxy attest an unauthorized client certificate', () => {
    expect(
      createWorkerTlsAttestationHeaders({
        secret: TLS_ATTESTATION_SECRET,
        timestamp: NOW,
        method: 'POST',
        path: AUTOMATION_BROWSER_HEARTBEAT_PATH,
        body: workerRequestBody(),
        certificate: WORKER_CERTIFICATE,
      }),
    ).toHaveProperty('x-automation-worker-tls-attestation');
    expect(() =>
      createWorkerTlsAttestationHeaders({
        secret: TLS_ATTESTATION_SECRET,
        timestamp: NOW,
        method: 'POST',
        path: AUTOMATION_BROWSER_HEARTBEAT_PATH,
        body: workerRequestBody(),
        certificate: { ...WORKER_CERTIFICATE, authorized: false },
      }),
    ).toThrow(/authorized/i);
  });

  test('rejects a request without trusted TLS attestation before processing it', async () => {
    let processorCalls = 0;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer() {
          throw new Error('unattested requests must not bind a Worker peer');
        },
      },
      processor: {
        async handle() {
          processorCalls += 1;
          throw new Error('unattested requests must not reach the heartbeat processor');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAUTHORIZED',
      message: 'Browser Worker authentication failed',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    });
    expect(processorCalls).toBe(0);
  });

  test('rejects attestation when either the request body or complete path is changed', async () => {
    const body = workerRequestBody();
    let bindCalls = 0;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer() {
          bindCalls += 1;
          throw new Error('tampered requests must not bind a Worker peer');
        },
      },
      processor: {
        async handle() {
          throw new Error('tampered requests must not reach the heartbeat processor');
        },
      },
    });
    const headers = { 'content-type': 'application/json', ...attestedHeaders(body) };

    const changedBody = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers,
      body: `${body} `,
    });
    const changedPath = await app.request(`${AUTOMATION_BROWSER_HEARTBEAT_PATH}?attempt=2`, {
      method: 'POST',
      headers,
      body,
    });

    expect(changedBody.status).toBe(401);
    expect(changedPath.status).toBe(401);
    expect(bindCalls).toBe(0);
  });

  test('rejects a proof identity that differs from the attested certificate identity', async () => {
    const parsed = JSON.parse(workerRequestBody()) as Record<string, unknown> & {
      proof: Record<string, unknown>;
    };
    parsed.proof.service_id = 'browser-worker-2';
    const body = JSON.stringify(parsed);
    let bindCalls = 0;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer(input) {
          bindCalls += 1;
          return Object.freeze({
            serviceId: input.serviceId,
            role: 'browser-worker' as const,
            certificateFingerprint256: input.fingerprint256,
            certificateExpiresAt: input.validTo,
          });
        },
      },
      processor: {
        async handle() {
          throw new Error('identity-mismatched requests must not reach the heartbeat processor');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attestedHeaders(body) },
      body,
    });

    expect(response.status).toBe(401);
    expect(bindCalls).toBe(1);
  });

  test('bounds certificate attestation headers before binding the peer', async () => {
    const body = workerRequestBody();
    const headers = attestedHeaders(body);
    headers['x-automation-worker-certificate-fingerprint'] = 'x'.repeat(257);
    let bindCalls = 0;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer() {
          bindCalls += 1;
          throw new Error('oversized certificate headers must not bind a Worker peer');
        },
      },
      processor: {
        async handle() {
          throw new Error('oversized certificate headers must not reach the processor');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

    expect(response.status).toBe(401);
    expect(bindCalls).toBe(0);
  });

  test('terminates a slow request body at the configured read deadline', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
      },
    });
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      bodyReadTimeoutMs: 100,
      authenticator: {
        bindTlsPeer() {
          throw new Error('timed-out requests must not bind a Worker peer');
        },
      },
      processor: {
        async handle() {
          throw new Error('timed-out requests must not reach the heartbeat processor');
        },
      },
    });
    const request = new Request(`http://localhost${AUTOMATION_BROWSER_HEARTBEAT_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...attestedHeaders(''),
      },
      body: stream,
    });

    const response = await app.fetch(request);

    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_INVALID_REQUEST',
      message: 'Browser Worker heartbeat body was not received in time',
      retryable: true,
      approval_status: null,
      audit_event_id: null,
    });
  });

  test('binds trusted TLS evidence and returns the durably persisted event', async () => {
    const heartbeat = {
      protocol_version: 'automation.v1' as const,
      account_id: '10000000-0000-4000-a000-000000000001',
      project_id: '20000000-0000-4000-a000-000000000001',
      job_id: '30000000-0000-4000-a000-000000000001',
      lease_id: '40000000-0000-4000-a000-000000000001',
      lease_owner: 'browser-worker-1:40000000-0000-4000-a000-000000000001',
      kill_switch_generation: 0,
      worker_id: 'browser-worker-1',
      ordinal: 1,
      observed_at: NOW.toISOString(),
      event: {
        type: 'heartbeat' as const,
        payload: { last_completed_step: 0 },
        trace_id: null,
      },
    };
    const proof = {
      service_id: 'browser-worker-1',
      timestamp: NOW.toISOString(),
      nonce: 1,
      signature: `hmac-sha256:${'a'.repeat(64)}`,
    };
    const body = JSON.stringify({ protocol_version: 'automation.v1', proof, heartbeat });
    const event = {
      protocol_version: 'automation.v1' as const,
      event_id: '50000000-0000-4000-a000-000000000001',
      job_id: heartbeat.job_id,
      sequence: 7,
      type: 'heartbeat' as const,
      status: null,
      payload: heartbeat.event.payload,
      trace_id: null,
      created_at: NOW.toISOString(),
    };
    let boundCertificate: unknown;
    let processed: unknown;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer(input) {
          boundCertificate = input;
          return Object.freeze({
            serviceId: input.serviceId,
            role: 'browser-worker' as const,
            certificateFingerprint256: input.fingerprint256,
            certificateExpiresAt: input.validTo,
          });
        },
      },
      processor: {
        async handle(input) {
          processed = input;
          return event;
        },
      },
    });
    const headers = attestedHeaders(body);

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol_version: 'automation.v1',
      accepted: true,
      event,
    });
    expect(boundCertificate).toEqual(WORKER_CERTIFICATE);
    expect(processed).toMatchObject({ proof, heartbeat });
  });

  test('rejects an oversized heartbeat before binding or processing Worker identity', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(512) });
    let processorCalls = 0;
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      maxBodyBytes: 256,
      authenticator: {
        bindTlsPeer() {
          throw new Error('oversized requests must not bind a Worker peer');
        },
      },
      processor: {
        async handle() {
          processorCalls += 1;
          throw new Error('oversized requests must not reach the heartbeat processor');
        },
      },
    });
    const headers = attestedHeaders(body);

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_INVALID_REQUEST',
      retryable: false,
    });
    expect(processorCalls).toBe(0);
  });

  test('maps an untrusted TLS certificate to a generic authentication failure', async () => {
    const body = workerRequestBody();
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer() {
          throw new WorkerAuthenticationError('certificate fingerprint is not trusted');
        },
      },
      processor: {
        async handle() {
          throw new Error('untrusted certificates must not reach the heartbeat processor');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attestedHeaders(body) },
      body,
    });

    expect(response.status).toBe(401);
    const responseBody = await response.text();
    expect(responseBody).not.toContain('fingerprint');
    expect(JSON.parse(responseBody)).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAUTHORIZED',
      message: 'Browser Worker authentication failed',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    });
  });

  test('maps a stale durable lease rejection to the protocol lease-expired response', async () => {
    const body = workerRequestBody();
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer(input) {
          return Object.freeze({
            serviceId: input.serviceId,
            role: 'browser-worker' as const,
            certificateFingerprint256: input.fingerprint256,
            certificateExpiresAt: input.validTo,
          });
        },
      },
      processor: {
        async handle() {
          throw new WorkerHeartbeatError('stale_lease', 'heartbeat lease owner is stale');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attestedHeaders(body) },
      body,
    });

    expect(response.status).toBe(409);
    const responseBody = await response.text();
    expect(responseBody).not.toContain('lease owner');
    expect(JSON.parse(responseBody)).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_LEASE_EXPIRED',
      message: 'Browser Worker lease is no longer current',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    });
  });

  test('maps an invalid Worker event payload to a stable bad-request response', async () => {
    const body = workerRequestBody();
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer(input) {
          return Object.freeze({
            serviceId: input.serviceId,
            role: 'browser-worker' as const,
            certificateFingerprint256: input.fingerprint256,
            certificateExpiresAt: input.validTo,
          });
        },
      },
      processor: {
        async handle() {
          throw new WorkerHeartbeatError(
            'invalid_payload',
            'payload contained forbidden private material',
          );
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attestedHeaders(body) },
      body,
    });

    expect(response.status).toBe(400);
    const responseBody = await response.text();
    expect(responseBody).not.toContain('private material');
    expect(JSON.parse(responseBody)).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_INVALID_REQUEST',
      message: 'Browser Worker heartbeat request is invalid',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    });
  });

  test('hides persistence failures behind a retryable unavailable response', async () => {
    const body = workerRequestBody();
    const app = createBrowserWorkerHeartbeatRoute({
      tlsAttestationSecret: TLS_ATTESTATION_SECRET,
      now: () => NOW,
      authenticator: {
        bindTlsPeer(input) {
          return Object.freeze({
            serviceId: input.serviceId,
            role: 'browser-worker' as const,
            certificateFingerprint256: input.fingerprint256,
            certificateExpiresAt: input.validTo,
          });
        },
      },
      processor: {
        async handle() {
          throw new Error('postgresql://automation:secret@database.internal/automation');
        },
      },
    });

    const response = await app.request(AUTOMATION_BROWSER_HEARTBEAT_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...attestedHeaders(body) },
      body,
    });

    expect(response.status).toBe(503);
    const responseBody = await response.text();
    expect(responseBody).not.toContain('postgresql://');
    expect(JSON.parse(responseBody)).toEqual({
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAVAILABLE',
      message: 'Browser Worker heartbeat is temporarily unavailable',
      retryable: true,
      approval_status: null,
      audit_event_id: null,
    });
  });
});
