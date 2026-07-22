import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AUTOMATION_BROWSER_HEARTBEAT_PATH,
  type AutomationErrorCode,
  AutomationErrorSchema,
  type AutomationEvent,
  AutomationWorkerHeartbeatAcceptedSchema,
  AutomationWorkerServiceProofSchema,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import { type WorkerHeartbeat, WorkerHeartbeatError } from './heartbeat';
import {
  type TlsPeerCertificate,
  type VerifiedWorkerPeer,
  WorkerAuthenticationError,
  type WorkerServiceProof,
} from './worker-auth';
/*
 * The route authenticates two separate statements: a trusted proxy attests the TLS certificate,
 * then the Worker proof authenticates the heartbeat body. Neither statement can replace the
 * other.
 */

const HEADER = {
  serviceId: 'x-automation-worker-service-id',
  certificateFingerprint: 'x-automation-worker-certificate-fingerprint',
  certificateValidTo: 'x-automation-worker-certificate-valid-to',
  attestedAt: 'x-automation-worker-tls-attested-at',
  attestation: 'x-automation-worker-tls-attestation',
} as const;

export { AUTOMATION_BROWSER_HEARTBEAT_PATH };

const ServiceIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const WorkerRequestSchema = z
  .object({
    protocol_version: z.literal('automation.v1'),
    proof: AutomationWorkerServiceProofSchema,
    heartbeat: z.unknown(),
  })
  .strict();

type PeerBinder = Readonly<{
  bindTlsPeer(certificate: TlsPeerCertificate): VerifiedWorkerPeer;
}>;

type HeartbeatProcessor = Readonly<{
  handle(input: {
    peer: VerifiedWorkerPeer;
    proof: WorkerServiceProof;
    heartbeat: WorkerHeartbeat;
  }): Promise<AutomationEvent>;
}>;

export type BrowserWorkerHeartbeatRouteDependencies = Readonly<{
  tlsAttestationSecret: string;
  authenticator: PeerBinder;
  processor: HeartbeatProcessor;
  now?: () => Date;
  maxSkewMs?: number;
  maxBodyBytes?: number;
  bodyReadTimeoutMs?: number;
}>;

type TlsAttestationInput = Readonly<{
  secret: string;
  timestamp: Date;
  method: string;
  path: string;
  body: string | Uint8Array;
  certificate: TlsPeerCertificate;
}>;

function bodyHash(body: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function canonicalTlsAttestation(input: Omit<TlsAttestationInput, 'secret'>): string {
  return [
    input.timestamp.toISOString(),
    input.certificate.serviceId,
    input.certificate.fingerprint256,
    input.certificate.validTo,
    input.method.toUpperCase(),
    input.path,
    bodyHash(input.body),
  ].join('\n');
}

function attestationSignature(input: TlsAttestationInput): string {
  return `hmac-sha256:${createHmac('sha256', input.secret)
    .update(canonicalTlsAttestation(input))
    .digest('hex')}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createWorkerTlsAttestationHeaders(
  input: TlsAttestationInput,
): Record<string, string> {
  if (!input.certificate.authorized) {
    throw new Error('TLS proxy cannot attest an unauthorized Worker certificate');
  }
  if (input.secret.length < 32) {
    throw new Error('TLS proxy attestation secret is not configured');
  }
  return {
    [HEADER.serviceId]: input.certificate.serviceId,
    [HEADER.certificateFingerprint]: input.certificate.fingerprint256,
    [HEADER.certificateValidTo]: input.certificate.validTo,
    [HEADER.attestedAt]: input.timestamp.toISOString(),
    [HEADER.attestation]: attestationSignature(input),
  };
}

function protocolError(
  status: number,
  code: AutomationErrorCode,
  message: string,
  retryable: boolean,
): Response {
  return Response.json(
    AutomationErrorSchema.parse({
      protocol_version: 'automation.v1',
      code,
      message,
      retryable,
      approval_status: null,
      audit_event_id: null,
    }),
    { status },
  );
}

function unauthorized(): Response {
  return protocolError(
    401,
    'AUTOMATION_UNAUTHORIZED',
    'Browser Worker authentication failed',
    false,
  );
}

function payloadTooLarge(): Response {
  return protocolError(
    413,
    'AUTOMATION_INVALID_REQUEST',
    'Browser Worker heartbeat request is too large',
    false,
  );
}

function invalidRequest(): Response {
  return protocolError(
    400,
    'AUTOMATION_INVALID_REQUEST',
    'Browser Worker heartbeat request is invalid',
    false,
  );
}

function conflict(): Response {
  return protocolError(409, 'AUTOMATION_CONFLICT', 'Browser Worker heartbeat was rejected', false);
}

function leaseExpired(): Response {
  return protocolError(
    409,
    'AUTOMATION_LEASE_EXPIRED',
    'Browser Worker lease is no longer current',
    false,
  );
}

function requestTimeout(): Response {
  return protocolError(
    408,
    'AUTOMATION_INVALID_REQUEST',
    'Browser Worker heartbeat body was not received in time',
    true,
  );
}

function unavailable(): Response {
  return protocolError(
    503,
    'AUTOMATION_UNAVAILABLE',
    'Browser Worker heartbeat is temporarily unavailable',
    true,
  );
}

type BoundedBodyResult =
  | { accepted: true; body: Uint8Array }
  | { accepted: false; reason: 'too_large' | 'timed_out' };

async function readBoundedBody(
  request: Request,
  maxBodyBytes: number,
  bodyReadTimeoutMs: number,
): Promise<BoundedBodyResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBodyBytes) {
      return { accepted: false, reason: 'too_large' };
    }
  }
  if (request.body === null) return { accepted: true, body: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ type: 'timed_out' }>((resolve) => {
    timeout = setTimeout(() => resolve({ type: 'timed_out' }), bodyReadTimeoutMs);
  });
  try {
    while (true) {
      const next = await Promise.race([
        reader.read().then((result) => ({ type: 'read' as const, result })),
        deadline,
      ]);
      if (next.type === 'timed_out') {
        void reader.cancel('Browser Worker heartbeat body read timed out').catch(() => {});
        return { accepted: false, reason: 'timed_out' };
      }
      if (next.result.done) break;
      total += next.result.value.byteLength;
      if (total > maxBodyBytes) {
        void reader.cancel('Browser Worker heartbeat body is too large').catch(() => {});
        return { accepted: false, reason: 'too_large' };
      }
      chunks.push(next.result.value);
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { accepted: true, body: bytes };
}

export function createBrowserWorkerHeartbeatRoute(
  dependencies: BrowserWorkerHeartbeatRouteDependencies,
) {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date());
  const maxSkewMs = dependencies.maxSkewMs ?? 60_000;
  const maxBodyBytes = dependencies.maxBodyBytes ?? 64 * 1024;
  const bodyReadTimeoutMs = dependencies.bodyReadTimeoutMs ?? 5_000;
  if (dependencies.tlsAttestationSecret.length < 32) {
    throw new Error('Browser Worker TLS attestation is not configured');
  }
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 1 || maxSkewMs > 5 * 60_000) {
    throw new Error('Browser Worker TLS attestation skew is invalid');
  }
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1024 * 1024) {
    throw new Error('Browser Worker heartbeat body limit is invalid');
  }
  if (
    !Number.isSafeInteger(bodyReadTimeoutMs) ||
    bodyReadTimeoutMs < 100 ||
    bodyReadTimeoutMs > 30_000
  ) {
    throw new Error('Browser Worker heartbeat body read timeout is invalid');
  }

  app.post(AUTOMATION_BROWSER_HEARTBEAT_PATH, async (context) => {
    const headers = context.req.raw.headers;
    const serviceId = headers.get(HEADER.serviceId) ?? '';
    const fingerprint256 = headers.get(HEADER.certificateFingerprint) ?? '';
    const validTo = headers.get(HEADER.certificateValidTo) ?? '';
    const attestedAtText = headers.get(HEADER.attestedAt) ?? '';
    const receivedAttestation = headers.get(HEADER.attestation) ?? '';
    const attestedAt = new Date(attestedAtText);
    const checkedAt = now();
    const url = new URL(context.req.url);
    const path = `${url.pathname}${url.search}`;
    const certificate: TlsPeerCertificate = {
      authorized: true,
      serviceId,
      fingerprint256,
      validTo,
    };
    if (
      !ServiceIdSchema.safeParse(serviceId).success ||
      fingerprint256.length === 0 ||
      fingerprint256.length > 256 ||
      validTo.length > 64 ||
      attestedAtText.length > 64 ||
      !Number.isFinite(Date.parse(validTo)) ||
      Date.parse(validTo) <= checkedAt.getTime() ||
      !Number.isFinite(attestedAt.getTime()) ||
      Math.abs(checkedAt.getTime() - attestedAt.getTime()) > maxSkewMs ||
      !/^hmac-sha256:[a-f0-9]{64}$/.test(receivedAttestation)
    ) {
      return unauthorized();
    }
    let boundedBody: BoundedBodyResult;
    try {
      boundedBody = await readBoundedBody(context.req.raw, maxBodyBytes, bodyReadTimeoutMs);
    } catch {
      return unavailable();
    }
    if (!boundedBody.accepted) {
      return boundedBody.reason === 'timed_out' ? requestTimeout() : payloadTooLarge();
    }
    const rawBodyBytes = boundedBody.body;
    const expectedAttestation = attestationSignature({
      secret: dependencies.tlsAttestationSecret,
      timestamp: attestedAt,
      method: context.req.method,
      path,
      body: rawBodyBytes,
      certificate,
    });
    if (!signaturesEqual(receivedAttestation, expectedAttestation)) return unauthorized();

    let request: z.infer<typeof WorkerRequestSchema>;
    try {
      const rawBody = new TextDecoder('utf-8', { fatal: true }).decode(rawBodyBytes);
      request = WorkerRequestSchema.parse(JSON.parse(rawBody));
    } catch {
      return invalidRequest();
    }
    if (request.proof.service_id !== serviceId) return unauthorized();
    try {
      const peer = dependencies.authenticator.bindTlsPeer(certificate);
      const event = await dependencies.processor.handle({
        peer,
        proof: request.proof,
        heartbeat: request.heartbeat as WorkerHeartbeat,
      });
      return context.json(
        AutomationWorkerHeartbeatAcceptedSchema.parse({
          protocol_version: 'automation.v1',
          accepted: true,
          event,
        }),
      );
    } catch (error) {
      if (error instanceof WorkerAuthenticationError) {
        if (error.reason === 'replayed_proof') return conflict();
        return error.reason === 'invalid_configuration' ? unavailable() : unauthorized();
      }
      if (error instanceof WorkerHeartbeatError) {
        if (error.reason === 'identity_mismatch') return unauthorized();
        if (
          error.reason === 'sensitive_payload' ||
          error.reason === 'invalid_payload' ||
          error.reason === 'stale_observation'
        ) {
          return invalidRequest();
        }
        if (error.reason === 'stale_lease') return leaseExpired();
        return conflict();
      }
      return unavailable();
    }
  });

  return app;
}
