import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  AUTOMATION_DESKTOP_EXECUTOR_AUDIENCE,
  AUTOMATION_DESKTOP_EXECUTOR_PATH,
  AutomationDesktopExecutorParamsSchema,
  canonicalAutomationDesktopExecutorProof,
} from '@kortix/intelligence-contracts';
import { z } from 'zod';
import type { TunnelRpcExecutor, TunnelRpcOutcome } from './desktop-dispatcher';

const UuidSchema = z.string().uuid();

const OutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ok: z.literal(false),
      kind: z.enum(['permission_required', 'rate_limited', 'bad_request', 'error']),
      message: z.string().min(1).max(2_048),
      retryAfterMs: z.number().int().nonnegative().optional(),
      requestId: z.string().uuid().optional(),
      code: z.union([z.string(), z.number()]).optional(),
      httpStatus: z.union([z.literal(500), z.literal(502), z.literal(504)]).optional(),
    })
    .strict(),
]);

export type AutomationApiTunnelExecutorOptions = Readonly<{
  baseUrl: string;
  sharedSecret: string;
  serviceId?: string;
  audience?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  nextNonce?: () => string;
  nextRequestId?: () => string;
}>;

function hashBody(body: string): string {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}

function localFailure(message: string): TunnelRpcOutcome {
  return { ok: false, kind: 'error', message };
}

export function createAutomationApiTunnelExecutor(
  options: AutomationApiTunnelExecutorOptions,
): TunnelRpcExecutor {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const serviceId = options.serviceId ?? 'automation-control';
  const audience = options.audience ?? AUTOMATION_DESKTOP_EXECUTOR_AUDIENCE;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const requestFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const nextNonce = options.nextNonce ?? randomUUID;
  const nextRequestId = options.nextRequestId ?? randomUUID;
  if (
    options.sharedSecret.length < 32 ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(serviceId) ||
    !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(audience)
  ) {
    throw new Error('automation API Tunnel executor authentication is not configured');
  }

  return async (input) => {
    const params = AutomationDesktopExecutorParamsSchema.safeParse(input.params);
    const inputShapeValid =
      UuidSchema.safeParse(input.tunnelId).success &&
      UuidSchema.safeParse(input.accountId).success &&
      input.method === 'desktop.cua.get_screen_size' &&
      UuidSchema.safeParse(input.requiredPermissionId).success &&
      params.success &&
      params.data.permissionId === input.requiredPermissionId &&
      params.data.automation.lease.permission_id === input.requiredPermissionId &&
      params.data.automation.lease.execution_domain === 'desktop' &&
      params.data.automation.lease.job_id === params.data.automation.job_id &&
      params.data.automation.lease.project_id === params.data.automation.project_id &&
      params.data.automation.lease.lease_id === params.data.automation.lease_id &&
      params.data.automation.lease.owner === params.data.automation.lease_owner &&
      params.data.automation.lease.kill_switch_generation ===
        params.data.automation.kill_switch_generation;
    if (!inputShapeValid || !params.success) {
      return localFailure('Automation API desktop executor input was rejected');
    }

    const nonce = nextNonce();
    const requestId = nextRequestId();
    if (!UuidSchema.safeParse(nonce).success || !UuidSchema.safeParse(requestId).success) {
      return localFailure('Automation API desktop executor request identity is invalid');
    }
    const timestamp = now().toISOString();
    const body = JSON.stringify({
      protocol_version: 'automation.v1',
      request_id: requestId,
      tunnel_id: input.tunnelId,
      account_id: input.accountId,
      method: input.method,
      required_permission_id: input.requiredPermissionId,
      params: params.data,
    });
    const bodyHash = hashBody(body);
    const signature = createHmac('sha256', options.sharedSecret)
      .update(
        canonicalAutomationDesktopExecutorProof({
          timestamp,
          serviceId,
          audience,
          nonce,
          method: 'POST',
          path: AUTOMATION_DESKTOP_EXECUTOR_PATH,
          bodyHash,
          accountId: input.accountId,
          projectId: params.data.automation.project_id,
        }),
      )
      .digest('hex');

    let response: Response;
    try {
      response = await requestFetch(`${baseUrl}${AUTOMATION_DESKTOP_EXECUTOR_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-automation-service-id': serviceId,
          'x-automation-audience': audience,
          'x-automation-timestamp': timestamp,
          'x-automation-nonce': nonce,
          'x-automation-body-sha256': bodyHash,
          'x-automation-signature': `hmac-sha256:${signature}`,
          'x-automation-account-id': input.accountId,
          'x-automation-project-id': params.data.automation.project_id,
        },
        body,
        signal:
          input.signal === undefined
            ? AbortSignal.timeout(timeoutMs)
            : AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch {
      return localFailure('Automation API desktop executor transport failed');
    }

    const parsed = OutcomeSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      return localFailure(
        `Automation API desktop executor rejected the request (${response.status})`,
      );
    }
    if (parsed.data.ok) {
      return response.ok
        ? { ok: true, result: parsed.data.result }
        : localFailure(`Automation API desktop executor rejected the request (${response.status})`);
    }
    return {
      ok: false,
      kind: parsed.data.kind,
      message: parsed.data.message,
      ...(parsed.data.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.data.retryAfterMs }),
    };
  };
}
