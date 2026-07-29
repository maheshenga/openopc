import type { Context, Hono, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';

import type { AuditEventInput } from '../shared/audit';
import type { AppEnv } from '../types';

export const ADMIN_REASON_HEADER = 'x-openopc-admin-reason';

export interface AdminDecisionContext {
  actorUserId: string;
  permission: string;
  scope: { kind: 'platform' } | { kind: 'account'; accountId: string };
  reason?: string;
  stepUpAt?: string;
}

export interface AuthoritativeAdminSession {
  userId: string;
  permissions: string[];
  stepUpAt: string | null;
  stepUpExpiresAt: string | null;
}

export interface AdminDecisionRequirement {
  permission: string;
  stepUp: boolean;
  crossTenantAudit: boolean;
}

export type AdminDecisionAuthorizer = (
  context: Context,
  requirement: AdminDecisionRequirement,
) => Promise<AdminDecisionContext>;

interface AdminDecisionAuthorizerDependencies {
  now: () => Date;
  recordAuditEvent: (event: AuditEventInput) => Promise<unknown>;
  accountTargetExists?: (accountId: string) => Promise<boolean>;
}

export interface VerifiedAdminIdentity {
  userId: string;
  email: string;
  aal: 'aal1' | 'aal2';
  issuedAt: string;
}

interface AdminSessionMiddlewareDependencies {
  now: () => Date;
  stepUpTtlMs: number;
  verifyAccessToken: (token: string) => Promise<VerifiedAdminIdentity | null>;
  getPlatformRole: (userId: string) => Promise<'user' | 'admin' | 'super_admin'>;
}

const PLATFORM_ADMIN_PERMISSIONS = Object.freeze([
  'account.read',
  'billing.read',
  'billing.write',
  'developer.application.review',
  'developer.module.review',
  'developer.module.distribute',
  'developer.publisher.manage',
  'admin.account.list',
  'admin.provider.read',
  'admin.provider.write',
  'admin.sandbox.read',
  'admin.sandbox.write',
  'admin.analytics.read',
]);

export function permissionsForPlatformRole(role: string): string[] {
  if (role !== 'admin' && role !== 'super_admin') return [];
  return [...PLATFORM_ADMIN_PERMISSIONS];
}

function cookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader || /[\u0000-\u001f\u007f]/.test(cookieHeader)) return null;
  for (const part of cookieHeader.split(';')) {
    const candidate = part.trim();
    const separator = candidate.indexOf('=');
    if (separator <= 0 || candidate.slice(0, separator).trim() !== name) continue;
    const value = candidate.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

function bearerToken(context: Context): string | null {
  const authorization = context.req.header('authorization');
  return authorization?.startsWith('Bearer ') && authorization.slice(7)
    ? authorization.slice(7)
    : null;
}

function validStepUp(
  identity: VerifiedAdminIdentity | null,
  sessionIdentity: VerifiedAdminIdentity,
  now: Date,
  ttlMs: number,
): { stepUpAt: string; stepUpExpiresAt: string } | null {
  if (!identity || identity.userId !== sessionIdentity.userId || identity.aal !== 'aal2') return null;
  const issuedAt = Date.parse(identity.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime()) return null;
  const expiresAt = issuedAt + ttlMs;
  if (expiresAt <= now.getTime()) return null;
  return {
    stepUpAt: new Date(issuedAt).toISOString(),
    stepUpExpiresAt: new Date(expiresAt).toISOString(),
  };
}

export function createAdminSessionMiddleware(dependencies: AdminSessionMiddlewareDependencies) {
  return async function adminSessionMiddleware(context: Context, next: Next): Promise<void> {
    const cookieHeader = context.req.header('cookie');
    const sessionToken =
      cookieValue(cookieHeader, 'openopc_admin_session') ?? bearerToken(context);
    if (!sessionToken) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    const identity = await dependencies.verifyAccessToken(sessionToken);
    if (!identity) throw new HTTPException(401, { message: 'Invalid Admin session' });

    const platformRole = await dependencies.getPlatformRole(identity.userId);
    const permissions = permissionsForPlatformRole(platformRole);
    if (permissions.length === 0) {
      throw new HTTPException(403, { message: 'Admin access required' });
    }

    const stepToken = cookieValue(cookieHeader, 'openopc_admin_step_up');
    const stepIdentity = stepToken ? await dependencies.verifyAccessToken(stepToken) : null;
    const stepUp = validStepUp(
      stepIdentity ?? (identity.aal === 'aal2' ? identity : null),
      identity,
      dependencies.now(),
      dependencies.stepUpTtlMs,
    );
    const session: AuthoritativeAdminSession = {
      userId: identity.userId,
      permissions,
      stepUpAt: stepUp?.stepUpAt ?? null,
      stepUpExpiresAt: stepUp?.stepUpExpiresAt ?? null,
    };

    context.set('userId', identity.userId);
    context.set('userEmail', identity.email);
    context.set('authType', 'supabase');
    context.set('platformRole', platformRole);
    context.set('mfaAal', stepUp ? 'aal2' : identity.aal);
    (context as ContextWithAdminSession).set('adminSession', session);
    await next();
  };
}

export function registerAdminSessionRoute(app: Hono<AppEnv>): void {
  app.get('/session', (context) => {
    const session = adminSession(context);
    if (!session) throw new HTTPException(401, { message: 'Authentication required' });
    return context.json(session);
  });
}

type ContextWithAdminSession = Context & {
  get(key: 'adminSession'): AuthoritativeAdminSession | undefined;
  get(key: 'adminTargetAccountId'): string | undefined;
  set(key: 'adminSession', value: AuthoritativeAdminSession): void;
};

function adminSession(context: Context): AuthoritativeAdminSession | null {
  const value = (context as ContextWithAdminSession).get('adminSession');
  if (!value || typeof value !== 'object') return null;
  if (
    typeof value.userId !== 'string' ||
    !Array.isArray(value.permissions) ||
    !value.permissions.every((permission) => typeof permission === 'string')
  ) {
    return null;
  }
  return value;
}

/** Bind a server-resolved tenant before a developer Admin decision is made. */
export function setAdminTargetAccountId(context: Context, accountId: string | null | undefined): void {
  if (typeof accountId !== 'string' || accountId.length === 0) return;
  (context as ContextWithAdminSession).set('adminTargetAccountId', accountId);
}

function targetAccountId(context: Context): string | null {
  const explicit = (context as ContextWithAdminSession).get('adminTargetAccountId');
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;

  const accountId = context.req.param('accountId');
  if (accountId) return accountId;
  const accountPathMatch = context.req.path.match(/(?:^|\/)api\/accounts\/([^/]+)/);
  if (accountPathMatch?.[1]) {
    try {
      return decodeURIComponent(accountPathMatch[1]);
    } catch {
      return null;
    }
  }
  if (!/(?:^|\/)accounts\//.test(context.req.path)) return null;
  return context.req.param('id') || null;
}

function stepUpIsCurrent(session: AuthoritativeAdminSession, now: Date): boolean {
  if (!session.stepUpAt || !session.stepUpExpiresAt) return false;
  const startedAt = Date.parse(session.stepUpAt);
  const expiresAt = Date.parse(session.stepUpExpiresAt);
  return Number.isFinite(startedAt) && Number.isFinite(expiresAt) && startedAt <= now.getTime() && expiresAt > now.getTime();
}

function crossTenantReason(context: Context): string | null {
  const reason = context.req.header(ADMIN_REASON_HEADER)?.trim() ?? '';
  if (reason.length < 1 || reason.length > 500) return null;
  return reason;
}

export function createAdminDecisionAuthorizer(
  dependencies: AdminDecisionAuthorizerDependencies,
) {
  return async function authorizeAdminDecision(
    context: Context,
    requirement: AdminDecisionRequirement,
  ): Promise<AdminDecisionContext> {
    const session = adminSession(context);
    const actorUserId = context.get('userId') as string | undefined;
    if (!session || !actorUserId || session.userId !== actorUserId) {
      throw new HTTPException(401, { message: 'Authentication required' });
    }

    const accountId = targetAccountId(context);
    const scope: AdminDecisionContext['scope'] = accountId
      ? { kind: 'account', accountId }
      : { kind: 'platform' };
    if (!session.permissions.includes(requirement.permission)) {
      if (scope.kind === 'account') {
        throw new HTTPException(404, { message: 'Not found' });
      }
      throw new HTTPException(403, { message: 'Permission denied' });
    }

    if (
      scope.kind === 'account' &&
      (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        scope.accountId,
      ) ||
        (dependencies.accountTargetExists &&
          !(await dependencies.accountTargetExists(scope.accountId))))
    ) {
      throw new HTTPException(404, { message: 'Not found' });
    }

    if (requirement.stepUp && !stepUpIsCurrent(session, dependencies.now())) {
      throw new HTTPException(403, { message: 'Step-up authentication required' });
    }

    const reason = requirement.crossTenantAudit ? crossTenantReason(context) : null;
    if (requirement.crossTenantAudit && scope.kind === 'account' && !reason) {
      throw new HTTPException(400, { message: 'Cross-tenant reason required' });
    }

    if (requirement.crossTenantAudit && scope.kind === 'account') {
      await dependencies.recordAuditEvent({
        accountId: scope.accountId,
        actorUserId,
        action: 'admin.cross_tenant.authorized',
        resourceType: 'account',
        resourceId: scope.accountId,
        metadata: {
          permission: requirement.permission,
          target: scope,
          decision: 'allowed',
          reason,
        },
      });
    }

    return {
      actorUserId,
      permission: requirement.permission,
      scope,
      ...(reason ? { reason } : {}),
      ...(requirement.stepUp && session.stepUpAt ? { stepUpAt: session.stepUpAt } : {}),
    };
  };
}

function requirementForAdminRequest(
  method: string,
  pathname: string,
): AdminDecisionRequirement | null {
  const path = pathname.startsWith('/v1/admin') ? pathname.slice('/v1/admin'.length) || '/' : pathname;
  if (method === 'GET' && /^\/api\/accounts\/[^/]+\/(?:users|projects)$/.test(path)) {
    return { permission: 'account.read', stepUp: false, crossTenantAudit: true };
  }
  if (method === 'GET' && /^\/api\/accounts\/[^/]+\/ledger$/.test(path)) {
    return { permission: 'billing.read', stepUp: false, crossTenantAudit: true };
  }
  if (
    method === 'POST' &&
    /^\/api\/accounts\/[^/]+\/(?:credits(?:\/debit)?|tier)$/.test(path)
  ) {
    return { permission: 'billing.write', stepUp: true, crossTenantAudit: true };
  }
  if (method === 'GET' && path === '/api/accounts') {
    return { permission: 'admin.account.list', stepUp: false, crossTenantAudit: false };
  }
  if (method === 'GET' && /^\/api\/provider-(?:distribution|fallback|analytics)$/.test(path)) {
    return { permission: 'admin.provider.read', stepUp: false, crossTenantAudit: false };
  }
  if (method === 'PUT' && /^\/api\/provider-(?:distribution|fallback)$/.test(path)) {
    return { permission: 'admin.provider.write', stepUp: true, crossTenantAudit: false };
  }
  if (method === 'GET' && path === '/api/sandboxes') {
    return { permission: 'admin.sandbox.read', stepUp: false, crossTenantAudit: false };
  }
  if (method === 'POST' && /^\/api\/sandboxes\/[^/]+\/migrate$/.test(path)) {
    return { permission: 'admin.sandbox.write', stepUp: true, crossTenantAudit: false };
  }
  return null;
}

export function createAdminRequestAuthorizationMiddleware(
  dependencies: AdminDecisionAuthorizerDependencies,
) {
  const authorize = createAdminDecisionAuthorizer(dependencies);
  return async function adminRequestAuthorization(context: Context, next: Next): Promise<void> {
    const requirement = requirementForAdminRequest(context.req.method, context.req.path);
    if (requirement) await authorize(context, requirement);
    await next();
  };
}

export const authorizeAdminDecision = createAdminDecisionAuthorizer({
  now: () => new Date(),
  recordAuditEvent: async (event) => {
    const { recordAuditEvent } = await import('../shared/audit');
    return recordAuditEvent(event);
  },
});

/**
 * Authorize a developer Admin operation after its target tenant has been
 * resolved from authoritative state or a validated request body.
 */
export async function authorizeAdminTarget(
  context: Context,
  accountId: string,
  requirement: AdminDecisionRequirement,
  authorize: AdminDecisionAuthorizer = authorizeAdminDecision,
): Promise<AdminDecisionContext> {
  setAdminTargetAccountId(context, accountId);
  return authorize(context, requirement);
}

export const adminRequestAuthorization = createAdminRequestAuthorizationMiddleware({
  now: () => new Date(),
  accountTargetExists: async (accountId) => {
    const [{ accounts }, { eq }, { db }] = await Promise.all([
      import('@kortix/db'),
      import('drizzle-orm'),
      import('../shared/db'),
    ]);
    const [row] = await db
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    return Boolean(row);
  },
  recordAuditEvent: async (event) => {
    const { recordAuditEvent } = await import('../shared/audit');
    return recordAuditEvent(event);
  },
});

async function verifySupabaseAdminToken(token: string): Promise<VerifiedAdminIdentity | null> {
  try {
    const [{ getSupabase }, { decodeJwt }] = await Promise.all([
      import('../shared/supabase'),
      import('jose'),
    ]);
    const {
      data: { user },
      error,
    } = await getSupabase().auth.getUser(token);
    if (error || !user) return null;
    const payload = decodeJwt(token);
    const issuedAt = typeof payload.iat === 'number' ? payload.iat * 1_000 : 0;
    return {
      userId: user.id,
      email: user.email ?? '',
      aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
      issuedAt: new Date(issuedAt).toISOString(),
    };
  } catch {
    return null;
  }
}

function configuredStepUpTtlMs(): number {
  const seconds = Number(process.env.OPENOPC_ADMIN_STEP_UP_TTL_SECONDS ?? 600);
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 3_600) return 10 * 60 * 1_000;
  return Math.floor(seconds * 1_000);
}

export const adminSessionAuth = createAdminSessionMiddleware({
  now: () => new Date(),
  stepUpTtlMs: configuredStepUpTtlMs(),
  verifyAccessToken: verifySupabaseAdminToken,
  getPlatformRole: async (userId) => {
    const { getPlatformRole } = await import('../shared/platform-roles');
    return getPlatformRole(userId);
  },
});
