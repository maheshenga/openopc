import { expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  AutomationBrowserDispatchAcceptedSchema,
  AutomationJobRequestSchema,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';
import { loadBrowserWorkerDispatchConfig } from './config';

const NOW = new Date('2026-07-23T06:00:00.000Z');
const CONTROL_ID = 'automation-control';
const CONTROL_FINGERPRINT = '11:22:33:44';
const CONTROL_SECRET = 'control-proof-secret-at-least-thirty-two-bytes';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'AA:BB:CC:DD';
const WORKER_SECRET = 'worker-shared-secret-at-least-thirty-two-bytes';
const PROXY_SECRET = 'worker-proxy-attestation-at-least-thirty-two-bytes';
const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const ATTEMPT_ID = '70000000-0000-4000-a000-000000000001';

const config = {
  enabled: true as const,
  approvalResumeEnabled: false,
  controlServiceId: CONTROL_ID,
  controlCertificateFingerprint256: CONTROL_FINGERPRINT,
  controlSharedSecret: CONTROL_SECRET,
  serviceId: WORKER_ID,
  certificateFingerprint256: WORKER_FINGERPRINT,
  sharedSecret: WORKER_SECRET,
  tlsAttestationSecret: PROXY_SECRET,
  maxMessageBytes: 64 * 1024,
  proofSkewMs: 60_000,
};

const enabledEnvironment = {
  AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
  AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
  AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
  AUTOMATION_CONTROL_SERVICE_ID: CONTROL_ID,
  AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: CONTROL_FINGERPRINT,
  AUTOMATION_CONTROL_WORKER_SHARED_SECRET: CONTROL_SECRET,
  AUTOMATION_BROWSER_SERVICE_ID: WORKER_ID,
  AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256: WORKER_FINGERPRINT,
  AUTOMATION_BROWSER_WORKER_SHARED_SECRET: WORKER_SECRET,
  AUTOMATION_BROWSER_TLS_ATTESTATION_SECRET: PROXY_SECRET,
} as const;

const request = AutomationJobRequestSchema.parse({
  protocol_version: 'automation.v1',
  tenant_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  source_run_id: null,
  execution_domain: 'browser',
  steps: [
    {
      step_id: STEP_ID,
      sequence: 1,
      action: 'browser.wait',
      args: { milliseconds: 1 },
      risk: 'observe',
      action_hash: `sha256:${'a'.repeat(64)}`,
    },
  ],
  capability_requirements: [{ capability: 'browser.wait', methods: ['wait'], scope: {} }],
  approval_policy: 'project-default',
  browser_policy: {
    allowed_origins: ['https://example.test'],
    network_mode: 'allowlist',
    open_network_expires_at: null,
    context: { mode: 'temporary', profile_id: null },
  },
  desktop_policy: null,
  idempotency_key: 'dispatch-source-request-0001',
  deadline_at: '2026-07-24T06:00:00.000Z',
  traceparent: null,
});

const envelope = {
  protocol_version: 'automation.v1' as const,
  request,
  lease: {
    lease_id: LEASE_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: 'browser' as const,
    owner: `${WORKER_ID}:${LEASE_ID}`,
    permission_id: null,
    request_hash: `sha256:${createHash('sha256')
      .update(canonicalAutomationRequestJson(request))
      .digest('hex')}`,
    kill_switch_generation: 2,
    issued_at: '2026-07-23T05:59:00.000Z',
    expires_at: '2026-07-24T06:00:00.000Z',
    signature: `hmac-sha256:${'c'.repeat(64)}` as const,
  },
  policy_version: 'policy-v1',
  resume_after_sequence: 0,
  dispatched_at: NOW.toISOString(),
};

const resumeEnvelope = {
  ...envelope,
  dispatch_kind: 'browser.approval-resume.v1' as const,
  approval_resume: {
    approval_id: APPROVAL_ID,
    attempt_id: ATTEMPT_ID,
    step_id: STEP_ID,
    action_hash: request.steps[0]?.action_hash,
    token: `approval-resume.v1.${'A'.repeat(43)}`,
    expires_at: '2026-07-24T05:00:00.000Z',
  },
};

function proofFor(
  body: unknown,
  input: { serviceId: string; fingerprint: string; secret: string; nonce: number },
) {
  const bodySha256 = createHash('sha256')
    .update(canonicalAutomationRequestJson(body))
    .digest('hex');
  const signature = createHmac('sha256', input.secret)
    .update(
      canonicalAutomationWorkerProof({
        timestamp: NOW.toISOString(),
        serviceId: input.serviceId,
        certificateFingerprint256: input.fingerprint,
        nonce: input.nonce,
        bodySha256,
      }),
    )
    .digest('hex');
  return {
    service_id: input.serviceId,
    timestamp: NOW.toISOString(),
    nonce: input.nonce,
    signature: `hmac-sha256:${signature}`,
  };
}

async function openRuntime(nextNonce = () => 11, runtimeConfig: typeof config = config) {
  const dispatchSource = await import('./dispatch-source');
  const certificate = {
    authorized: true,
    serviceId: CONTROL_ID,
    fingerprint256: CONTROL_FINGERPRINT,
    validTo: '2026-07-24T06:00:00.000Z',
  };
  const headers = dispatchSource.createControlTlsAttestationHeaders({
    secret: PROXY_SECRET,
    timestamp: NOW,
    method: 'GET',
    path: '/internal/automation/browser/dispatch',
    certificate,
  });
  headers.upgrade = 'websocket';
  const runtime = dispatchSource.createBrowserWorkerDispatchSource({
    config: runtimeConfig,
    now: () => NOW,
    nextNonce,
  });
  const session = runtime.openSession(
    new Request('http://worker.internal/internal/automation/browser/dispatch', {
      method: 'GET',
      headers,
    }),
  );
  return { dispatchSource, runtime, session };
}

test('keeps approval resume disabled by default and requires dispatch when enabled', () => {
  expect(loadBrowserWorkerDispatchConfig({})).toEqual({ enabled: false });
  expect(() =>
    loadBrowserWorkerDispatchConfig({
      AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
      AUTOMATION_BROWSER_DISPATCH_ENABLED: 'false',
    }),
  ).toThrow(/approval resume requires dispatch/i);
  expect(loadBrowserWorkerDispatchConfig(enabledEnvironment)).toMatchObject({
    enabled: true,
    approvalResumeEnabled: true,
  });
});

test('rejects disabled Resume work before queueing and advertises enabled capability', async () => {
  const disabled = await openRuntime(() => 11, { ...config, approvalResumeEnabled: false });
  const disabledMessage = dispatchMessage(7, resumeEnvelope);
  await expect(disabled.session.receive(disabledMessage)).rejects.toThrow(
    'Browser approval resume capability is disabled',
  );
  const disabledSignal = new AbortController();
  disabledSignal.abort('no work expected');
  await expect(disabled.runtime.source.next(disabledSignal.signal)).resolves.toBeNull();

  const enabled = await openRuntime(() => 11, { ...config, approvalResumeEnabled: true });
  const accepted = await enabled.session.receive(dispatchMessage(7, resumeEnvelope));
  expect(accepted.receipt.capabilities).toContain('browser.approval-resume.v1');
  const item = await enabled.runtime.source.next(new AbortController().signal);
  expect(item?.request.envelope).toEqual(resumeEnvelope);
});

function dispatchMessage(nonce: number, body = envelope): string {
  return JSON.stringify({
    protocol_version: 'automation.v1',
    envelope: body,
    proof: proofFor(body, {
      serviceId: CONTROL_ID,
      fingerprint: CONTROL_FINGERPRINT,
      secret: CONTROL_SECRET,
      nonce,
    }),
  });
}

test('binds a Control connection only through a signed TLS proxy upgrade attestation', async () => {
  const dispatchSource = await import('./dispatch-source').catch(() => null);
  expect(dispatchSource).not.toBeNull();
  if (dispatchSource === null) return;

  const certificate = {
    authorized: true,
    serviceId: CONTROL_ID,
    fingerprint256: CONTROL_FINGERPRINT,
    validTo: '2026-07-24T06:00:00.000Z',
  };
  const path = '/internal/automation/browser/dispatch';
  const headers = dispatchSource.createControlTlsAttestationHeaders({
    secret: PROXY_SECRET,
    timestamp: NOW,
    method: 'GET',
    path,
    certificate,
  });
  headers.upgrade = 'websocket';
  const runtime = dispatchSource.createBrowserWorkerDispatchSource({
    config,
    now: () => NOW,
    nextNonce: () => 1,
  });

  const session = runtime.openSession(
    new Request(`http://worker.internal${path}`, { method: 'GET', headers }),
  );
  expect(session.peer).toMatchObject({
    serviceId: CONTROL_ID,
    certificateFingerprint256: CONTROL_FINGERPRINT,
  });
  expect(() =>
    runtime.openSession(
      new Request(`http://worker.internal${path}?tampered=1`, { method: 'GET', headers }),
    ),
  ).toThrow(/authentication/i);
});

test('normalizes malformed TLS proxy metadata to a generic authentication failure', async () => {
  const dispatchSource = await import('./dispatch-source');
  const runtime = dispatchSource.createBrowserWorkerDispatchSource({
    config,
    now: () => NOW,
    nextNonce: () => 1,
  });
  const headers = {
    upgrade: 'websocket',
    'x-automation-control-service-id': CONTROL_ID,
    'x-automation-control-certificate-fingerprint': CONTROL_FINGERPRINT,
    'x-automation-control-certificate-valid-to': '2026-07-24T06:00:00.000Z',
    'x-automation-control-tls-attested-at': 'not-a-date',
    'x-automation-control-tls-attestation': `hmac-sha256:${'a'.repeat(64)}`,
  };

  expect(() =>
    runtime.openSession(
      new Request('http://worker.internal/internal/automation/browser/dispatch', {
        method: 'GET',
        headers,
      }),
    ),
  ).toThrow(/authentication failed/i);
});

test('authenticates and accepts one dispatch with a body-bound signed Worker receipt', async () => {
  const { session } = await openRuntime();
  expect(typeof (session as { receive?: unknown }).receive).toBe('function');
  if (!('receive' in session) || typeof session.receive !== 'function') return;
  const controlProof = proofFor(envelope, {
    serviceId: CONTROL_ID,
    fingerprint: CONTROL_FINGERPRINT,
    secret: CONTROL_SECRET,
    nonce: 7,
  });

  const accepted = AutomationBrowserDispatchAcceptedSchema.parse(
    await session.receive(
      JSON.stringify({
        protocol_version: 'automation.v1',
        envelope,
        proof: controlProof,
      }),
    ),
  );

  expect(accepted.receipt).toMatchObject({
    accepted: true,
    job_id: JOB_ID,
    lease_id: LEASE_ID,
    worker_id: WORKER_ID,
    dispatch_proof_nonce: 7,
  });
  expect(accepted.receipt.dispatch_envelope_hash).toBe(
    `sha256:${createHash('sha256').update(canonicalAutomationRequestJson(envelope)).digest('hex')}`,
  );
  expect(accepted.proof).toEqual(
    proofFor(accepted.receipt, {
      serviceId: WORKER_ID,
      fingerprint: WORKER_FINGERPRINT,
      secret: WORKER_SECRET,
      nonce: 11,
    }),
  );
});

test('exposes only authenticated work and allows no second queued or active dispatch', async () => {
  const workerNonces = [11, 12];
  const { runtime, session } = await openRuntime(() => workerNonces.shift() ?? 0);
  expect('source' in runtime).toBeTrue();
  if (!('source' in runtime)) return;

  await session.receive(dispatchMessage(7));
  const controller = new AbortController();
  const item = await runtime.source.next(controller.signal);
  expect(item).not.toBeNull();
  expect(item).toMatchObject({
    authenticated: true,
    request: { envelope: { lease: { lease_id: LEASE_ID } } },
  });
  await expect(session.receive(dispatchMessage(8))).rejects.toThrow(/busy/i);
  if (item === null) return;
  await runtime.source.acknowledge(item.request);

  await expect(session.receive(dispatchMessage(8))).resolves.toMatchObject({
    receipt: { dispatch_proof_nonce: 8 },
  });
});

test('aborts connection-owned work and permanently closes that session', async () => {
  const workerNonces = [11, 12];
  const { runtime, session } = await openRuntime(() => workerNonces.shift() ?? 0);
  await session.receive(dispatchMessage(7));
  const item = await runtime.source.next(new AbortController().signal);
  if (item === null) throw new Error('test dispatch must be available');

  session.close();

  expect(item.request.signal.aborted).toBeTrue();
  await expect(session.receive(dispatchMessage(8))).rejects.toThrow(/closed/i);
});

test('rejects replayed, tampered, malformed, and oversized dispatch messages', async () => {
  const { runtime, session } = await openRuntime(() => 11);
  await session.receive(dispatchMessage(7));
  const item = await runtime.source.next(new AbortController().signal);
  if (item === null) throw new Error('test dispatch must be available');
  await runtime.source.acknowledge(item.request);

  await expect(session.receive(dispatchMessage(7))).rejects.toThrow(/authentication/i);
  const tampered = { ...envelope, policy_version: 'tampered-policy' };
  const proof = proofFor(envelope, {
    serviceId: CONTROL_ID,
    fingerprint: CONTROL_FINGERPRINT,
    secret: CONTROL_SECRET,
    nonce: 8,
  });
  await expect(
    session.receive(
      JSON.stringify({ protocol_version: 'automation.v1', envelope: tampered, proof }),
    ),
  ).rejects.toThrow(/authentication/i);
  await expect(session.receive('{not-json')).rejects.toThrow(/invalid/i);
  await expect(session.receive('x'.repeat(config.maxMessageBytes + 1))).rejects.toThrow(/large/i);
});

test('does not expose work until the signed receipt is accepted by the transport', async () => {
  const { runtime, session } = await openRuntime(() => 11);
  await expect(session.receive(dispatchMessage(7), async () => false)).rejects.toThrow(/receipt/i);
  const controller = new AbortController();
  const waiting = runtime.source.next(controller.signal);
  controller.abort('test complete');
  await expect(waiting).resolves.toBeNull();
});

test('serves the authenticated source over a bounded WebSocket and reports connection readiness', async () => {
  const dispatchSource = await import('./dispatch-source');
  expect(
    typeof (dispatchSource as { startBrowserWorkerDispatchServer?: unknown })
      .startBrowserWorkerDispatchServer,
  ).toBe('function');
  if (!('startBrowserWorkerDispatchServer' in dispatchSource)) return;
  const certificate = {
    authorized: true,
    serviceId: CONTROL_ID,
    fingerprint256: CONTROL_FINGERPRINT,
    validTo: '2026-07-24T06:00:00.000Z',
  };
  const path = '/internal/automation/browser/dispatch';
  const headers = dispatchSource.createControlTlsAttestationHeaders({
    secret: PROXY_SECRET,
    timestamp: NOW,
    method: 'GET',
    path,
    certificate,
  });
  const runtime = dispatchSource.createBrowserWorkerDispatchSource({
    config,
    now: () => NOW,
    nextNonce: () => 11,
  });
  const app = dispatchSource.startBrowserWorkerDispatchServer({
    hostname: '127.0.0.1',
    port: 0,
    config,
    runtime,
  });
  try {
    expect((await fetch(`http://127.0.0.1:${app.server.port}/ready`)).status).toBe(503);
    const BunWebSocket = WebSocket as unknown as {
      new (url: string | URL, options: Bun.WebSocketOptions): WebSocket;
    };
    const socket = new BunWebSocket(`ws://127.0.0.1:${app.server.port}${path}`, {
      headers,
      perMessageDeflate: false,
    });
    const accepted = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('test WebSocket timed out')), 2_000);
      socket.addEventListener('open', () => socket.send(dispatchMessage(7)), { once: true });
      socket.addEventListener(
        'message',
        (event) => {
          clearTimeout(timeout);
          resolve(JSON.parse(String(event.data)));
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('test WebSocket failed'));
        },
        { once: true },
      );
    });
    expect(AutomationBrowserDispatchAcceptedSchema.parse(accepted).receipt.job_id).toBe(JOB_ID);
    expect((await fetch(`http://127.0.0.1:${app.server.port}/ready`)).status).toBe(200);
    socket.close();
  } finally {
    await app.close();
  }
});
