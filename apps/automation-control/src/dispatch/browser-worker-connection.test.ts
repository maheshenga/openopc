import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import {
  type AutomationBrowserDispatchAccepted,
  type AutomationBrowserDispatchEnvelope,
  AutomationBrowserDispatchEnvelopeSchema,
  AutomationJobRequestSchema,
  type AutomationWorkerServiceProof,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import { loadAutomationControlConfig } from '../config';
import type { VerifiedWorkerPeer } from './worker-auth';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const WORKER_ID = 'browser-worker-1';
const WORKER_FINGERPRINT = 'AA:BB:CC:DD';

const workerPeer: VerifiedWorkerPeer = Object.freeze({
  serviceId: WORKER_ID,
  role: 'browser-worker',
  certificateFingerprint256: WORKER_FINGERPRINT,
  certificateExpiresAt: '2099-07-24T06:00:00.000Z',
});

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
  idempotency_key: 'browser-worker-connection-request-0001',
  deadline_at: '2099-07-24T06:00:00.000Z',
  traceparent: null,
});

const envelope: AutomationBrowserDispatchEnvelope = AutomationBrowserDispatchEnvelopeSchema.parse({
  protocol_version: 'automation.v1',
  request,
  lease: {
    lease_id: LEASE_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: 'browser',
    owner: `${WORKER_ID}:${LEASE_ID}`,
    permission_id: null,
    request_hash: `sha256:${createHash('sha256')
      .update(canonicalAutomationRequestJson(request))
      .digest('hex')}`,
    kill_switch_generation: 2,
    issued_at: '2099-07-23T05:59:00.000Z',
    expires_at: '2099-07-24T06:00:00.000Z',
    signature: `hmac-sha256:${'c'.repeat(64)}`,
  },
  policy_version: 'policy-v1',
  resume_after_sequence: 0,
  dispatched_at: '2099-07-23T06:00:00.000Z',
});

const controlProof: AutomationWorkerServiceProof = {
  service_id: 'automation-control',
  timestamp: envelope.dispatched_at,
  nonce: 7,
  signature: `hmac-sha256:${'d'.repeat(64)}`,
};

const receipt = {
  protocol_version: 'automation.v1' as const,
  accepted: true,
  job_id: JOB_ID,
  lease_id: LEASE_ID,
  worker_id: WORKER_ID,
  dispatch_envelope_hash: `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(envelope))
    .digest('hex')}` as const,
  dispatch_proof_nonce: controlProof.nonce,
  received_at: '2099-07-23T06:00:00.000Z',
};

const workerProof: AutomationWorkerServiceProof = {
  service_id: WORKER_ID,
  timestamp: receipt.received_at,
  nonce: 11,
  signature: `hmac-sha256:${'e'.repeat(64)}`,
};

const accepted: AutomationBrowserDispatchAccepted = {
  protocol_version: 'automation.v1',
  receipt,
  proof: workerProof,
};

const enabledEnvironment = {
  AUTOMATION_CONTROL_ENABLED: 'true',
  AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'true',
  AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
  DATABASE_URL: 'postgresql://db.example.test/automation',
  REDIS_URL: 'redis://redis.example.test:6379',
  AUTOMATION_CONTROL_SHARED_SECRET: 'control-shared-secret-at-least-thirty-two-bytes',
  AUTOMATION_BROWSER_WORKER_TRUST_JSON: JSON.stringify({
    [WORKER_ID]: {
      fingerprints: [WORKER_FINGERPRINT],
      shared_secret: 'worker-shared-secret-at-least-thirty-two-bytes',
    },
  }),
  AUTOMATION_WORKER_TLS_ATTESTATION_SECRET:
    'trusted-proxy-attestation-secret-at-least-thirty-two-bytes',
  AUTOMATION_BROWSER_WORKER_URL: 'wss://browser-worker.internal:4021',
  AUTOMATION_CONTROL_MTLS_CERT_PATH: resolve('secrets/automation-control.crt'),
  AUTOMATION_CONTROL_MTLS_KEY_PATH: resolve('secrets/automation-control.key'),
  AUTOMATION_CONTROL_MTLS_CA_PATH: resolve('secrets/browser-worker-ca.crt'),
  AUTOMATION_CONTROL_CERTIFICATE_FINGERPRINT256: '11:22:33:44',
  AUTOMATION_CONTROL_WORKER_SHARED_SECRET:
    'browser-worker-control-secret-at-least-thirty-two-bytes',
  AUTOMATION_BROWSER_DISPATCH_TIMEOUT_MS: '5000',
  AUTOMATION_BROWSER_DISPATCH_MAX_MESSAGE_BYTES: '65536',
} as const;

type DispatchConfig = Readonly<
  | { enabled: false }
  | {
      enabled: true;
      workerUrl: string;
      mtlsCertificatePath: string;
      mtlsPrivateKeyPath: string;
      mtlsCaPath: string;
      requestTimeoutMs: number;
      maxMessageBytes: number;
    }
>;

type SocketFactory = (url: string | URL, options: Bun.WebSocketOptions) => FakeWebSocket;

type ConnectionModule = Readonly<{
  createBrowserWorkerConnection(input: {
    config: DispatchConfig;
    peer: VerifiedWorkerPeer;
    webSocketFactory?: SocketFactory;
  }): Readonly<{
    peer: VerifiedWorkerPeer;
    state(): 'connecting' | 'ready' | 'unusable';
    subscribe(listener: (state: 'connecting' | 'ready' | 'unusable') => void): () => void;
    send(input: {
      envelope: AutomationBrowserDispatchEnvelope;
      proof: AutomationWorkerServiceProof;
    }): Promise<{ receipt: typeof receipt; proof: AutomationWorkerServiceProof }>;
    close(reason?: string): void;
  }>;
}>;

class FakeWebSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  message(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  remoteClose(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}

async function connectionModule(): Promise<ConnectionModule | null> {
  return import('./browser-worker-connection').catch(
    () => null,
  ) as Promise<ConnectionModule | null>;
}

function config(
  timeoutMs = 5_000,
  maxMessageBytes = 65_536,
): Extract<DispatchConfig, { enabled: true }> {
  return {
    enabled: true,
    workerUrl: 'wss://browser-worker.internal:4021/',
    mtlsCertificatePath: resolve('secrets/automation-control.crt'),
    mtlsPrivateKeyPath: resolve('secrets/automation-control.key'),
    mtlsCaPath: resolve('secrets/browser-worker-ca.crt'),
    requestTimeoutMs: timeoutMs,
    maxMessageBytes,
  };
}

test('keeps dispatch disabled by default and requires heartbeat, WSS, and absolute mTLS files', () => {
  expect(loadAutomationControlConfig({}).browserApprovalResumeEnabled).toBeFalse();
  expect(
    (loadAutomationControlConfig({}) as { browserDispatch?: unknown }).browserDispatch,
  ).toEqual({ enabled: false });
  expect(() =>
    loadAutomationControlConfig({
      ...enabledEnvironment,
      AUTOMATION_BROWSER_APPROVAL_RESUME_ENABLED: 'true',
      AUTOMATION_BROWSER_DISPATCH_ENABLED: 'false',
    }),
  ).toThrow(/approval resume requires Browser Worker dispatch/i);
  expect(() =>
    loadAutomationControlConfig({
      ...enabledEnvironment,
      AUTOMATION_BROWSER_HEARTBEAT_ENABLED: 'false',
    }),
  ).toThrow(/heartbeat/i);
  expect(() =>
    loadAutomationControlConfig({
      ...enabledEnvironment,
      AUTOMATION_BROWSER_WORKER_URL: 'ws://browser-worker.internal:4021',
    }),
  ).toThrow(/WSS/i);
  expect(() =>
    loadAutomationControlConfig({
      ...enabledEnvironment,
      AUTOMATION_CONTROL_MTLS_CERT_PATH: 'relative/control.crt',
    }),
  ).toThrow(/absolute/i);

  expect(
    (loadAutomationControlConfig(enabledEnvironment) as { browserDispatch?: unknown })
      .browserDispatch,
  ).toEqual(config());
});

test('opens only the shared dispatch path with pinned Bun mTLS and no proxy attestation headers', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  let capturedUrl: string | URL | undefined;
  let capturedOptions: Bun.WebSocketOptions | undefined;
  const connection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return socket;
    },
  });

  expect(String(capturedUrl)).toBe(
    'wss://browser-worker.internal:4021/internal/automation/browser/dispatch',
  );
  expect(capturedOptions?.tls).toMatchObject({
    rejectUnauthorized: true,
    serverName: 'browser-worker.internal',
  });
  expect((capturedOptions?.tls?.cert as Bun.BunFile).name).toBe(config().mtlsCertificatePath);
  expect((capturedOptions?.tls?.key as Bun.BunFile).name).toBe(config().mtlsPrivateKeyPath);
  expect((capturedOptions?.tls?.ca as Bun.BunFile).name).toBe(config().mtlsCaPath);
  expect(capturedOptions?.perMessageDeflate).toBeFalse();
  expect(capturedOptions?.headers).toBeUndefined();
  expect(connection.peer).toBe(workerPeer);
});

test('reports connecting, ready, and unusable socket lifecycle transitions', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  const connection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => socket,
  });
  const states: Array<'connecting' | 'ready' | 'unusable'> = [];
  const unsubscribe = connection.subscribe((state) => states.push(state));

  expect(connection.state()).toBe('connecting');
  socket.open();
  expect(connection.state()).toBe('ready');
  socket.remoteClose();
  expect(connection.state()).toBe('unusable');
  expect(states).toEqual(['ready', 'unusable']);

  unsubscribe();
  socket.dispatchEvent(new Event('close'));
  expect(states).toEqual(['ready', 'unusable']);
});

test('sends one strict dispatch and returns the exact accepted receipt for Dispatcher verification', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  const connection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => socket,
  });
  const pending = connection.send({ envelope, proof: controlProof });
  socket.open();

  expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
    protocol_version: 'automation.v1',
    envelope,
    proof: controlProof,
  });
  socket.message(canonicalAutomationRequestJson(accepted));

  await expect(pending).resolves.toEqual({ receipt, proof: workerProof });
});

test('rejects unrelated fields in either dispatch envelope variant before transport', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  const connection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => socket,
  });

  await expect(
    connection.send({
      envelope: {
        ...envelope,
        unrelated: true,
      } as unknown as AutomationBrowserDispatchEnvelope,
      proof: controlProof,
    }),
  ).rejects.toMatchObject({ reason: 'configuration' });
  expect(socket.sent).toHaveLength(0);
});

test('allows exactly one in-flight dispatch', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  const connection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => socket,
  });
  const first = connection.send({ envelope, proof: controlProof });

  await expect(connection.send({ envelope, proof: controlProof })).rejects.toThrow(/in.flight/i);
  socket.open();
  socket.message(canonicalAutomationRequestJson(accepted));
  await first;
  expect(socket.sent).toHaveLength(1);
});

test('fails timeout and connection close as an unknown dispatch result', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;

  const timeoutSocket = new FakeWebSocket();
  const timeoutConnection = module.createBrowserWorkerConnection({
    config: config(100),
    peer: workerPeer,
    webSocketFactory: () => timeoutSocket,
  });
  const timedOut = timeoutConnection.send({ envelope, proof: controlProof });
  timeoutSocket.open();
  await expect(timedOut).rejects.toMatchObject({ reason: 'unknown_result' });
  expect(timeoutSocket.closes).toHaveLength(1);

  const closedSocket = new FakeWebSocket();
  const closedConnection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => closedSocket,
  });
  const disconnected = closedConnection.send({ envelope, proof: controlProof });
  closedSocket.open();
  closedSocket.remoteClose();
  await expect(disconnected).rejects.toMatchObject({ reason: 'unknown_result' });
});

test('rejects non-strict, binary, and oversized accepted messages and fails closed', async () => {
  const module = await connectionModule();
  expect(module).not.toBeNull();
  if (module === null) return;
  const socket = new FakeWebSocket();
  const connection = module.createBrowserWorkerConnection({
    config: config(5_000, 4_096),
    peer: workerPeer,
    webSocketFactory: () => socket,
  });
  const pending = connection.send({ envelope, proof: controlProof });
  socket.open();
  socket.message(JSON.stringify({ ...accepted, unexpected: true }));

  await expect(pending).rejects.toMatchObject({ reason: 'unknown_result' });
  expect(socket.closes).toHaveLength(1);

  const binarySocket = new FakeWebSocket();
  const binaryConnection = module.createBrowserWorkerConnection({
    config: config(),
    peer: workerPeer,
    webSocketFactory: () => binarySocket,
  });
  const binaryPending = binaryConnection.send({ envelope, proof: controlProof });
  binarySocket.open();
  binarySocket.message(new Uint8Array([1, 2, 3]));
  await expect(binaryPending).rejects.toMatchObject({ reason: 'unknown_result' });

  const oversizedSocket = new FakeWebSocket();
  const oversizedConnection = module.createBrowserWorkerConnection({
    config: config(5_000, 4_096),
    peer: workerPeer,
    webSocketFactory: () => oversizedSocket,
  });
  const oversizedPending = oversizedConnection.send({ envelope, proof: controlProof });
  oversizedSocket.open();
  oversizedSocket.message('x'.repeat(4_097));
  await expect(oversizedPending).rejects.toMatchObject({ reason: 'unknown_result' });
});
