import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';

const HEADER = {
  serviceId: 'x-automation-service-id',
  timestamp: 'x-automation-timestamp',
  signature: 'x-automation-signature',
  accountId: 'x-automation-account-id',
  projectId: 'x-automation-project-id',
  userId: 'x-automation-user-id',
  roles: 'x-automation-roles',
  deviceId: 'x-automation-device-id',
} as const;

const UuidSchema = z.string().uuid();
const ActorSchema = z
  .object({
    accountId: UuidSchema,
    projectId: UuidSchema,
    userId: UuidSchema,
    roles: z
      .array(z.enum(['member', 'project_admin', 'device_owner', 'security_admin']))
      .min(1)
      .max(4),
    deviceId: UuidSchema.nullable(),
  })
  .strict();

export type InternalAutomationActor = z.infer<typeof ActorSchema>;

export type InternalAutomationEnv = {
  Variables: {
    automationActor: InternalAutomationActor;
    automationServiceId: string;
  };
};

export type InternalAuthOptions = Readonly<{
  sharedSecret: string;
  allowedServiceIds: readonly string[];
  now?: () => Date;
  maxSkewMs?: number;
  isMtlsAuthenticated?: (request: Request, serviceId: string) => boolean;
}>;

type SignInput = Readonly<{
  serviceId: string;
  sharedSecret: string;
  timestamp: Date;
  method: string;
  path: string;
  body: string;
  actor: InternalAutomationActor;
}>;

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function canonicalRoles(roles: readonly string[]): string {
  return [...new Set(roles)].sort().join(',');
}

function canonicalRequest(input: Omit<SignInput, 'sharedSecret'>): string {
  return [
    input.timestamp.toISOString(),
    input.serviceId,
    input.method.toUpperCase(),
    input.path,
    bodyHash(input.body),
    input.actor.accountId,
    input.actor.projectId,
    input.actor.userId,
    canonicalRoles(input.actor.roles),
    input.actor.deviceId ?? '',
  ].join('\n');
}

function signatureFor(input: SignInput): string {
  const digest = createHmac('sha256', input.sharedSecret)
    .update(canonicalRequest(input))
    .digest('hex');
  return `hmac-sha256:${digest}`;
}

function signaturesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createInternalServiceHeaders(input: SignInput): Record<string, string> {
  const actor = ActorSchema.parse(input.actor);
  return {
    [HEADER.serviceId]: input.serviceId,
    [HEADER.timestamp]: input.timestamp.toISOString(),
    [HEADER.signature]: signatureFor({ ...input, actor }),
    [HEADER.accountId]: actor.accountId,
    [HEADER.projectId]: actor.projectId,
    [HEADER.userId]: actor.userId,
    [HEADER.roles]: canonicalRoles(actor.roles),
    [HEADER.deviceId]: actor.deviceId ?? '',
  };
}

function actorFromHeaders(headers: Headers): InternalAutomationActor | null {
  const parsed = ActorSchema.safeParse({
    accountId: headers.get(HEADER.accountId),
    projectId: headers.get(HEADER.projectId),
    userId: headers.get(HEADER.userId),
    roles: (headers.get(HEADER.roles) ?? '').split(',').filter(Boolean),
    deviceId: headers.get(HEADER.deviceId) || null,
  });
  return parsed.success ? parsed.data : null;
}

function unauthorized(): Response {
  return Response.json(
    {
      protocol_version: 'automation.v1',
      code: 'AUTOMATION_UNAUTHORIZED',
      message: 'Internal service authentication failed',
      retryable: false,
      approval_status: null,
      audit_event_id: null,
    },
    { status: 401 },
  );
}

export function createInternalAuthMiddleware(
  options: InternalAuthOptions,
): MiddlewareHandler<InternalAutomationEnv> {
  const now = options.now ?? (() => new Date());
  const maxSkewMs = options.maxSkewMs ?? 60_000;
  const allowedServiceIds = new Set(options.allowedServiceIds);

  return async (context, next) => {
    const headers = context.req.raw.headers;
    const serviceId = headers.get(HEADER.serviceId) ?? '';
    const timestampText = headers.get(HEADER.timestamp) ?? '';
    const receivedSignature = headers.get(HEADER.signature) ?? '';
    const actor = actorFromHeaders(headers);
    const timestamp = new Date(timestampText);
    if (
      !actor ||
      !allowedServiceIds.has(serviceId) ||
      !Number.isFinite(timestamp.getTime()) ||
      Math.abs(now().getTime() - timestamp.getTime()) > maxSkewMs
    ) {
      return unauthorized();
    }

    const url = new URL(context.req.url);
    const body = await context.req.raw.clone().text();
    const expectedSignature = signatureFor({
      serviceId,
      sharedSecret: options.sharedSecret,
      timestamp,
      method: context.req.method,
      path: `${url.pathname}${url.search}`,
      body,
      actor,
    });
    const mtlsAuthenticated = options.isMtlsAuthenticated?.(context.req.raw, serviceId) === true;
    if (!mtlsAuthenticated && !signaturesEqual(receivedSignature, expectedSignature)) {
      return unauthorized();
    }

    context.set('automationActor', actor);
    context.set('automationServiceId', serviceId);
    await next();
  };
}
