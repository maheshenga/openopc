import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTOMATION_BROWSER_DISPATCH_PATH,
  type AutomationBrowserDispatchAccepted,
  AutomationBrowserDispatchAcceptedSchema,
  type AutomationBrowserDispatchEnvelope,
  AutomationBrowserDispatchRequestSchema,
  type AutomationWorkerServiceProof,
  canonicalAutomationRequestJson,
  canonicalAutomationWorkerProof,
} from '@kortix/intelligence-contracts';
import type { BrowserWorkerDispatchConfig } from './config';
import type { AuthenticatedRequestSource, BrowserWorkerEnvelope } from './worker';

const HEADER = {
  serviceId: 'x-automation-control-service-id',
  certificateFingerprint: 'x-automation-control-certificate-fingerprint',
  certificateValidTo: 'x-automation-control-certificate-valid-to',
  attestedAt: 'x-automation-control-tls-attested-at',
  attestation: 'x-automation-control-tls-attestation',
} as const;

export type ControlTlsCertificate = Readonly<{
  authorized: boolean;
  serviceId: string;
  fingerprint256: string;
  validTo: string;
}>;

export type VerifiedControlPeer = Readonly<{
  serviceId: string;
  certificateFingerprint256: string;
  certificateExpiresAt: string;
}>;

export type BrowserDispatchWorkItem = Readonly<{
  envelope: AutomationBrowserDispatchEnvelope;
  signal: AbortSignal;
}>;

type ControlTlsAttestationInput = Readonly<{
  secret: string;
  timestamp: Date;
  method: string;
  path: string;
  certificate: ControlTlsCertificate;
}>;

export class BrowserWorkerDispatchSourceError extends Error {
  override readonly name = 'BrowserWorkerDispatchSourceError';
}

function emptyBodyHash(): string {
  return `sha256:${createHash('sha256').update(new Uint8Array()).digest('hex')}`;
}

function canonicalControlTlsAttestation(input: Omit<ControlTlsAttestationInput, 'secret'>): string {
  return [
    input.timestamp.toISOString(),
    input.certificate.serviceId,
    input.certificate.fingerprint256,
    input.certificate.validTo,
    input.method.toUpperCase(),
    input.path,
    emptyBodyHash(),
  ].join('\n');
}

function attestationSignature(input: ControlTlsAttestationInput): string {
  return `hmac-sha256:${createHmac('sha256', input.secret)
    .update(canonicalControlTlsAttestation(input))
    .digest('hex')}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bodyHash(body: unknown): string {
  return createHash('sha256').update(canonicalAutomationRequestJson(body)).digest('hex');
}

function serviceProofSignature(input: {
  serviceId: string;
  certificateFingerprint256: string;
  secret: string;
  timestamp: string;
  nonce: number;
  body: unknown;
}): string {
  return `hmac-sha256:${createHmac('sha256', input.secret)
    .update(
      canonicalAutomationWorkerProof({
        timestamp: input.timestamp,
        serviceId: input.serviceId,
        certificateFingerprint256: input.certificateFingerprint256,
        nonce: input.nonce,
        bodySha256: bodyHash(input.body),
      }),
    )
    .digest('hex')}`;
}

function verifyControlProof(input: {
  proof: AutomationWorkerServiceProof;
  body: unknown;
  config: Extract<BrowserWorkerDispatchConfig, { enabled: true }>;
  now: Date;
  previousNonce: number;
}): void {
  const timestamp = new Date(input.proof.timestamp);
  const expected = serviceProofSignature({
    serviceId: input.config.controlServiceId,
    certificateFingerprint256: input.config.controlCertificateFingerprint256,
    secret: input.config.controlSharedSecret,
    timestamp: input.proof.timestamp,
    nonce: input.proof.nonce,
    body: input.body,
  });
  if (
    input.proof.service_id !== input.config.controlServiceId ||
    !Number.isFinite(timestamp.getTime()) ||
    Math.abs(input.now.getTime() - timestamp.getTime()) > input.config.proofSkewMs ||
    input.proof.nonce <= input.previousNonce ||
    !signaturesEqual(input.proof.signature, expected)
  ) {
    throw new BrowserWorkerDispatchSourceError('Control dispatch authentication failed');
  }
}

function workerProof(input: {
  body: unknown;
  config: Extract<BrowserWorkerDispatchConfig, { enabled: true }>;
  timestamp: Date;
  nonce: number;
}): AutomationWorkerServiceProof {
  if (!Number.isSafeInteger(input.nonce) || input.nonce < 1) {
    throw new BrowserWorkerDispatchSourceError('Worker proof nonce is invalid');
  }
  const timestamp = input.timestamp.toISOString();
  return Object.freeze({
    service_id: input.config.serviceId,
    timestamp,
    nonce: input.nonce,
    signature: serviceProofSignature({
      serviceId: input.config.serviceId,
      certificateFingerprint256: input.config.certificateFingerprint256,
      secret: input.config.sharedSecret,
      timestamp,
      nonce: input.nonce,
      body: input.body,
    }),
  });
}

export function createControlTlsAttestationHeaders(
  input: ControlTlsAttestationInput,
): Record<string, string> {
  if (!input.certificate.authorized) {
    throw new BrowserWorkerDispatchSourceError(
      'TLS proxy cannot attest an unauthorized Control certificate',
    );
  }
  if (input.secret.length < 32) {
    throw new BrowserWorkerDispatchSourceError('Control TLS proxy attestation is not configured');
  }
  return {
    [HEADER.serviceId]: input.certificate.serviceId,
    [HEADER.certificateFingerprint]: input.certificate.fingerprint256,
    [HEADER.certificateValidTo]: input.certificate.validTo,
    [HEADER.attestedAt]: input.timestamp.toISOString(),
    [HEADER.attestation]: attestationSignature(input),
  };
}

function bindControlPeer(
  request: Request,
  config: Extract<BrowserWorkerDispatchConfig, { enabled: true }>,
  now: Date,
): VerifiedControlPeer {
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const serviceId = request.headers.get(HEADER.serviceId) ?? '';
  const fingerprint256 = request.headers.get(HEADER.certificateFingerprint) ?? '';
  const validTo = request.headers.get(HEADER.certificateValidTo) ?? '';
  const attestedAtText = request.headers.get(HEADER.attestedAt) ?? '';
  const receivedAttestation = request.headers.get(HEADER.attestation) ?? '';
  const attestedAt = new Date(attestedAtText);
  const certificate: ControlTlsCertificate = {
    authorized: true,
    serviceId,
    fingerprint256,
    validTo,
  };
  if (
    request.method !== 'GET' ||
    request.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
    path !== AUTOMATION_BROWSER_DISPATCH_PATH ||
    serviceId !== config.controlServiceId ||
    fingerprint256 !== config.controlCertificateFingerprint256 ||
    serviceId.length > 128 ||
    fingerprint256.length > 256 ||
    validTo.length > 64 ||
    attestedAtText.length > 64 ||
    !Number.isFinite(Date.parse(validTo)) ||
    Date.parse(validTo) <= now.getTime() ||
    !Number.isFinite(attestedAt.getTime()) ||
    Math.abs(now.getTime() - attestedAt.getTime()) > config.proofSkewMs ||
    !/^hmac-sha256:[a-f0-9]{64}$/.test(receivedAttestation)
  ) {
    throw new BrowserWorkerDispatchSourceError('Control connection authentication failed');
  }
  const expectedAttestation = attestationSignature({
    secret: config.tlsAttestationSecret,
    timestamp: attestedAt,
    method: request.method,
    path,
    certificate,
  });
  if (!signaturesEqual(receivedAttestation, expectedAttestation)) {
    throw new BrowserWorkerDispatchSourceError('Control connection authentication failed');
  }
  return Object.freeze({
    serviceId,
    certificateFingerprint256: fingerprint256,
    certificateExpiresAt: new Date(validTo).toISOString(),
  });
}

export function createBrowserWorkerDispatchSource(input: {
  config: BrowserWorkerDispatchConfig;
  now?: () => Date;
  nextNonce: () => number;
}) {
  if (!input.config.enabled) {
    throw new BrowserWorkerDispatchSourceError('Browser Worker dispatch source is not enabled');
  }
  const config = input.config;
  const now = input.now ?? (() => new Date());
  let sessionOpen = false;
  let lastControlNonce = 0;
  let lastWorkerNonce = 0;
  let closed = false;
  let pending:
    | Readonly<{
        request: BrowserDispatchWorkItem;
        session: symbol;
        controller: AbortController;
      }>
    | undefined;
  let active: typeof pending;
  let waiter:
    | Readonly<{
        resolve: (value: BrowserWorkerEnvelope<BrowserDispatchWorkItem> | null) => void;
        signal: AbortSignal;
        onAbort: () => void;
      }>
    | undefined;

  const activatePending = (): BrowserWorkerEnvelope<BrowserDispatchWorkItem> | null => {
    if (pending === undefined) return null;
    active = pending;
    pending = undefined;
    return Object.freeze({ authenticated: true, request: active.request });
  };

  const deliverPending = (): void => {
    if (waiter === undefined || pending === undefined) return;
    const current = waiter;
    waiter = undefined;
    current.signal.removeEventListener('abort', current.onAbort);
    current.resolve(activatePending());
  };

  const source: AuthenticatedRequestSource<BrowserDispatchWorkItem> = {
    async next(signal) {
      if (signal.aborted || closed) return null;
      const ready = activatePending();
      if (ready !== null) return ready;
      if (waiter !== undefined) {
        throw new BrowserWorkerDispatchSourceError('Browser Worker source already has a waiter');
      }
      return new Promise((resolve) => {
        const onAbort = () => {
          if (waiter?.onAbort !== onAbort) return;
          waiter = undefined;
          resolve(null);
        };
        waiter = { resolve, signal, onAbort };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    },
    async acknowledge(request) {
      if (active?.request !== request) {
        throw new BrowserWorkerDispatchSourceError(
          'Browser Worker dispatch acknowledgement is invalid',
        );
      }
      active = undefined;
    },
    async reject(request, reason) {
      if (active?.request !== request) {
        throw new BrowserWorkerDispatchSourceError('Browser Worker dispatch rejection is invalid');
      }
      active.controller.abort(reason);
      active = undefined;
    },
  };

  return {
    source,
    isReady() {
      return sessionOpen && !closed;
    },
    openSession(request: Request) {
      const peer = bindControlPeer(request, config, now());
      if (closed || sessionOpen) {
        throw new BrowserWorkerDispatchSourceError('Control connection is already open');
      }
      sessionOpen = true;
      const session = Symbol('control-dispatch-session');
      let sessionClosed = false;
      return {
        peer,
        async receive(
          message: string | Uint8Array,
          deliverReceipt: (
            accepted: AutomationBrowserDispatchAccepted,
          ) => boolean | Promise<boolean> = () => true,
        ): Promise<AutomationBrowserDispatchAccepted> {
          if (sessionClosed) {
            throw new BrowserWorkerDispatchSourceError('Control dispatch session is closed');
          }
          const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
          if (bytes.byteLength > config.maxMessageBytes) {
            throw new BrowserWorkerDispatchSourceError('Control dispatch message is too large');
          }
          let raw: unknown;
          try {
            raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          } catch {
            throw new BrowserWorkerDispatchSourceError('Control dispatch message is invalid');
          }
          const parsed = AutomationBrowserDispatchRequestSchema.safeParse(raw);
          if (!parsed.success) {
            throw new BrowserWorkerDispatchSourceError('Control dispatch message is invalid');
          }
          const checkedAt = now();
          verifyControlProof({
            proof: parsed.data.proof,
            body: parsed.data.envelope,
            config,
            now: checkedAt,
            previousNonce: lastControlNonce,
          });
          const { envelope, proof } = parsed.data;
          const requestHash = `sha256:${createHash('sha256')
            .update(canonicalAutomationRequestJson(envelope.request))
            .digest('hex')}`;
          if (
            proof.timestamp !== envelope.dispatched_at ||
            envelope.lease.request_hash !== requestHash ||
            !envelope.lease.owner.startsWith(`${config.serviceId}:`) ||
            Date.parse(envelope.lease.expires_at) <= checkedAt.getTime() ||
            Date.parse(envelope.request.deadline_at) <= checkedAt.getTime()
          ) {
            throw new BrowserWorkerDispatchSourceError('Control dispatch authority is invalid');
          }
          if (pending !== undefined || active !== undefined) {
            throw new BrowserWorkerDispatchSourceError('Browser Worker dispatch source is busy');
          }
          lastControlNonce = proof.nonce;
          const receipt = {
            protocol_version: 'automation.v1' as const,
            accepted: true,
            job_id: envelope.lease.job_id,
            lease_id: envelope.lease.lease_id,
            worker_id: config.serviceId,
            dispatch_envelope_hash: `sha256:${createHash('sha256')
              .update(canonicalAutomationRequestJson(envelope))
              .digest('hex')}`,
            dispatch_proof_nonce: proof.nonce,
            received_at: checkedAt.toISOString(),
          };
          const nonce = input.nextNonce();
          if (nonce <= lastWorkerNonce) {
            throw new BrowserWorkerDispatchSourceError('Worker proof nonce is invalid');
          }
          const accepted = AutomationBrowserDispatchAcceptedSchema.parse({
            protocol_version: 'automation.v1',
            receipt,
            proof: workerProof({ body: receipt, config, timestamp: checkedAt, nonce }),
          });
          lastWorkerNonce = nonce;
          let delivered = false;
          try {
            delivered = await deliverReceipt(accepted);
          } catch {
            delivered = false;
          }
          if (!delivered || sessionClosed) {
            throw new BrowserWorkerDispatchSourceError(
              'Browser Worker signed receipt was not delivered',
            );
          }
          const controller = new AbortController();
          pending = Object.freeze({
            session,
            controller,
            request: Object.freeze({ envelope, signal: controller.signal }),
          });
          deliverPending();
          return Object.freeze(accepted);
        },
        close() {
          if (sessionClosed) return;
          sessionClosed = true;
          if (pending?.session === session) {
            pending.controller.abort('Control dispatch connection closed');
            pending = undefined;
          }
          if (active?.session === session) {
            active.controller.abort('Control dispatch connection closed');
            active = undefined;
          }
          sessionOpen = false;
        },
      };
    },
    close(reason = 'Browser Worker dispatch source closed') {
      closed = true;
      pending?.controller.abort(reason);
      active?.controller.abort(reason);
      pending = undefined;
      active = undefined;
      sessionOpen = false;
      if (waiter !== undefined) {
        const current = waiter;
        waiter = undefined;
        current.signal.removeEventListener('abort', current.onAbort);
        current.resolve(null);
      }
    },
  };
}

export type BrowserWorkerDispatchRuntime = ReturnType<typeof createBrowserWorkerDispatchSource>;

export function startBrowserWorkerDispatchServer(input: {
  hostname?: string;
  port: number;
  config: BrowserWorkerDispatchConfig;
  runtime: BrowserWorkerDispatchRuntime;
}) {
  if (!input.config.enabled) {
    throw new BrowserWorkerDispatchSourceError('Browser Worker dispatch server is not enabled');
  }
  if (!Number.isSafeInteger(input.port) || input.port < 0 || input.port > 65_535) {
    throw new BrowserWorkerDispatchSourceError('Browser Worker dispatch port is invalid');
  }
  type DispatchSession = ReturnType<BrowserWorkerDispatchRuntime['openSession']>;
  const server = Bun.serve<{ session: DispatchSession }>({
    hostname: input.hostname ?? '0.0.0.0',
    port: input.port,
    fetch(request, bunServer) {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        return Response.json({
          status: 'healthy',
          authenticated_control_connected: input.runtime.isReady(),
        });
      }
      if (path === '/ready') {
        const ready = input.runtime.isReady();
        return Response.json(
          {
            status: ready ? 'ready' : 'waiting_for_authenticated_control',
            authenticated_control_connected: ready,
          },
          { status: ready ? 200 : 503 },
        );
      }
      if (path !== AUTOMATION_BROWSER_DISPATCH_PATH) {
        return Response.json({ code: 'AUTHENTICATED_SOURCE_REQUIRED' }, { status: 503 });
      }
      let session: DispatchSession;
      try {
        session = input.runtime.openSession(request);
      } catch {
        return Response.json({ code: 'AUTOMATION_UNAUTHORIZED' }, { status: 401 });
      }
      const upgraded = bunServer.upgrade(request, { data: { session } });
      if (!upgraded) {
        session.close();
        return Response.json({ code: 'AUTOMATION_INVALID_REQUEST' }, { status: 400 });
      }
      return undefined;
    },
    websocket: {
      maxPayloadLength: input.config.maxMessageBytes,
      backpressureLimit: input.config.maxMessageBytes,
      closeOnBackpressureLimit: true,
      idleTimeout: 30,
      async message(socket, message) {
        try {
          await socket.data.session.receive(
            typeof message === 'string' ? message : new Uint8Array(message),
            (accepted) => socket.send(canonicalAutomationRequestJson(accepted), true) >= 1,
          );
        } catch {
          socket.close(1008, 'dispatch rejected');
        }
      },
      close(socket) {
        socket.data.session.close();
      },
    },
  });

  let closePromise: Promise<void> | undefined;
  return {
    server,
    close(): Promise<void> {
      closePromise ??= Promise.resolve().then(() => {
        input.runtime.close();
        server.stop(true);
      });
      return closePromise;
    },
  };
}
