import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type AutomationEvent,
  type AutomationWorkerHeartbeat,
  type AutomationWorkerServiceProof,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';
import { loadBrowserWorkerHeartbeatConfig } from './config';
import * as workerConfig from './config';
import {
  BrowserWorkerHeartbeatClientError,
  createBrowserWorkerHeartbeatClient,
  createBrowserWorkerMtlsHeartbeatTransport,
  runBrowserWorkerHeartbeatLoop,
} from './heartbeat-client';

const NOW = new Date('2026-07-23T04:00:00.000Z');
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const EVENT_ID = '60000000-0000-4000-a000-000000000001';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'AA:BB:CC:DD';
const WORKER_SECRET = 'worker-shared-secret-at-least-thirty-two-bytes';

type HeartbeatWireBody = Readonly<{
  proof: AutomationWorkerServiceProof;
  heartbeat: AutomationWorkerHeartbeat;
}>;

const request = {
  protocol_version: 'automation.v1' as const,
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser' as const,
  steps: [
    {
      step_id: STEP_ID,
      sequence: 1,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe' as const,
      action_hash: `sha256:${'a'.repeat(64)}` as const,
    },
  ],
  capability_requirements: [
    {
      capability: 'browser.wait',
      methods: ['wait'],
      scope: {},
    },
  ],
  approval_policy: 'project-default' as const,
  browser_policy: {
    allowed_origins: ['https://example.test'],
    network_mode: 'allowlist' as const,
    open_network_expires_at: null,
    context: { mode: 'temporary' as const, profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'heartbeat-client-request-0001',
  deadline_at: '2026-07-24T04:00:00.000Z',
  traceparent: null,
};

const lease = {
  lease_id: LEASE_ID,
  job_id: JOB_ID,
  project_id: PROJECT_ID,
  execution_domain: 'browser' as const,
  owner: `${WORKER_ID}:${LEASE_ID}`,
  permission_id: null,
  request_hash: `sha256:${'b'.repeat(64)}` as const,
  kill_switch_generation: 2,
  issued_at: '2026-07-23T03:59:00.000Z',
  expires_at: '2026-07-24T04:00:00.000Z',
  signature: `hmac-sha256:${'c'.repeat(64)}` as const,
};

function acceptedEvent(sequence: number, payload: Record<string, unknown>): AutomationEvent {
  return {
    protocol_version: 'automation.v1',
    event_id: EVENT_ID,
    job_id: JOB_ID,
    sequence,
    type: 'heartbeat',
    status: null,
    payload,
    trace_id: null,
    created_at: NOW.toISOString(),
  };
}

describe('Browser Worker heartbeat client', () => {
  test('keeps inbound dispatch disabled and requires heartbeat plus separate Control trust', () => {
    const loadDispatchConfig = (
      workerConfig as typeof workerConfig & {
        loadBrowserWorkerDispatchConfig?: (
          environment: Readonly<Record<string, string | undefined>>,
        ) => unknown;
      }
    ).loadBrowserWorkerDispatchConfig;
    expect(typeof loadDispatchConfig).toBe('function');
    if (loadDispatchConfig === undefined) return;

    expect(loadDispatchConfig({})).toEqual({ enabled: false });
    expect(() =>
      loadDispatchConfig({
        AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
        AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'false',
      }),
    ).toThrow(/heartbeat/i);
    expect(
      loadDispatchConfig({
        AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
        AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
        AUTOMATION_CONTROL_SERVICE_ID: 'automation-control',
        AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: '11:22:33:44',
        AUTOMATION_CONTROL_WORKER_SHARED_SECRET: 'control-proof-secret-at-least-thirty-two-bytes',
        AUTOMATION_BROWSER_SERVICE_ID: WORKER_ID,
        AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256: WORKER_FINGERPRINT,
        AUTOMATION_BROWSER_WORKER_SHARED_SECRET: WORKER_SECRET,
        AUTOMATION_BROWSER_TLS_ATTESTATION_SECRET:
          'worker-proxy-attestation-at-least-thirty-two-bytes',
        AUTOMATION_BROWSER_DISPATCH_MAX_MESSAGE_BYTES: '65536',
        AUTOMATION_BROWSER_DISPATCH_PROOF_SKEW_MS: '45000',
      }),
    ).toEqual({
      enabled: true,
      approvalResumeEnabled: false,
      controlServiceId: 'automation-control',
      controlCertificateFingerprint256: '11:22:33:44',
      controlSharedSecret: 'control-proof-secret-at-least-thirty-two-bytes',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      tlsAttestationSecret: 'worker-proxy-attestation-at-least-thirty-two-bytes',
      maxMessageBytes: 65_536,
      proofSkewMs: 45_000,
    });
  });

  test('keeps outbound heartbeat and mTLS credentials disabled by default', () => {
    expect(loadBrowserWorkerHeartbeatConfig({})).toEqual({ enabled: false });
    expect(() =>
      loadBrowserWorkerHeartbeatConfig({ AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'yes' }),
    ).toThrow(/true or false/);
  });

  test('requires an HTTPS control URL, Worker proof secret, and absolute mTLS mounts', () => {
    const certificatePath = resolve('secrets/browser-worker.crt');
    const keyPath = resolve('secrets/browser-worker.key');
    const caPath = resolve('secrets/control-ca.crt');
    const enabled = loadBrowserWorkerHeartbeatConfig({
      AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
      AUTOMATION_CONTROL_URL: 'https://automation-control.internal:4011',
      AUTOMATION_BROWSER_SERVICE_ID: WORKER_ID,
      AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256: WORKER_FINGERPRINT,
      AUTOMATION_BROWSER_WORKER_SHARED_SECRET: WORKER_SECRET,
      AUTOMATION_BROWSER_MTLS_CERT_PATH: certificatePath,
      AUTOMATION_BROWSER_MTLS_KEY_PATH: keyPath,
      AUTOMATION_BROWSER_MTLS_CA_PATH: caPath,
      AUTOMATION_BROWSER_HEARTBEAT_INTERVAL_MS: '12000',
      AUTOMATION_BROWSER_HEARTBEAT_REQUEST_TIMEOUT_MS: '4000',
    });

    expect(enabled).toEqual({
      enabled: true,
      controlUrl: 'https://automation-control.internal:4011/',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      mtlsCertificatePath: certificatePath,
      mtlsPrivateKeyPath: keyPath,
      mtlsCaPath: caPath,
      intervalMs: 12_000,
      requestTimeoutMs: 4_000,
    });
    expect(() =>
      loadBrowserWorkerHeartbeatConfig({
        AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
        AUTOMATION_CONTROL_URL: 'http://automation-control.internal:4011',
      }),
    ).toThrow(/HTTPS/);
  });

  test('pins the configured client certificate, key, CA, and server identity in Bun fetch', async () => {
    const config = loadBrowserWorkerHeartbeatConfig({
      AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
      AUTOMATION_CONTROL_URL: 'https://automation-control.internal:4011',
      AUTOMATION_BROWSER_SERVICE_ID: WORKER_ID,
      AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256: WORKER_FINGERPRINT,
      AUTOMATION_BROWSER_WORKER_SHARED_SECRET: WORKER_SECRET,
      AUTOMATION_BROWSER_MTLS_CERT_PATH: resolve('secrets/browser-worker.crt'),
      AUTOMATION_BROWSER_MTLS_KEY_PATH: resolve('secrets/browser-worker.key'),
      AUTOMATION_BROWSER_MTLS_CA_PATH: resolve('secrets/control-ca.crt'),
    });
    if (!config.enabled) throw new Error('test heartbeat config must be enabled');
    let captured: BunFetchRequestInit | undefined;
    const transport = createBrowserWorkerMtlsHeartbeatTransport(config, async (_url, init) => {
      captured = init;
      return new Response('{}');
    });

    await transport('https://automation-control.internal:4011/health', { method: 'GET' });

    expect(captured?.tls).toMatchObject({
      rejectUnauthorized: true,
      serverName: 'automation-control.internal',
    });
    expect((captured?.tls?.cert as Bun.BunFile).name).toBe(config.mtlsCertificatePath);
    expect((captured?.tls?.key as Bun.BunFile).name).toBe(config.mtlsPrivateKeyPath);
    expect((captured?.tls?.ca as Bun.BunFile).name).toBe(config.mtlsCaPath);
  });

  test('sends sequential signed heartbeats without spoofable TLS attestation headers', async () => {
    const calls: Array<{ url: string; init: RequestInit; body: HeartbeatWireBody }> = [];
    const nonces = [101, 102];
    const client = createBrowserWorkerHeartbeatClient({
      controlUrl: 'https://automation-control.internal:4011',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      now: () => NOW,
      nextNonce: () => nonces.shift() ?? 0,
      transport: async (url, init) => {
        const body = JSON.parse(String(init.body)) as HeartbeatWireBody;
        calls.push({ url: String(url), init, body });
        const event = acceptedEvent(
          calls.length,
          body.heartbeat.event.payload as Record<string, unknown>,
        );
        return Response.json({ protocol_version: 'automation.v1', accepted: true, event });
      },
    });

    await client.send({ lease, request, lastCompletedStep: 0 });
    await client.send({ lease, request, lastCompletedStep: 1 });

    expect(calls.map((call) => call.url)).toEqual([
      'https://automation-control.internal:4011/internal/automation/browser/heartbeat',
      'https://automation-control.internal:4011/internal/automation/browser/heartbeat',
    ]);
    expect(calls.map((call) => call.body.heartbeat.ordinal)).toEqual([1, 2]);
    expect(
      calls.map((call) => {
        const event = call.body.heartbeat.event;
        if (event.type !== 'heartbeat') throw new Error('expected heartbeat event');
        return event.payload.last_completed_step;
      }),
    ).toEqual([0, 1]);
    expect(calls.map((call) => call.body.proof.nonce)).toEqual([101, 102]);
    const headerNames: string[] = [];
    new Headers(calls[0]?.init.headers).forEach((_value, name) => headerNames.push(name));
    expect(headerNames).toEqual(['content-type']);

    for (const call of calls) {
      const heartbeat = call.body.heartbeat;
      const proof = call.body.proof;
      const bodySha256 = createHash('sha256')
        .update(canonicalAutomationRequestJson(heartbeat))
        .digest('hex');
      const expected = createHmac('sha256', WORKER_SECRET)
        .update(
          canonicalAutomationWorkerProof({
            timestamp: proof.timestamp,
            serviceId: WORKER_ID,
            certificateFingerprint256: WORKER_FINGERPRINT,
            nonce: proof.nonce,
            bodySha256,
          }),
        )
        .digest('hex');
      expect(proof.signature).toBe(`hmac-sha256:${expected}`);
      expect(heartbeat.worker_id).toBe(WORKER_ID);
      expect(heartbeat.account_id).toBe(ACCOUNT_ID);
      expect(heartbeat.lease_owner).toBe(lease.owner);
    }
    client.closeLease?.(LEASE_ID);
    await expect(client.send({ lease, request, lastCompletedStep: 1 })).rejects.toMatchObject({
      reason: 'protocol',
      message: 'Browser Worker heartbeat lease is already closed',
    });
    expect(calls).toHaveLength(2);
  });

  test('fails the lease stream closed after a rejected or malformed response', async () => {
    let calls = 0;
    const client = createBrowserWorkerHeartbeatClient({
      controlUrl: 'https://automation-control.internal:4011',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      now: () => NOW,
      nextNonce: () => 201 + calls,
      transport: async () => {
        calls += 1;
        return Response.json(
          {
            protocol_version: 'automation.v1',
            code: 'AUTOMATION_LEASE_EXPIRED',
            message: 'internal lease owner must not leak',
            retryable: false,
            approval_status: null,
            audit_event_id: null,
          },
          { status: 409 },
        );
      },
    });

    await expect(client.send({ lease, request, lastCompletedStep: 0 })).rejects.toMatchObject({
      name: 'BrowserWorkerHeartbeatClientError',
      reason: 'rejected',
      message: 'Browser Worker heartbeat was rejected',
      response: { status: 409, code: 'AUTOMATION_LEASE_EXPIRED', retryable: false },
    });
    await expect(client.send({ lease, request, lastCompletedStep: 0 })).rejects.toMatchObject({
      reason: 'transport',
      message: 'Browser Worker heartbeat stream is no longer usable',
    });
    expect(calls).toBe(1);
  });

  test('aborts a hanging transport at the request deadline', async () => {
    const client = createBrowserWorkerHeartbeatClient({
      controlUrl: 'https://automation-control.internal:4011',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      now: () => NOW,
      nextNonce: () => 301,
      requestTimeoutMs: 20,
      transport: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });

    await expect(client.send({ lease, request, lastCompletedStep: 0 })).rejects.toMatchObject({
      reason: 'transport',
      message: 'Browser Worker heartbeat transport failed',
    });
  });

  test('applies the request deadline while a response body is still streaming', async () => {
    const client = createBrowserWorkerHeartbeatClient({
      controlUrl: 'https://automation-control.internal:4011',
      serviceId: WORKER_ID,
      certificateFingerprint256: WORKER_FINGERPRINT,
      sharedSecret: WORKER_SECRET,
      now: () => NOW,
      nextNonce: () => 401,
      requestTimeoutMs: 20,
      transport: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });

    await expect(client.send({ lease, request, lastCompletedStep: 0 })).rejects.toMatchObject({
      reason: 'transport',
      message: 'Browser Worker heartbeat transport failed',
    });
  });

  test('runs periodic heartbeat serially and stops on execution abort', async () => {
    const controller = new AbortController();
    let lastCompletedStep = 0;
    const sent: number[] = [];
    const loop = runBrowserWorkerHeartbeatLoop({
      emitter: {
        intervalMs: 5,
        async send(input) {
          sent.push(input.lastCompletedStep);
          if (sent.length === 1) lastCompletedStep = 1;
          if (sent.length === 2) controller.abort('execution completed');
          return acceptedEvent(sent.length, { last_completed_step: input.lastCompletedStep });
        },
      },
      lease,
      request,
      getLastCompletedStep: () => lastCompletedStep,
      signal: controller.signal,
    });

    await loop;

    expect(sent).toEqual([0, 1]);
  });
});
