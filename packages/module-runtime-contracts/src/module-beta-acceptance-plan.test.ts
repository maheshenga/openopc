import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';

import type { ModuleBetaAcceptancePlanV1 } from './module-beta-acceptance-plan';
import {
  authenticateModuleBetaAcceptancePlan,
  encodeModuleBetaAcceptancePlan,
  moduleBetaAcceptanceObjectKey,
  verifyModuleBetaAcceptancePlan,
} from './module-beta-acceptance-plan';

const NOW = new Date('2026-07-26T12:00:00.000Z');
const KEY = new Uint8Array(32).fill(0x5a);

function plan(overrides: Partial<ModuleBetaAcceptancePlanV1> = {}): ModuleBetaAcceptancePlanV1 {
  return {
    schemaVersion: 1,
    registrationId: '60000000-0000-4000-a000-000000000006',
    acceptanceRunId: 'gha:12345:1',
    scenario: 'clean-wasi',
    accountId: '10000000-0000-4000-a000-000000000001',
    artifactId: '20000000-0000-4000-a000-000000000002',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    issuedAt: '2026-07-26T12:00:00.000Z',
    expiresAt: '2026-07-26T12:15:00.000Z',
    controllerIdentity: `module-beta-controller@1.0.0#sha256:${'b'.repeat(64)}`,
    ...overrides,
  };
}

describe('module beta acceptance plan codec', () => {
  test('round trips a valid plan and returns a structured clone', () => {
    const source = plan();
    const bytes = encodeModuleBetaAcceptancePlan(source, KEY);
    const verified = verifyModuleBetaAcceptancePlan(bytes, { key: KEY, now: NOW });

    expect(verified).toEqual(source);
    expect(verified).not.toBe(source);
  });

  test('accepts only Uint8Array keys from 32 through 128 bytes', () => {
    expect(() => encodeModuleBetaAcceptancePlan(plan(), new Uint8Array(31))).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID',
    );
    expect(() => encodeModuleBetaAcceptancePlan(plan(), new Uint8Array(129))).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID',
    );
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan(), 'not-bytes' as unknown as Uint8Array),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID');

    const bytes = encodeModuleBetaAcceptancePlan(plan(), KEY);
    expect(() =>
      verifyModuleBetaAcceptancePlan(bytes, { key: new Uint8Array(31), now: NOW }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID');
    expect(() =>
      verifyModuleBetaAcceptancePlan(bytes, { key: new Uint8Array(129), now: NOW }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_KEY_INVALID');

    expect(() => encodeModuleBetaAcceptancePlan(plan(), new Uint8Array(128))).not.toThrow();
  });

  test('requires schema version 1 and the exact plan fields', () => {
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        { ...plan(), schemaVersion: 2 } as unknown as ModuleBetaAcceptancePlanV1,
        KEY,
      ),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    const { artifactId: _artifactId, ...missing } = plan();
    expect(() =>
      encodeModuleBetaAcceptancePlan(missing as ModuleBetaAcceptancePlanV1, KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        { ...plan(), fault: 'scanner-crash' } as ModuleBetaAcceptancePlanV1,
        KEY,
      ),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  });

  test('binds registration, account, and artifact to UUIDs', () => {
    for (const field of ['registrationId', 'accountId', 'artifactId'] as const) {
      expect(() => encodeModuleBetaAcceptancePlan(plan({ [field]: 'not-a-uuid' }), KEY)).toThrow(
        'MODULE_BETA_ACCEPTANCE_PLAN_INVALID',
      );
      expect(() =>
        encodeModuleBetaAcceptancePlan(plan({ [field]: plan()[field].toUpperCase() }), KEY),
      ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    }
  });

  test('accepts only bounded run IDs and known trust scenarios', () => {
    expect(() => encodeModuleBetaAcceptancePlan(plan({ acceptanceRunId: '' }), KEY)).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_INVALID',
    );
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        plan({ scenario: 'unknown' as ModuleBetaAcceptancePlanV1['scenario'] }),
        KEY,
      ),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');

    for (const scenario of [
      'clean-wasi',
      'secret-leak',
      'vulnerable-lockfile',
      'invalid-signature',
      'stale-policy',
      'scanner-crash',
    ] as const) {
      expect(() => encodeModuleBetaAcceptancePlan(plan({ scenario }), KEY)).not.toThrow();
    }
  });

  test('requires lowercase artifact and controller identity digest pins', () => {
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan({ artifactDigest: `sha256:${'A'.repeat(64)}` }), KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        plan({ controllerIdentity: 'module-beta-controller@1.0.0' }),
        KEY,
      ),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        plan({
          controllerIdentity: `module-beta-controller@1.0.0#SHA256:${'b'.repeat(64)}`,
        }),
        KEY,
      ),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  });

  test('requires strict UTC RFC3339 times with a maximum 15 minute lifetime', () => {
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan({ issuedAt: '2026-07-26T12:00:00+00:00' }), KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan({ issuedAt: '2026-02-30T12:00:00Z' }), KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan({ expiresAt: '2026-07-26T12:00:00.000Z' }), KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    expect(() =>
      encodeModuleBetaAcceptancePlan(plan({ expiresAt: '2026-07-26T12:15:00.000000001Z' }), KEY),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');

    expect(() =>
      encodeModuleBetaAcceptancePlan(
        plan({
          issuedAt: '2026-07-26T12:00:00.000000001Z',
          expiresAt: '2026-07-26T12:15:00.000000001Z',
        }),
        KEY,
      ),
    ).not.toThrow();
    expect(() =>
      encodeModuleBetaAcceptancePlan(
        plan({ issuedAt: '2026-07-26T12:00:00Z', expiresAt: '2026-07-26T12:15:00Z' }),
        KEY,
      ),
    ).not.toThrow();
  });

  test('allows at most 60 seconds of verification clock skew', () => {
    const futureBoundary = encodeModuleBetaAcceptancePlan(
      plan({ issuedAt: '2026-07-26T12:01:00Z' }),
      KEY,
    );
    expect(() =>
      verifyModuleBetaAcceptancePlan(futureBoundary, { key: KEY, now: NOW }),
    ).not.toThrow();

    const future = encodeModuleBetaAcceptancePlan(
      plan({ issuedAt: '2026-07-26T12:01:00.000000001Z' }),
      KEY,
    );
    expect(() => verifyModuleBetaAcceptancePlan(future, { key: KEY, now: NOW })).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_NOT_YET_VALID',
    );

    const expiredBoundary = encodeModuleBetaAcceptancePlan(
      plan({ issuedAt: '2026-07-26T11:44:00Z', expiresAt: '2026-07-26T11:59:00Z' }),
      KEY,
    );
    expect(() =>
      verifyModuleBetaAcceptancePlan(expiredBoundary, { key: KEY, now: NOW }),
    ).not.toThrow();

    const expired = encodeModuleBetaAcceptancePlan(
      plan({
        issuedAt: '2026-07-26T11:44:00Z',
        expiresAt: '2026-07-26T11:58:59.999999999Z',
      }),
      KEY,
    );
    expect(() => verifyModuleBetaAcceptancePlan(expired, { key: KEY, now: NOW })).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_EXPIRED',
    );
    expect(() =>
      verifyModuleBetaAcceptancePlan(expiredBoundary, {
        key: KEY,
        now: new Date('invalid'),
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_NOW_INVALID');
  });

  test('authenticates a consumed plan after its registration window has expired', () => {
    const expired = encodeModuleBetaAcceptancePlan(
      plan({
        issuedAt: '2026-07-26T11:30:00Z',
        expiresAt: '2026-07-26T11:45:00Z',
      }),
      KEY,
    );

    expect(() => verifyModuleBetaAcceptancePlan(expired, { key: KEY, now: NOW })).toThrow(
      'MODULE_BETA_ACCEPTANCE_PLAN_EXPIRED',
    );
    expect(authenticateModuleBetaAcceptancePlan(expired, KEY)).toEqual(
      plan({
        issuedAt: '2026-07-26T11:30:00Z',
        expiresAt: '2026-07-26T11:45:00Z',
      }),
    );
  });

  test('derives domain-separated account-partitioned acceptance object keys', () => {
    const accountId = '10000000-0000-4000-a000-000000000001';
    const artifactId = '20000000-0000-4000-a000-000000000002';
    const accountPartition = createHash('sha256')
      .update(`openopc-module-beta-acceptance\0${accountId}`, 'utf8')
      .digest('hex');

    expect(moduleBetaAcceptanceObjectKey({ accountId, artifactId, kind: 'plan' })).toBe(
      `developer-trust/acceptance/${accountPartition}/${artifactId}/plan.v1.json`,
    );
    expect(
      moduleBetaAcceptanceObjectKey({
        accountId,
        artifactId,
        kind: 'consumption',
        prefix: 'staging/developer-trust/acceptance',
      }),
    ).toBe(
      `staging/developer-trust/acceptance/${accountPartition}/${artifactId}/consumption.v1.json`,
    );
  });

  test('rejects unsafe acceptance object key coordinates and prefixes', () => {
    const valid = {
      accountId: '10000000-0000-4000-a000-000000000001',
      artifactId: '20000000-0000-4000-a000-000000000002',
      kind: 'plan' as const,
    };
    expect(() => moduleBetaAcceptanceObjectKey({ ...valid, accountId: 'not-a-uuid' })).toThrow(
      'MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID',
    );
    expect(() =>
      moduleBetaAcceptanceObjectKey({ ...valid, artifactId: valid.artifactId.toUpperCase() }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');
    expect(() =>
      moduleBetaAcceptanceObjectKey({
        ...valid,
        kind: 'receipt' as unknown as 'plan',
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');

    for (const prefix of ['', '/absolute', 'trailing/', 'double//slash', 'a/../b', 'a\\b']) {
      expect(() => moduleBetaAcceptanceObjectKey({ ...valid, prefix })).toThrow(
        'MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID',
      );
    }
    expect(() => moduleBetaAcceptanceObjectKey({ ...valid, prefix: 'a'.repeat(257) })).toThrow(
      'MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID',
    );
    expect(() =>
      moduleBetaAcceptanceObjectKey({ ...valid, prefix: 123 as unknown as string }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_OBJECT_KEY_INVALID');
  });

  test('rejects unknown, duplicate, and non-canonical envelope representations', () => {
    const canonical = new TextDecoder().decode(encodeModuleBetaAcceptancePlan(plan(), KEY));
    const envelope = JSON.parse(canonical) as {
      hmacSha256: string;
      plan: ModuleBetaAcceptancePlanV1;
    };
    const variants = [
      ` ${canonical}`,
      JSON.stringify({ plan: envelope.plan, hmacSha256: envelope.hmacSha256 }),
      `{"hmacSha256":${JSON.stringify(envelope.hmacSha256)},"hmacSha256":${JSON.stringify(
        envelope.hmacSha256,
      )},"plan":${JSON.stringify(envelope.plan)}}`,
      JSON.stringify({ extra: true, hmacSha256: envelope.hmacSha256, plan: envelope.plan }),
    ];

    for (const variant of variants) {
      expect(() =>
        verifyModuleBetaAcceptancePlan(new TextEncoder().encode(variant), {
          key: KEY,
          now: NOW,
        }),
      ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
    }
  });

  test('bounds encoded and verified envelopes to 16 KiB', () => {
    const encoded = encodeModuleBetaAcceptancePlan(plan(), KEY);
    expect(encoded.byteLength).toBeLessThanOrEqual(16 * 1024);
    expect(() =>
      verifyModuleBetaAcceptancePlan(new Uint8Array(16 * 1024 + 1), {
        key: KEY,
        now: NOW,
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_TOO_LARGE');
  });

  test('encodes canonical JSON with HMAC-SHA256 over canonical plan bytes', () => {
    const source = plan();
    const canonicalPlan = JSON.stringify({
      acceptanceRunId: source.acceptanceRunId,
      accountId: source.accountId,
      artifactDigest: source.artifactDigest,
      artifactId: source.artifactId,
      controllerIdentity: source.controllerIdentity,
      expiresAt: source.expiresAt,
      issuedAt: source.issuedAt,
      registrationId: source.registrationId,
      scenario: source.scenario,
      schemaVersion: source.schemaVersion,
    });
    const mac = createHmac('sha256', KEY).update(canonicalPlan, 'utf8').digest('hex');

    expect(new TextDecoder().decode(encodeModuleBetaAcceptancePlan(source, KEY))).toBe(
      `{"hmacSha256":"sha256:${mac}","plan":${canonicalPlan}}`,
    );
  });

  test('rejects a valid-width MAC after a bound plan field is tampered', () => {
    const envelope = JSON.parse(
      new TextDecoder().decode(encodeModuleBetaAcceptancePlan(plan(), KEY)),
    ) as { hmacSha256: string; plan: ModuleBetaAcceptancePlanV1 };
    envelope.plan.artifactId = '20000000-0000-4000-a000-000000000003';

    expect(() =>
      verifyModuleBetaAcceptancePlan(new TextEncoder().encode(JSON.stringify(envelope)), {
        key: KEY,
        now: NOW,
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_MAC_INVALID');
  });

  test('decodes untrusted envelopes with fatal UTF-8 semantics', () => {
    expect(() =>
      verifyModuleBetaAcceptancePlan(new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d]), {
        key: KEY,
        now: NOW,
      }),
    ).toThrow('MODULE_BETA_ACCEPTANCE_PLAN_INVALID');
  });
});
