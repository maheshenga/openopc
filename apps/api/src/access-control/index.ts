import { createRoute, z } from '@hono/zod-openapi';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { accessRequests } from '@kortix/db';
import { areSignupsEnabled, canSignUp } from '../shared/access-control-cache';
import { config } from '../config';
import { makeOpenApiApp, json, errors } from '../openapi';
import { supabaseAuth } from '../middleware/auth';
import { resolveAccountId } from '../shared/resolve-account';
import { createPublicRegistrationService } from './public-registration';
import { createDrizzlePublicRegistrationStore } from './public-registration.drizzle';

export const accessControlApp = makeOpenApiApp();

async function userExistsInAuth(email: string): Promise<boolean> {
  if (!config.DATABASE_URL) return false;
  const sql = postgres(config.DATABASE_URL, { max: 1 });
  try {
    const [row] = await sql`
      SELECT 1 FROM auth.users WHERE email = ${email.trim().toLowerCase()} LIMIT 1
    `;
    return !!row;
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}

function resultRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (
    typeof result === 'object' &&
    result !== null &&
    'rows' in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function registrationHmacKey(): Uint8Array {
  const value =
    process.env.OPENOPC_REGISTRATION_HMAC_KEY ??
    process.env.KORTIX_REGISTRATION_HMAC_KEY ??
    '';
  if (value.startsWith('base64:')) return Buffer.from(value.slice('base64:'.length), 'base64');
  return new TextEncoder().encode(value);
}

function registrationHostnames(): string[] {
  const configured =
    process.env.OPENOPC_REGISTRATION_ALLOWED_HOSTNAMES ??
    process.env.KORTIX_REGISTRATION_ALLOWED_HOSTNAMES;
  if (configured) {
    return configured
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean);
  }
  const appUrl = process.env.OPENOPC_APP_URL || config.KORTIX_URL;
  try {
    return appUrl ? [new URL(appUrl).hostname.toLowerCase()] : [];
  } catch {
    return [];
  }
}

async function verifyTurnstile(input: {
  token: string;
  action: 'signup' | 'magic-link';
  clientIp: string;
}): Promise<{ valid: boolean; action: string; hostname: string }> {
  const secret =
    process.env.OPENOPC_TURNSTILE_SECRET_KEY ?? process.env.KORTIX_TURNSTILE_SECRET_KEY ?? '';
  if (!secret) throw new Error('PUBLIC_REGISTRATION_CHALLENGE_NOT_CONFIGURED');
  const endpoint =
    process.env.OPENOPC_TURNSTILE_VERIFY_URL ||
    process.env.KORTIX_TURNSTILE_VERIFY_URL ||
    'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const body = new URLSearchParams({
    secret,
    response: input.token,
    remoteip: input.clientIp,
  });
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error('PUBLIC_REGISTRATION_CHALLENGE_UNAVAILABLE');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('PUBLIC_REGISTRATION_CHALLENGE_INVALID_RESPONSE');
  }
  const result = value as Record<string, unknown>;
  if (typeof result.success !== 'boolean') {
    throw new Error('PUBLIC_REGISTRATION_CHALLENGE_INVALID_RESPONSE');
  }
  if (result.success && (typeof result.action !== 'string' || typeof result.hostname !== 'string')) {
    throw new Error('PUBLIC_REGISTRATION_CHALLENGE_INVALID_RESPONSE');
  }
  return {
    valid: result.success,
    action: typeof result.action === 'string' ? result.action : '',
    hostname: typeof result.hostname === 'string' ? result.hostname : '',
  };
}

async function authoritativeSignupPolicy(
  email: string,
): Promise<{ allowed: boolean; accountId?: string }> {
  const rows = await db.execute<{ allowed: boolean; account_id: string | null }>(sql`
    SELECT
      (
        setting.value = 'true'::jsonb
        OR setting.value = '"true"'::jsonb
        OR EXISTS (
          SELECT 1
          FROM kortix.access_allowlist AS allowlist
          WHERE (
            allowlist.entry_type = 'email'
            AND lower(allowlist.value) = ${email}
          ) OR (
            allowlist.entry_type = 'domain'
            AND lower(allowlist.value) = split_part(${email}, '@', 2)
          )
        )
      ) AS allowed,
      (
        SELECT member.account_id::text
        FROM auth.users AS auth_user
        INNER JOIN kortix.account_members AS member ON member.user_id = auth_user.id
        WHERE lower(auth_user.email) = ${email}
        ORDER BY member.joined_at ASC
        LIMIT 1
      ) AS account_id
    FROM kortix.platform_settings AS setting
    WHERE setting.key = 'signups_enabled'
    LIMIT 1
  `);
  const row = resultRows<{ allowed: boolean; account_id: string | null }>(rows)[0];
  if (!row || typeof row.allowed !== 'boolean') {
    throw new Error('PUBLIC_REGISTRATION_ACCESS_POLICY_UNAVAILABLE');
  }
  return {
    allowed: row.allowed,
    ...(row.account_id ? { accountId: row.account_id } : {}),
  };
}

function defaultPublicRegistrationService() {
  const store = createDrizzlePublicRegistrationStore(db);
  return createPublicRegistrationService({
    hmacKey: registrationHmacKey(),
    allowedChallengeHostnames: registrationHostnames(),
    now: () => new Date(),
    verifyChallenge: verifyTurnstile,
    canSignUp: authoritativeSignupPolicy,
    ...store,
  });
}

function requestClientIp(headers: { get(name: string): string | undefined }): string | null {
  const forwarded =
    headers.get('cf-connecting-ip') ||
    headers.get('x-real-ip') ||
    headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || null;
}

// ─── Public endpoints (no auth) ───────────────────────────────────────────────

const registrationPolicyVersions = z
  .object({
    terms: z.string().min(1).max(64),
    privacy: z.string().min(1).max(64),
    acceptableUse: z.string().min(1).max(64),
  })
  .strict();

const registrationDeniedSchema = z.object({
  allowed: z.literal(false),
  code: z.enum([
    'REGISTRATION_DENIED',
    'REGISTRATION_DEPENDENCY_UNAVAILABLE',
    'REGISTRATION_RATE_LIMITED',
  ]),
});

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/registration/preflight',
    tags: ['access'],
    summary: 'Issue a short-lived public registration decision',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z
              .object({
                email: z.string().email().max(254),
                challengeToken: z.string().min(1).max(4096),
                deviceId: z.string().min(1).max(255),
                action: z.enum(['signup', 'magic-link']),
                policyVersions: registrationPolicyVersions,
              })
              .strict(),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          allowed: z.literal(true),
          decisionToken: z.string().min(1).max(8192),
          expiresAt: z.string().datetime(),
        }),
        'Registration decision issued',
      ),
      403: json(registrationDeniedSchema, 'Registration denied'),
      429: json(registrationDeniedSchema, 'Registration rate limited'),
      503: json(registrationDeniedSchema, 'Registration dependency unavailable'),
      ...errors(400),
    },
  }),
  async (c) => {
    const clientIp = requestClientIp({ get: (name) => c.req.header(name) });
    if (!clientIp) {
      return c.json(
        { allowed: false as const, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' as const },
        503,
      );
    }
    try {
      const service = defaultPublicRegistrationService();
      const decision = await service.preflight({
        ...c.req.valid('json'),
        clientIp,
      });
      if (decision.allowed) return c.json(decision, 200);
      if (decision.code === 'REGISTRATION_RATE_LIMITED') return c.json(decision, 429);
      if (decision.code === 'REGISTRATION_DEPENDENCY_UNAVAILABLE') {
        return c.json(decision, 503);
      }
      return c.json(decision, 403);
    } catch {
      return c.json(
        { allowed: false as const, code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' as const },
        503,
      );
    }
  },
);

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/registration/complete',
    tags: ['access'],
    summary: 'Bind a verified registration decision to the authenticated member',
    middleware: [supabaseAuth] as const,
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({ decisionToken: z.string().min(1).max(8192) }).strict(),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ completed: z.literal(true) }), 'Registration policies recorded'),
      403: json(
        z.object({
          completed: z.literal(false),
          code: z.literal('REGISTRATION_DENIED'),
        }),
        'Registration decision denied',
      ),
      503: json(
        z.object({
          completed: z.literal(false),
          code: z.literal('REGISTRATION_DEPENDENCY_UNAVAILABLE'),
        }),
        'Registration completion unavailable',
      ),
      ...errors(400, 401),
    },
  }),
  async (c) => {
    if (c.get('authType') !== 'supabase') {
      return c.json(
        { completed: false as const, code: 'REGISTRATION_DENIED' as const },
        403,
      );
    }
    try {
      const userId = c.get('userId') as string;
      const accountId = await resolveAccountId(userId);
      const result = await defaultPublicRegistrationService().completeRegistrationDecision(
        c.req.valid('json').decisionToken,
        { accountId, userId },
      );
      if (result.valid) return c.json({ completed: true as const }, 200);
      if (result.code === 'REGISTRATION_DEPENDENCY_UNAVAILABLE') {
        return c.json({ completed: false as const, code: result.code }, 503);
      }
      return c.json({ completed: false as const, code: result.code }, 403);
    } catch {
      return c.json(
        {
          completed: false as const,
          code: 'REGISTRATION_DEPENDENCY_UNAVAILABLE' as const,
        },
        503,
      );
    }
  },
);

accessControlApp.openapi(
  createRoute({
    method: 'get',
    path: '/signup-status',
    tags: ['access'],
    summary: 'Whether public signups are currently open',
    responses: {
      200: json(z.object({ signupsEnabled: z.boolean() }), 'Signup availability'),
    },
  }),
  (c) => c.json({ signupsEnabled: areSignupsEnabled() }),
);

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/check-email',
    tags: ['access'],
    summary: 'Check whether an email is allowed to sign up',
    request: {
      body: { content: { 'application/json': { schema: z.object({ email: z.string().email() }) } } },
    },
    responses: {
      200: json(z.object({ allowed: z.boolean() }), 'Whether the email may sign up'),
      ...errors(400),
    },
  }),
  async (c) => {
    const { email } = c.req.valid('json');
    if (canSignUp(email)) return c.json({ allowed: true });
    if (await userExistsInAuth(email)) return c.json({ allowed: true });
    return c.json({ allowed: false });
  },
);

accessControlApp.openapi(
  createRoute({
    method: 'post',
    path: '/request-access',
    tags: ['access'],
    summary: 'Submit an early-access / waitlist request',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              email: z.string().email(),
              company: z.string().optional(),
              useCase: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ success: z.boolean(), message: z.string() }), 'Request submitted'),
      ...errors(400),
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    await db.insert(accessRequests).values({
      email: body.email.trim().toLowerCase(),
      company: body.company || null,
      useCase: body.useCase || null,
    });
    return c.json({ success: true, message: 'Access request submitted' });
  },
);
