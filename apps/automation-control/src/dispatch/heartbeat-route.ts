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
import { authenticateWorkerHttpRequest } from './worker-http-auth';
/*
 * The route authenticates two separate statements: a trusted proxy attests the TLS certificate,
 * then the Worker proof authenticates the heartbeat body. Neither statement can replace the
 * other.
 */

export { AUTOMATION_BROWSER_HEARTBEAT_PATH };
export { createWorkerTlsAttestationHeaders } from './worker-http-auth';

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
    const checkedAt = now();
    const authenticated = await authenticateWorkerHttpRequest({
      request: context.req.raw,
      expectedPath: AUTOMATION_BROWSER_HEARTBEAT_PATH,
      tlsAttestationSecret: dependencies.tlsAttestationSecret,
      authenticator: dependencies.authenticator,
      now: checkedAt,
      maxSkewMs,
      maxBodyBytes,
      bodyReadTimeoutMs,
    });
    if (!authenticated.accepted) {
      if (authenticated.reason === 'too_large') return payloadTooLarge();
      if (authenticated.reason === 'timed_out') return requestTimeout();
      if (authenticated.reason === 'unavailable') return unavailable();
      return unauthorized();
    }

    let request: z.infer<typeof WorkerRequestSchema>;
    try {
      const rawBody = new TextDecoder('utf-8', { fatal: true }).decode(authenticated.body);
      request = WorkerRequestSchema.parse(JSON.parse(rawBody));
    } catch {
      return invalidRequest();
    }
    if (request.proof.service_id !== authenticated.peer.serviceId) return unauthorized();
    try {
      const event = await dependencies.processor.handle({
        peer: authenticated.peer,
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
