import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  type TlsPeerCertificate,
  type VerifiedWorkerPeer,
  WorkerAuthenticationError,
  type WorkerServiceAuthenticator,
} from './worker-auth';

const HEADER = {
  serviceId: 'x-automation-worker-service-id',
  certificateFingerprint: 'x-automation-worker-certificate-fingerprint',
  certificateValidTo: 'x-automation-worker-certificate-valid-to',
  attestedAt: 'x-automation-worker-tls-attested-at',
  attestation: 'x-automation-worker-tls-attestation',
} as const;

const ServiceIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);

export type WorkerTlsAttestationInput = Readonly<{
  secret: string;
  timestamp: Date;
  method: string;
  path: string;
  body: string | Uint8Array;
  certificate: TlsPeerCertificate;
}>;

export type AuthenticatedWorkerHttpRequest =
  | Readonly<{
      accepted: true;
      peer: VerifiedWorkerPeer;
      body: Uint8Array;
    }>
  | Readonly<{
      accepted: false;
      reason: 'unauthorized' | 'too_large' | 'timed_out' | 'unavailable';
    }>;

function bodyHash(body: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function canonicalTlsAttestation(input: Omit<WorkerTlsAttestationInput, 'secret'>): string {
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

function attestationSignature(input: WorkerTlsAttestationInput): string {
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
  input: WorkerTlsAttestationInput,
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
        void reader.cancel('Browser Worker request body read timed out').catch(() => {});
        return { accepted: false, reason: 'timed_out' };
      }
      if (next.result.done) break;
      total += next.result.value.byteLength;
      if (total > maxBodyBytes) {
        void reader.cancel('Browser Worker request body is too large').catch(() => {});
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

export async function authenticateWorkerHttpRequest(input: {
  request: Request;
  expectedPath: string;
  tlsAttestationSecret: string;
  authenticator: Pick<WorkerServiceAuthenticator, 'bindTlsPeer'>;
  now: Date;
  maxSkewMs: number;
  maxBodyBytes: number;
  bodyReadTimeoutMs: number;
}): Promise<AuthenticatedWorkerHttpRequest> {
  const headers = input.request.headers;
  const serviceId = headers.get(HEADER.serviceId) ?? '';
  const fingerprint256 = headers.get(HEADER.certificateFingerprint) ?? '';
  const validTo = headers.get(HEADER.certificateValidTo) ?? '';
  const attestedAtText = headers.get(HEADER.attestedAt) ?? '';
  const receivedAttestation = headers.get(HEADER.attestation) ?? '';
  const attestedAt = new Date(attestedAtText);
  const url = new URL(input.request.url);
  const path = `${url.pathname}${url.search}`;
  const certificate: TlsPeerCertificate = {
    authorized: true,
    serviceId,
    fingerprint256,
    validTo,
  };
  if (
    path !== input.expectedPath ||
    !ServiceIdSchema.safeParse(serviceId).success ||
    fingerprint256.length === 0 ||
    fingerprint256.length > 256 ||
    validTo.length > 64 ||
    attestedAtText.length > 64 ||
    !Number.isFinite(Date.parse(validTo)) ||
    Date.parse(validTo) <= input.now.getTime() ||
    !Number.isFinite(attestedAt.getTime()) ||
    Math.abs(input.now.getTime() - attestedAt.getTime()) > input.maxSkewMs ||
    !/^hmac-sha256:[a-f0-9]{64}$/.test(receivedAttestation)
  ) {
    return { accepted: false, reason: 'unauthorized' };
  }

  let boundedBody: BoundedBodyResult;
  try {
    boundedBody = await readBoundedBody(input.request, input.maxBodyBytes, input.bodyReadTimeoutMs);
  } catch {
    return { accepted: false, reason: 'unavailable' };
  }
  if (!boundedBody.accepted) return boundedBody;

  const expectedAttestation = attestationSignature({
    secret: input.tlsAttestationSecret,
    timestamp: attestedAt,
    method: input.request.method,
    path,
    body: boundedBody.body,
    certificate,
  });
  if (!signaturesEqual(receivedAttestation, expectedAttestation)) {
    return { accepted: false, reason: 'unauthorized' };
  }

  try {
    return {
      accepted: true,
      peer: input.authenticator.bindTlsPeer(certificate),
      body: boundedBody.body,
    };
  } catch (error) {
    if (error instanceof WorkerAuthenticationError) {
      return {
        accepted: false,
        reason: error.reason === 'invalid_configuration' ? 'unavailable' : 'unauthorized',
      };
    }
    return { accepted: false, reason: 'unavailable' };
  }
}
