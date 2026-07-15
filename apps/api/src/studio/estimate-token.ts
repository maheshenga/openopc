import { createHmac, timingSafeEqual } from 'node:crypto';
import { type StudioEstimateResponse, StudioEstimateResponseSchema } from '@kortix/api-contract';
import { z } from 'zod';

const TOKEN_PREFIX = 'studio-estimate-v1';
const SIGNING_DOMAIN = 'kortix:studio:estimate:v1:';

const StudioEstimateClaimsSchema = z
  .object({
    version: z.literal(1),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    actor_user_id: z.string().uuid(),
    issued_at_ms: z.number().int().nonnegative(),
    estimate: StudioEstimateResponseSchema.omit({ estimate_token: true }),
  })
  .strict();

export type StudioEstimateClaims = z.infer<typeof StudioEstimateClaimsSchema>;
export type UnsignedStudioEstimate = Omit<StudioEstimateResponse, 'estimate_token'>;

export type StudioEstimateVerification =
  | { valid: true; claims: StudioEstimateClaims }
  | { valid: false; reason: 'malformed' | 'invalid_signature' | 'invalid_claims' | 'expired' };

export function issueStudioEstimateToken(input: {
  secret: string;
  accountId: string;
  projectId: string;
  actorUserId: string;
  estimate: UnsignedStudioEstimate;
  nowMs?: number;
}): string {
  requireSecret(input.secret);
  const claims = StudioEstimateClaimsSchema.parse({
    version: 1,
    account_id: input.accountId,
    project_id: input.projectId,
    actor_user_id: input.actorUserId,
    issued_at_ms: input.nowMs ?? Date.now(),
    estimate: input.estimate,
  });
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${TOKEN_PREFIX}.${payload}.${sign(payload, input.secret)}`;
}

export function verifyStudioEstimateToken(input: {
  token: string;
  secret: string;
  nowMs?: number;
}): StudioEstimateVerification {
  requireSecret(input.secret);
  const [prefix, payload, signature, extra] = input.token.split('.');
  if (prefix !== TOKEN_PREFIX || !payload || !signature || extra !== undefined) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = Buffer.from(sign(payload, input.secret));
  const received = Buffer.from(signature);
  if (expected.byteLength !== received.byteLength || !timingSafeEqual(expected, received)) {
    return { valid: false, reason: 'invalid_signature' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(base64UrlDecode(payload).toString('utf8'));
  } catch {
    return { valid: false, reason: 'invalid_claims' };
  }
  const parsed = StudioEstimateClaimsSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, reason: 'invalid_claims' };

  const expiresAt = Date.parse(parsed.data.estimate.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.nowMs ?? Date.now())) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims: parsed.data };
}

function sign(payload: string, secret: string): string {
  return base64UrlEncode(
    createHmac('sha256', secret).update(`${SIGNING_DOMAIN}${payload}`, 'utf8').digest(),
  );
}

function requireSecret(secret: string): void {
  if (!secret) throw new Error('Studio estimate signing secret is required');
}

function base64UrlEncode(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): Buffer {
  const padding = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(`${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
