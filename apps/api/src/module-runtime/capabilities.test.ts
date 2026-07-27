import { describe, expect, test } from 'bun:test';
import { generateKeys, verify } from 'paseto-ts/v4';

import { parseCapabilityTokenClaims } from '@openopc/module-runtime-contracts';

import {
  ModuleCapabilityBroker,
  type ModuleCapabilityPersistence,
  hashModuleCapabilityToken,
} from './capabilities';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const EXECUTION_ID = '80000000-0000-4000-a000-000000000001';
const LEASE_ID = '90000000-0000-4000-a000-000000000001';
const RUNNER_ID = '70000000-0000-4000-a000-000000000001';
const GRANT_ID = 'a1000000-0000-4000-8000-000000000001';
const NONCE = 'a0000000-0000-4000-8000-000000000001';
const RELEASE_DIGEST = `sha256:${'a'.repeat(64)}` as const;
const CERTIFICATE = 'b'.repeat(64);
const NOW = '2099-07-27T08:00:00.000Z';
const EXPIRES_AT = '2099-07-27T08:00:20.000Z';
const LEASE_DEADLINE = '2099-07-27T08:00:30.000Z';

function issueInput() {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    executionId: EXECUTION_ID,
    releaseDigest: RELEASE_DIGEST,
    actor: { type: 'runner' as const, id: RUNNER_ID },
    action: 'http.request',
    audience: 'egress' as const,
    runtimeKind: 'wasi-component' as const,
    lease: { id: LEASE_ID, generation: 3, deadline: LEASE_DEADLINE },
    killSwitchGeneration: 4,
    certificateThumbprint: CERTIFICATE,
    expiresAt: EXPIRES_AT,
    ceilings: {
      maxCalls: 1,
      maxRequestBytes: 65_536,
      maxResponseBytes: 262_144,
      cpuMillis: 2_000,
      wallTimeMs: 5_000,
      costMicro: 50_000,
    },
    egress: { origins: ['https://api.example.com'], methods: ['POST'] },
  };
}

function fixture() {
  const stored: Record<string, unknown>[] = [];
  const revoked: Record<string, unknown>[] = [];
  const persistence: ModuleCapabilityPersistence = {
    async store(input) {
      stored.push(structuredClone(input) as unknown as Record<string, unknown>);
      return {
        grantId: input.grantId,
        executionId: input.executionId,
        accountId: input.accountId,
        projectId: input.projectId,
        leaseId: input.leaseId,
        audience: input.audience,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        revokedAt: null,
        createdAt: NOW,
      };
    },
    async revokeByExecution(input) {
      revoked.push(structuredClone(input) as unknown as Record<string, unknown>);
      return 1;
    },
  };
  return { persistence, stored, revoked };
}

describe('module capability broker', () => {
  test('issues a verifiable v4.public token and persists only its hash', async () => {
    const keys = generateKeys('public');
    const state = fixture();
    const broker = new ModuleCapabilityBroker({
      persistence: state.persistence,
      secretKey: keys.secretKey,
      keyId: 'openopc-capability-staging-2026-01',
      now: () => new Date(NOW),
      createGrantId: () => GRANT_ID,
      createNonce: () => NONCE,
    });

    const issued = await broker.issue(issueInput());

    expect(issued.token.startsWith('v4.public.')).toBe(true);
    const verified = await verify(keys.publicKey, issued.token, { validatePayload: false });
    expect(verified.footer).toEqual({ kid: 'openopc-capability-staging-2026-01' });
    const claims = parseCapabilityTokenClaims(verified.payload);
    expect(claims).toMatchObject({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      releaseDigest: RELEASE_DIGEST,
      actor: { type: 'runner', id: RUNNER_ID },
      action: 'http.request',
      aud: 'openopc:capability/egress',
      runtimeKind: 'wasi-component',
      lease: { id: LEASE_ID, generation: 3 },
      killSwitchGeneration: 4,
      cnf: { certificateSha256: CERTIFICATE },
      ceilings: { maxCalls: 1, costMicro: 50_000 },
    });
    expect(issued.grant.tokenHash).toBe(hashModuleCapabilityToken(issued.token));
    expect(state.stored).toHaveLength(1);
    expect(state.stored[0]).toMatchObject({
      grantId: GRANT_ID,
      executionId: EXECUTION_ID,
      leaseId: LEASE_ID,
      tokenHash: issued.grant.tokenHash,
      expiresAt: EXPIRES_AT,
    });
    expect(JSON.stringify(state.stored[0])).not.toContain(issued.token);
  });

  test('rejects a capability that can outlive its lease before signing or persistence', async () => {
    const keys = generateKeys('public');
    const state = fixture();
    const broker = new ModuleCapabilityBroker({
      persistence: state.persistence,
      secretKey: keys.secretKey,
      keyId: 'openopc-capability-staging-2026-01',
      now: () => new Date(NOW),
      createGrantId: () => GRANT_ID,
      createNonce: () => NONCE,
    });

    await expect(
      broker.issue({ ...issueInput(), expiresAt: '2099-07-27T08:00:31.000Z' }),
    ).rejects.toMatchObject({ code: 'MODULE_CAPABILITY_INPUT_INVALID' });
    expect(state.stored).toEqual([]);
  });

  test('revokes every live grant through the tenant-qualified execution boundary', async () => {
    const keys = generateKeys('public');
    const state = fixture();
    const broker = new ModuleCapabilityBroker({
      persistence: state.persistence,
      secretKey: keys.secretKey,
      keyId: 'openopc-capability-staging-2026-01',
      now: () => new Date(NOW),
      createGrantId: () => GRANT_ID,
      createNonce: () => NONCE,
    });

    await expect(
      broker.revokeByExecution({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
      }),
    ).resolves.toBe(1);
    expect(state.revoked).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        executionId: EXECUTION_ID,
        revokedAt: NOW,
      },
    ]);
  });
});
