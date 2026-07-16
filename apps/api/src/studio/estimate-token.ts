import { createHmac, timingSafeEqual } from 'node:crypto';
import { type StudioEstimateResponse, StudioEstimateResponseSchema } from '@kortix/api-contract';
import { z } from 'zod';

const V1_TOKEN_PREFIX = 'studio-estimate-v1';
const V1_SIGNING_DOMAIN = 'kortix:studio:estimate:v1:';
const V2_TOKEN_PREFIX = 'studio-estimate-v2';
const V2_SIGNING_DOMAIN = 'kortix:studio:estimate:v2:';

const StudioEstimateV1ClaimsSchema = z
  .object({
    version: z.literal(1),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    actor_user_id: z.string().uuid(),
    issued_at_ms: z.number().int().nonnegative(),
    estimate: StudioEstimateResponseSchema.omit({ estimate_token: true }),
  })
  .strict();

const StudioEstimateV2ClaimsSchema = z
  .object({
    version: z.literal(2),
    account_id: z.string().uuid(),
    project_id: z.string().uuid(),
    actor_user_id: z.string().uuid(),
    issued_at_ms: z.number().int().nonnegative(),
    provider_config_version: z.string().trim().min(1).max(255),
    pricing_catalog_id: z.string().uuid(),
    pricing_version: z.number().int().positive(),
    estimate: StudioEstimateResponseSchema.omit({ estimate_token: true }),
  })
  .strict();

export const StudioEstimateVersionBindingSchema = z
  .object({
    providerConfigVersion: z.string().trim().min(1).max(255),
    pricingCatalogId: z.string().uuid(),
    pricingVersion: z.number().int().positive(),
  })
  .strict();

export type StudioEstimateVersionBinding = z.infer<typeof StudioEstimateVersionBindingSchema>;
export type StudioEstimateV1Claims = z.infer<typeof StudioEstimateV1ClaimsSchema>;
export type StudioEstimateV2Claims = z.infer<typeof StudioEstimateV2ClaimsSchema>;
export type StudioEstimateClaims = StudioEstimateV1Claims | StudioEstimateV2Claims;
export type UnsignedStudioEstimate = Omit<StudioEstimateResponse, 'estimate_token'>;

export type StudioEstimateVerification =
  | { valid: true; claims: StudioEstimateClaims }
  | {
      valid: false;
      reason:
        | 'malformed'
        | 'invalid_signature'
        | 'invalid_claims'
        | 'expired'
        | 'version_binding_missing'
        | 'provider_config_stale'
        | 'pricing_stale';
    };

export function issueStudioEstimateToken(input: {
  secret: string;
  accountId: string;
  projectId: string;
  actorUserId: string;
  estimate: UnsignedStudioEstimate;
  nowMs?: number;
  versionBinding?: StudioEstimateVersionBinding;
}): string {
  requireSecret(input.secret);
  const versionBinding =
    input.versionBinding === undefined
      ? undefined
      : StudioEstimateVersionBindingSchema.parse(input.versionBinding);
  const claims = versionBinding
    ? StudioEstimateV2ClaimsSchema.parse({
        version: 2,
        account_id: input.accountId,
        project_id: input.projectId,
        actor_user_id: input.actorUserId,
        issued_at_ms: input.nowMs ?? Date.now(),
        provider_config_version: versionBinding.providerConfigVersion,
        pricing_catalog_id: versionBinding.pricingCatalogId,
        pricing_version: versionBinding.pricingVersion,
        estimate: input.estimate,
      })
    : StudioEstimateV1ClaimsSchema.parse({
        version: 1,
        account_id: input.accountId,
        project_id: input.projectId,
        actor_user_id: input.actorUserId,
        issued_at_ms: input.nowMs ?? Date.now(),
        estimate: input.estimate,
      });
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  const prefix = versionBinding ? V2_TOKEN_PREFIX : V1_TOKEN_PREFIX;
  const signingDomain = versionBinding ? V2_SIGNING_DOMAIN : V1_SIGNING_DOMAIN;
  return `${prefix}.${payload}.${sign(payload, input.secret, signingDomain)}`;
}

export function verifyStudioEstimateToken(input: {
  token: string;
  secret: string;
  nowMs?: number;
  expectedVersionBinding?: StudioEstimateVersionBinding;
}): StudioEstimateVerification {
  requireSecret(input.secret);
  const expectedVersionBinding =
    input.expectedVersionBinding === undefined
      ? undefined
      : StudioEstimateVersionBindingSchema.parse(input.expectedVersionBinding);
  const [prefix, payload, signature, extra] = input.token.split('.');
  if (
    (prefix !== V1_TOKEN_PREFIX && prefix !== V2_TOKEN_PREFIX) ||
    !payload ||
    !signature ||
    extra !== undefined
  ) {
    return { valid: false, reason: 'malformed' };
  }

  const signingDomain = prefix === V1_TOKEN_PREFIX ? V1_SIGNING_DOMAIN : V2_SIGNING_DOMAIN;
  const expected = Buffer.from(sign(payload, input.secret, signingDomain));
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
  const parsed =
    prefix === V1_TOKEN_PREFIX
      ? StudioEstimateV1ClaimsSchema.safeParse(raw)
      : StudioEstimateV2ClaimsSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, reason: 'invalid_claims' };

  const expiresAt = Date.parse(parsed.data.estimate.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= (input.nowMs ?? Date.now())) {
    return { valid: false, reason: 'expired' };
  }
  if (expectedVersionBinding && parsed.data.version === 1) {
    return { valid: false, reason: 'version_binding_missing' };
  }
  if (
    expectedVersionBinding &&
    parsed.data.version === 2 &&
    parsed.data.provider_config_version !== expectedVersionBinding.providerConfigVersion
  ) {
    return { valid: false, reason: 'provider_config_stale' };
  }
  if (
    expectedVersionBinding &&
    parsed.data.version === 2 &&
    (parsed.data.pricing_catalog_id !== expectedVersionBinding.pricingCatalogId ||
      parsed.data.pricing_version !== expectedVersionBinding.pricingVersion)
  ) {
    return { valid: false, reason: 'pricing_stale' };
  }
  return { valid: true, claims: parsed.data };
}

function sign(payload: string, secret: string, signingDomain: string): string {
  return base64UrlEncode(
    createHmac('sha256', secret).update(`${signingDomain}${payload}`, 'utf8').digest(),
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
