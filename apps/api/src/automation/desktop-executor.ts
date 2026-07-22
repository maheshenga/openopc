import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  AutomationDesktopExecutorRequestSchema,
  canonicalAutomationDesktopExecutorProof,
} from '@kortix/intelligence-contracts';
import { Hono } from 'hono';
import { z } from 'zod';

const HEADER = {
  serviceId: 'x-automation-service-id',
  audience: 'x-automation-audience',
  timestamp: 'x-automation-timestamp',
  nonce: 'x-automation-nonce',
  bodyHash: 'x-automation-body-sha256',
  signature: 'x-automation-signature',
  accountId: 'x-automation-account-id',
  projectId: 'x-automation-project-id',
} as const;

const UuidSchema = z.string().uuid();
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export type AutomationDesktopTunnelOutcome =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{
      ok: false;
      kind: 'permission_required' | 'rate_limited' | 'bad_request' | 'error';
      message: string;
      requestId?: string;
      retryAfterMs?: number;
      code?: string | number;
      httpStatus?: 500 | 502 | 504;
    }>;

export interface AutomationDesktopNonceStore {
  consume(input: {
    serviceId: string;
    nonce: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean>;
}

class MemoryAutomationDesktopNonceStore implements AutomationDesktopNonceStore {
  readonly #expiresAt = new Map<string, number>();

  async consume(input: {
    serviceId: string;
    nonce: string;
    now: Date;
    expiresAt: Date;
  }): Promise<boolean> {
    for (const [key, expiry] of this.#expiresAt) {
      if (expiry < input.now.getTime()) this.#expiresAt.delete(key);
    }
    const key = `${input.serviceId}:${input.nonce}`;
    if (this.#expiresAt.has(key)) return false;
    this.#expiresAt.set(key, input.expiresAt.getTime());
    return true;
  }
}

/** Local/test-only. Production wiring must replace this with an atomic shared store. */
export function createMemoryAutomationDesktopNonceStore(): AutomationDesktopNonceStore {
  return new MemoryAutomationDesktopNonceStore();
}

export type AutomationRedisCommandClient = Readonly<{
  send(command: string, args: string[]): Promise<unknown>;
}>;

/** Shared production store. Redis owns expiry so replay state is bounded across API replicas. */
export function createRedisAutomationDesktopNonceStore(
  client: AutomationRedisCommandClient,
  options?: { keyPrefix?: string },
): AutomationDesktopNonceStore {
  const keyPrefix = options?.keyPrefix ?? 'automation:desktop-executor:nonce:v1';
  return {
    async consume(input) {
      const ttlMs = input.expiresAt.getTime() - input.now.getTime();
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) return false;
      const keyDigest = createHash('sha256')
        .update(`${input.serviceId}\0${input.nonce}`)
        .digest('hex');
      const reserved = await client.send('SET', [
        `${keyPrefix}:${keyDigest}`,
        '1',
        'PX',
        String(ttlMs),
        'NX',
      ]);
      return reserved === 'OK';
    },
  };
}

export type AutomationDesktopExecutorDependencies = Readonly<{
  controlEnabled: boolean;
  desktopExecutorEnabled: boolean;
  sharedSecret: string;
  allowedServiceIds: readonly string[];
  audience: string;
  nonceStore: AutomationDesktopNonceStore;
  now?: () => Date;
  maxSkewMs?: number;
  requireMtls?: boolean;
  isMtlsAuthenticated?: (request: Request, serviceId: string) => boolean;
  verifyProjectScope(input: { accountId: string; projectId: string }): Promise<boolean>;
  verifyTunnelOwnership(input: { accountId: string; tunnelId: string }): Promise<boolean>;
  executeTunnelRpc(input: {
    tunnelId: string;
    accountId: string;
    method: string;
    params: Record<string, unknown>;
    requiredPermissionId: string;
  }): Promise<AutomationDesktopTunnelOutcome>;
}>;

function bodyHash(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function errorBody(code: string, message: string) {
  return {
    protocol_version: 'automation.v1' as const,
    code,
    message,
    retryable: false,
  };
}

export function createAutomationDesktopExecutorApp(
  dependencies: AutomationDesktopExecutorDependencies,
) {
  const app = new Hono();
  const now = dependencies.now ?? (() => new Date());
  const maxSkewMs = dependencies.maxSkewMs ?? 60_000;
  const allowedServiceIds = new Set(dependencies.allowedServiceIds);
  const enabled = dependencies.controlEnabled && dependencies.desktopExecutorEnabled;
  if (
    enabled &&
    (dependencies.sharedSecret.length < 32 ||
      allowedServiceIds.size === 0 ||
      dependencies.audience.length === 0)
  ) {
    throw new Error('automation desktop executor authentication is not configured');
  }

  app.post('/execute', async (context) => {
    if (!enabled) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_UNAVAILABLE', 'Desktop executor is not enabled'),
        503,
      );
    }

    const headers = context.req.raw.headers;
    const serviceId = headers.get(HEADER.serviceId) ?? '';
    const audience = headers.get(HEADER.audience) ?? '';
    const timestampText = headers.get(HEADER.timestamp) ?? '';
    const nonce = headers.get(HEADER.nonce) ?? '';
    const receivedBodyHash = headers.get(HEADER.bodyHash) ?? '';
    const receivedSignature = headers.get(HEADER.signature) ?? '';
    const accountId = headers.get(HEADER.accountId) ?? '';
    const projectId = headers.get(HEADER.projectId) ?? '';
    const timestamp = new Date(timestampText);
    const checkedAt = now();
    const path = `${new URL(context.req.url).pathname}${new URL(context.req.url).search}`;
    const rawBody = await context.req.raw.clone().text();
    const computedBodyHash = bodyHash(rawBody);
    const authShapeValid =
      allowedServiceIds.has(serviceId) &&
      audience === dependencies.audience &&
      UuidSchema.safeParse(nonce).success &&
      UuidSchema.safeParse(accountId).success &&
      UuidSchema.safeParse(projectId).success &&
      Number.isFinite(timestamp.getTime()) &&
      Math.abs(checkedAt.getTime() - timestamp.getTime()) <= maxSkewMs &&
      Sha256Schema.safeParse(receivedBodyHash).success &&
      /^hmac-sha256:[a-f0-9]{64}$/.test(receivedSignature) &&
      signaturesEqual(receivedBodyHash, computedBodyHash);
    if (!authShapeValid) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_UNAUTHORIZED', 'Internal authentication failed'),
        401,
      );
    }

    const expectedDigest = createHmac('sha256', dependencies.sharedSecret)
      .update(
        canonicalAutomationDesktopExecutorProof({
          timestamp: timestampText,
          serviceId,
          audience,
          nonce,
          method: context.req.method,
          path,
          bodyHash: computedBodyHash,
          accountId,
          projectId,
        }),
      )
      .digest('hex');
    const expectedSignature = `hmac-sha256:${expectedDigest}`;
    const mtlsAccepted = dependencies.isMtlsAuthenticated?.(context.req.raw, serviceId) === true;
    if (
      !signaturesEqual(receivedSignature, expectedSignature) ||
      (dependencies.requireMtls === true && !mtlsAccepted)
    ) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_UNAUTHORIZED', 'Internal authentication failed'),
        401,
      );
    }
    if (
      !(await dependencies.nonceStore.consume({
        serviceId,
        nonce,
        now: checkedAt,
        expiresAt: new Date(timestamp.getTime() + maxSkewMs),
      }))
    ) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_REPLAYED', 'Request replay was rejected'),
        409,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBody);
    } catch {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_INVALID', 'Request body is invalid'),
        400,
      );
    }
    const parsed = AutomationDesktopExecutorRequestSchema.safeParse(parsedJson);
    if (
      !parsed.success ||
      parsed.data.account_id !== accountId ||
      parsed.data.params.automation.project_id !== projectId ||
      Date.parse(parsed.data.params.automation.lease.expires_at) <= checkedAt.getTime()
    ) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_INVALID', 'Request body is invalid'),
        400,
      );
    }

    const [projectMatches, tunnelMatches] = await Promise.all([
      dependencies.verifyProjectScope({ accountId, projectId }),
      dependencies.verifyTunnelOwnership({ accountId, tunnelId: parsed.data.tunnel_id }),
    ]);
    if (!projectMatches || !tunnelMatches) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_NOT_FOUND', 'Execution target was not found'),
        404,
      );
    }
    if (Date.parse(parsed.data.params.automation.lease.expires_at) <= now().getTime()) {
      return context.json(
        errorBody('AUTOMATION_DESKTOP_EXECUTOR_INVALID', 'Request body is invalid'),
        400,
      );
    }

    const outcome = await dependencies.executeTunnelRpc({
      tunnelId: parsed.data.tunnel_id,
      accountId: parsed.data.account_id,
      method: parsed.data.method,
      requiredPermissionId: parsed.data.required_permission_id,
      params: parsed.data.params,
    });
    if (outcome.ok) return context.json(outcome);
    if (outcome.kind === 'permission_required') return context.json(outcome, 403);
    if (outcome.kind === 'rate_limited') return context.json(outcome, 429);
    if (outcome.kind === 'bad_request') return context.json(outcome, 400);
    return context.json(outcome, outcome.httpStatus ?? 500);
  });

  return app;
}
