import { describe, expect, test } from 'bun:test';
import type { StudioEstimateResponse } from '@kortix/api-contract';
import {
  type StudioEstimateVersionBinding,
  StudioEstimateVersionBindingSchema,
  issueStudioEstimateToken,
  verifyStudioEstimateToken,
} from './estimate-token';

const NOW_MS = Date.parse('2026-07-16T08:00:00.000Z');
const SECRET = 'studio-estimate-test-secret';
const VERSION_BINDING = {
  providerConfigVersion: 'provider-config-v7',
  pricingCatalogId: '88888888-9999-4aaa-8bbb-cccccccccccc',
  pricingVersion: 3,
} as const;

const unsignedEstimate: Omit<StudioEstimateResponse, 'estimate_token'> = {
  estimate_id: '44444444-5555-4666-8777-888888888888',
  expires_at: '2026-07-16T08:15:00.000Z',
  currency: 'credits',
  provider_cost_credits: 2,
  platform_cost_credits: 1,
  max_approved_credits: 3,
  input_hash: 'sha256:studio-image-request',
  line_items: [
    { label: 'Provider image generation', credits: 2 },
    { label: 'Studio platform fee', credits: 1 },
  ],
};

const baseIssueInput = {
  secret: SECRET,
  accountId: '99999999-8888-4777-8666-555555555555',
  projectId: '11111111-2222-4333-8444-555555555555',
  actorUserId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  estimate: unsignedEstimate,
  nowMs: NOW_MS,
};

const partialBindingForTypecheck = { providerConfigVersion: 'provider-config-v7' };
// @ts-expect-error Version bindings are all-or-nothing.
const completeBindingForTypecheck: StudioEstimateVersionBinding = partialBindingForTypecheck;
void completeBindingForTypecheck;

describe('studio estimate tokens', () => {
  test('issues version-bound v2 claims only from a complete binding', () => {
    const token = issueStudioEstimateToken({
      ...baseIssueInput,
      versionBinding: VERSION_BINDING,
    });

    expect(token.startsWith('studio-estimate-v2.')).toBe(true);
    const verified = verifyStudioEstimateToken({ token, secret: SECRET, nowMs: NOW_MS });
    expect(verified.valid).toBe(true);
    if (!verified.valid || verified.claims.version !== 2) {
      throw new Error('Expected valid Studio estimate v2 claims');
    }
    expect(verified.claims.provider_config_version).toBe('provider-config-v7');
    expect(verified.claims.pricing_catalog_id).toBe(VERSION_BINDING.pricingCatalogId);
    expect(verified.claims.pricing_version).toBe(3);

    expect(
      StudioEstimateVersionBindingSchema.safeParse({ providerConfigVersion: 'provider-config-v7' })
        .success,
    ).toBe(false);
    expect(() =>
      issueStudioEstimateToken({
        ...baseIssueInput,
        versionBinding: { providerConfigVersion: 'provider-config-v7' } as never,
      }),
    ).toThrow();
  });

  test('rejects legacy v1 claims when a version binding is expected', () => {
    const token = issueStudioEstimateToken(baseIssueInput);
    const verified = verifyStudioEstimateToken({
      token,
      secret: SECRET,
      nowMs: NOW_MS,
      expectedVersionBinding: VERSION_BINDING,
    });

    expect(verified).toEqual({ valid: false, reason: 'version_binding_missing' });
    expect(() =>
      verifyStudioEstimateToken({
        token,
        secret: SECRET,
        expectedVersionBinding: { pricingVersion: 3 } as never,
      }),
    ).toThrow();
  });

  test('rejects a stale provider config version', () => {
    const token = issueStudioEstimateToken({
      ...baseIssueInput,
      versionBinding: VERSION_BINDING,
    });
    const verified = verifyStudioEstimateToken({
      token,
      secret: SECRET,
      nowMs: NOW_MS,
      expectedVersionBinding: {
        ...VERSION_BINDING,
        providerConfigVersion: 'provider-config-v8',
      },
    });

    expect(verified).toEqual({ valid: false, reason: 'provider_config_stale' });
  });

  test('rejects a stale pricing catalog identity or version', () => {
    const token = issueStudioEstimateToken({
      ...baseIssueInput,
      versionBinding: VERSION_BINDING,
    });

    expect(
      verifyStudioEstimateToken({
        token,
        secret: SECRET,
        nowMs: NOW_MS,
        expectedVersionBinding: VERSION_BINDING,
      }).valid,
    ).toBe(true);

    for (const expectedVersionBinding of [
      {
        ...VERSION_BINDING,
        pricingCatalogId: 'bbbbbbbb-2222-4ccc-8ddd-eeeeeeeeeeee',
      },
      { ...VERSION_BINDING, pricingVersion: 4 },
    ]) {
      expect(
        verifyStudioEstimateToken({
          token,
          secret: SECRET,
          nowMs: NOW_MS,
          expectedVersionBinding,
        }),
      ).toEqual({ valid: false, reason: 'pricing_stale' });
    }
  });

  test('keeps omitted bindings on the deployed v1 format', () => {
    const token = issueStudioEstimateToken(baseIssueInput);

    expect(token.startsWith('studio-estimate-v1.')).toBe(true);
    const verified = verifyStudioEstimateToken({ token, secret: SECRET, nowMs: NOW_MS });
    expect(verified.valid).toBe(true);
    if (!verified.valid) throw new Error('Expected valid Studio estimate v1 claims');
    expect(verified.claims.version).toBe(1);
    expect(verified.claims.estimate).toEqual(unsignedEstimate);
  });

  test('rejects expired v2 tokens', () => {
    const token = issueStudioEstimateToken({
      ...baseIssueInput,
      versionBinding: VERSION_BINDING,
    });

    expect(
      verifyStudioEstimateToken({
        token,
        secret: SECRET,
        nowMs: Date.parse(unsignedEstimate.expires_at),
      }),
    ).toEqual({ valid: false, reason: 'expired' });
  });

  test('rejects signature tampering and v1 signatures moved to the v2 domain', () => {
    const v2Token = issueStudioEstimateToken({
      ...baseIssueInput,
      versionBinding: VERSION_BINDING,
    });
    const signature = v2Token.split('.')[2];
    if (!signature) throw new Error('Expected a token signature');
    const tamperedToken = `${v2Token.slice(0, -1)}${signature.endsWith('a') ? 'b' : 'a'}`;
    expect(
      verifyStudioEstimateToken({ token: tamperedToken, secret: SECRET, nowMs: NOW_MS }),
    ).toEqual({ valid: false, reason: 'invalid_signature' });

    const v1Token = issueStudioEstimateToken(baseIssueInput);
    const crossDomainToken = v1Token.replace('studio-estimate-v1.', 'studio-estimate-v2.');
    expect(
      verifyStudioEstimateToken({ token: crossDomainToken, secret: SECRET, nowMs: NOW_MS }),
    ).toEqual({ valid: false, reason: 'invalid_signature' });
  });
});
