import {
  AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
  AutomationBrowserAuthorityCheckAcceptedSchema,
  AutomationBrowserAuthorityCheckRequestSchema,
  type AutomationErrorCode,
  AutomationErrorSchema,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import type { BrowserAuthorityStore } from './browser-authority-store';
import { WorkerAuthenticationError, type WorkerServiceAuthenticator } from './worker-auth';
import {
  type AuthenticatedWorkerHttpRequest,
  authenticateWorkerHttpRequest,
} from './worker-http-auth';

export type BrowserAuthorityRouteDependencies = Readonly<{
  tlsAttestationSecret: string;
  authenticator: Pick<WorkerServiceAuthenticator, 'bindTlsPeer' | 'verify'>;
  store: Pick<BrowserAuthorityStore, 'check'>;
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
    'Browser authority request is invalid',
    false,
  );
}

function tooLarge(): Response {
  return protocolError(
    413,
    'AUTOMATION_INVALID_REQUEST',
    'Browser authority request is too large',
    false,
  );
}

function timedOut(): Response {
  return protocolError(
    408,
    'AUTOMATION_INVALID_REQUEST',
    'Browser authority request body timed out',
    true,
  );
}

function conflict(): Response {
  return protocolError(409, 'AUTOMATION_CONFLICT', 'Browser authority was rejected', false);
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
    'Browser authority is temporarily unavailable',
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

export function createBrowserAuthorityRoute(dependencies: BrowserAuthorityRouteDependencies) {
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
    throw new Error('Browser authority body limit is invalid');
  }
  if (
    !Number.isSafeInteger(bodyReadTimeoutMs) ||
    bodyReadTimeoutMs < 100 ||
    bodyReadTimeoutMs > 30_000
  ) {
    throw new Error('Browser authority body read timeout is invalid');
  }

  app.post(AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH, async (context) => {
    const checkedAt = now();
    const authenticated = await authenticateWorkerHttpRequest({
      request: context.req.raw,
      expectedPath: AUTOMATION_BROWSER_AUTHORITY_CHECK_PATH,
      tlsAttestationSecret: dependencies.tlsAttestationSecret,
      authenticator: dependencies.authenticator,
      now: checkedAt,
      maxSkewMs,
      maxBodyBytes,
      bodyReadTimeoutMs,
    });
    if (!authenticated.accepted) return mapAuthenticationFailure(authenticated.reason);

    let parsed: ReturnType<typeof AutomationBrowserAuthorityCheckRequestSchema.parse>;
    try {
      const body = new TextDecoder('utf-8', { fatal: true }).decode(authenticated.body);
      const result = AutomationBrowserAuthorityCheckRequestSchema.safeParse(JSON.parse(body));
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
        body: parsed.authority,
      });
      const result = await dependencies.store.check(parsed.authority, checkedAt);
      if (!result.accepted) {
        return result.reason === 'stale_lease' ? leaseExpired() : conflict();
      }
      return context.json(
        AutomationBrowserAuthorityCheckAcceptedSchema.parse({
          protocol_version: 'automation.v1',
          authorized: true,
          check: parsed.authority.check.kind,
          job_id: parsed.authority.job_id,
          lease_id: parsed.authority.lease_id,
          kill_switch_generation: result.currentGeneration,
          full_access_grant_current: result.fullAccessGrantCurrent,
          checked_at: result.checkedAt,
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
