import {
  AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
  AutomationBrowserApprovalConsumeAcceptedSchema,
  AutomationBrowserApprovalConsumeRequestSchema,
  type AutomationErrorCode,
  AutomationErrorSchema,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { BrowserApprovalResumeStore } from './browser-approval-resume-store';
import { WorkerAuthenticationError, type WorkerServiceAuthenticator } from './worker-auth';
import {
  type AuthenticatedWorkerHttpRequest,
  authenticateWorkerHttpRequest,
} from './worker-http-auth';

export type BrowserApprovalResumeRouteDependencies = Readonly<{
  tlsAttestationSecret: string;
  authenticator: Pick<WorkerServiceAuthenticator, 'bindTlsPeer' | 'verify'>;
  store: Pick<BrowserApprovalResumeStore, 'consumeAndStart'>;
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

function invalidRequest(): Response {
  return protocolError(
    400,
    'AUTOMATION_INVALID_REQUEST',
    'Browser approval resume request is invalid',
    false,
  );
}

function tooLarge(): Response {
  return protocolError(
    413,
    'AUTOMATION_INVALID_REQUEST',
    'Browser approval resume request is too large',
    false,
  );
}

function timedOut(): Response {
  return protocolError(
    408,
    'AUTOMATION_INVALID_REQUEST',
    'Browser approval resume request body timed out',
    true,
  );
}

function conflict(): Response {
  return protocolError(409, 'AUTOMATION_CONFLICT', 'Browser approval resume was rejected', false);
}

function leaseExpired(): Response {
  return protocolError(
    409,
    'AUTOMATION_LEASE_EXPIRED',
    'Browser Worker lease is no longer current',
    false,
  );
}

function unavailable(): Response {
  return protocolError(
    503,
    'AUTOMATION_UNAVAILABLE',
    'Browser approval resume is temporarily unavailable',
    true,
  );
}

function mapAuthenticationFailure(
  reason: Extract<AuthenticatedWorkerHttpRequest, { accepted: false }>['reason'],
): Response {
  if (reason === 'too_large') return tooLarge();
  if (reason === 'timed_out') return timedOut();
  if (reason === 'unavailable') return unavailable();
  return unauthorized();
}

export function createBrowserApprovalResumeRoute(
  dependencies: BrowserApprovalResumeRouteDependencies,
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
    throw new Error('Browser approval resume body limit is invalid');
  }
  if (
    !Number.isSafeInteger(bodyReadTimeoutMs) ||
    bodyReadTimeoutMs < 100 ||
    bodyReadTimeoutMs > 30_000
  ) {
    throw new Error('Browser approval resume body read timeout is invalid');
  }

  app.post(AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH, async (context) => {
    const checkedAt = now();
    const authenticated = await authenticateWorkerHttpRequest({
      request: context.req.raw,
      expectedPath: AUTOMATION_BROWSER_APPROVAL_CONSUME_PATH,
      tlsAttestationSecret: dependencies.tlsAttestationSecret,
      authenticator: dependencies.authenticator,
      now: checkedAt,
      maxSkewMs,
      maxBodyBytes,
      bodyReadTimeoutMs,
    });
    if (!authenticated.accepted) return mapAuthenticationFailure(authenticated.reason);

    let parsed: ReturnType<typeof AutomationBrowserApprovalConsumeRequestSchema.parse>;
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(authenticated.body);
      const result = AutomationBrowserApprovalConsumeRequestSchema.safeParse(JSON.parse(body));
      if (!result.success || result.data.proof.service_id !== authenticated.peer.serviceId) {
        return unauthorized();
      }
      parsed = result.data;
    } catch {
      return invalidRequest();
    }

    try {
      await dependencies.authenticator.verify({
        peer: authenticated.peer,
        expectedRole: 'browser-worker',
        proof: parsed.proof,
        body: parsed.consume,
      });
      const result = await dependencies.store.consumeAndStart({
        ...parsed.consume,
        workerId: authenticated.peer.serviceId,
        now: checkedAt,
      });
      if (!result.accepted) {
        return result.reason === 'stale_lease' ? leaseExpired() : conflict();
      }
      return context.json(
        AutomationBrowserApprovalConsumeAcceptedSchema.parse({
          protocol_version: 'automation.v1',
          consumed: true,
          idempotent: result.idempotent,
          approval_id: parsed.consume.approval_id,
          attempt_id: parsed.consume.attempt_id,
          job_id: parsed.consume.job_id,
          step_id: parsed.consume.step_id,
          started_at: result.startedAt,
        }),
      );
    } catch (error) {
      if (error instanceof WorkerAuthenticationError) {
        if (error.reason === 'replayed_proof') return conflict();
        return error.reason === 'invalid_configuration' ? unavailable() : unauthorized();
      }
      return unavailable();
    }
  });

  return app;
}
