import { createHash, randomBytes } from 'node:crypto';
import type { SyntheticCapabilityFixture } from '../sandbox/types';

export const VERIFICATION_CAPABILITY_AUDIENCE = 'openopc-verification-capability-broker' as const;

export class DeveloperVerificationCapabilityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'DeveloperVerificationCapabilityError';
  }
}

export interface VerificationCapabilityGrantInput {
  releaseId: string;
  artifactDigest: `sha256:${string}`;
  runId: string;
  sandboxInstanceId: string;
  fixtures: readonly SyntheticCapabilityFixture[];
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  policyDigest: `sha256:${string}`;
  maxCalls: number;
  maxPayloadBytes: number;
}

export interface VerificationCapabilityAuthorization {
  token: string;
  audience: string;
  nonce: string;
  runId: string;
  sandboxInstanceId: string;
  action: string;
  payloadBytes: number;
  now: string;
}

interface StoredVerificationCapability {
  tokenHash: `sha256:${string}`;
  nonceHash: `sha256:${string}`;
  releaseId: string;
  artifactDigest: `sha256:${string}`;
  runId: string;
  sandboxInstanceId: string;
  allowedSyntheticActions: string[];
  issuedAt: string;
  expiresAt: string;
  policyDigest: `sha256:${string}`;
  maxCalls: number;
  maxPayloadBytes: number;
  callsUsed: number;
  payloadBytesUsed: number;
  revoked: boolean;
}

interface CapabilityEvidence {
  runId: string;
  action: string;
  outcome: 'allowed' | 'denied';
  reason: string;
  observedAt: string;
}

export function createMemoryVerificationCapabilityBroker(input?: {
  tokenFactory?: () => string;
}): {
  broker: {
    issue(input: VerificationCapabilityGrantInput): Promise<{ token: string; expiresAt: string }>;
    authorize(input: VerificationCapabilityAuthorization): Promise<SyntheticCapabilityFixture>;
    evidence(runId: string): Promise<unknown[]>;
    revokeRun(runId: string): Promise<void>;
  };
  snapshot(): Array<Record<string, unknown>>;
} {
  const records = new Map<string, StoredVerificationCapability>();
  const fixtures = new Map<string, Map<string, SyntheticCapabilityFixture>>();
  const evidenceByRun = new Map<string, CapabilityEvidence[]>();
  const tokenFactory = input?.tokenFactory ?? (() => randomBytes(32).toString('base64url'));

  const recordEvidence = (
    runId: string,
    action: string,
    outcome: CapabilityEvidence['outcome'],
    reason: string,
    observedAt: string,
  ): void => {
    const history = evidenceByRun.get(runId) ?? [];
    history.push({
      runId: safeCoordinate(runId) ? runId : 'unknown-run',
      action: safeAction(action) ? action : 'unknown-action',
      outcome,
      reason,
      observedAt: validTime(observedAt)
        ? new Date(observedAt).toISOString()
        : new Date(0).toISOString(),
    });
    evidenceByRun.set(runId, history);
  };

  const deny = (authorization: VerificationCapabilityAuthorization, reason: string): never => {
    recordEvidence(authorization.runId, authorization.action, 'denied', reason, authorization.now);
    throw new DeveloperVerificationCapabilityError('DEVELOPER_VERIFICATION_CAPABILITY_DENIED');
  };

  return {
    broker: {
      async issue(grant) {
        validateGrant(grant);
        const token = tokenFactory();
        if (!safeToken(token)) {
          throw new DeveloperVerificationCapabilityError(
            'DEVELOPER_VERIFICATION_CAPABILITY_ISSUER_INVALID',
          );
        }
        const tokenHash = digest(token);
        if (records.has(tokenHash)) {
          throw new DeveloperVerificationCapabilityError(
            'DEVELOPER_VERIFICATION_CAPABILITY_TOKEN_COLLISION',
          );
        }
        const fixtureMap = new Map<string, SyntheticCapabilityFixture>();
        for (const fixture of grant.fixtures) {
          if (fixtureMap.has(fixture.action)) {
            throw new DeveloperVerificationCapabilityError(
              'DEVELOPER_VERIFICATION_CAPABILITY_GRANT_INVALID',
            );
          }
          fixtureMap.set(fixture.action, structuredClone(fixture));
        }
        records.set(tokenHash, {
          tokenHash,
          nonceHash: digest(grant.nonce),
          releaseId: grant.releaseId,
          artifactDigest: grant.artifactDigest,
          runId: grant.runId,
          sandboxInstanceId: grant.sandboxInstanceId,
          allowedSyntheticActions: [...fixtureMap.keys()].sort(compareText),
          issuedAt: new Date(grant.issuedAt).toISOString(),
          expiresAt: new Date(grant.expiresAt).toISOString(),
          policyDigest: grant.policyDigest,
          maxCalls: grant.maxCalls,
          maxPayloadBytes: grant.maxPayloadBytes,
          callsUsed: 0,
          payloadBytesUsed: 0,
          revoked: false,
        });
        fixtures.set(tokenHash, fixtureMap);
        return { token, expiresAt: new Date(grant.expiresAt).toISOString() };
      },
      async authorize(authorization) {
        if (
          !safeToken(authorization.token) ||
          !safeToken(authorization.nonce) ||
          !safeCoordinate(authorization.runId) ||
          !safeCoordinate(authorization.sandboxInstanceId) ||
          !safeAction(authorization.action) ||
          !Number.isSafeInteger(authorization.payloadBytes) ||
          authorization.payloadBytes < 0 ||
          !validTime(authorization.now)
        ) {
          deny(authorization, 'invalid_request');
        }
        const tokenHash = digest(authorization.token);
        const record = records.get(tokenHash) ?? deny(authorization, 'unknown_token');
        const now = Date.parse(authorization.now);
        if (
          authorization.audience !== VERIFICATION_CAPABILITY_AUDIENCE ||
          digest(authorization.nonce) !== record.nonceHash ||
          authorization.runId !== record.runId ||
          authorization.sandboxInstanceId !== record.sandboxInstanceId ||
          now < Date.parse(record.issuedAt) ||
          now >= Date.parse(record.expiresAt) ||
          record.revoked ||
          !record.allowedSyntheticActions.includes(authorization.action) ||
          record.callsUsed >= record.maxCalls ||
          authorization.payloadBytes > record.maxPayloadBytes ||
          record.payloadBytesUsed + authorization.payloadBytes > record.maxPayloadBytes
        ) {
          deny(authorization, 'grant_mismatch_or_limit');
        }
        const fixture =
          fixtures.get(tokenHash)?.get(authorization.action) ??
          deny(authorization, 'fixture_unavailable');
        record.callsUsed += 1;
        record.payloadBytesUsed += authorization.payloadBytes;
        recordEvidence(
          record.runId,
          authorization.action,
          'allowed',
          'synthetic_fixture',
          authorization.now,
        );
        return structuredClone(fixture);
      },
      async evidence(runId) {
        return structuredClone(evidenceByRun.get(runId) ?? []);
      },
      async revokeRun(runId) {
        for (const record of records.values()) {
          if (record.runId === runId) record.revoked = true;
        }
      },
    },
    snapshot() {
      return [...records.values()]
        .sort((left, right) => compareText(left.tokenHash, right.tokenHash))
        .map((record) => structuredClone(record) as unknown as Record<string, unknown>);
    },
  };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeCoordinate(value: string): boolean {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\0\r\n]/.test(value)
  );
}

function safeAction(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function safeToken(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 4096 &&
    !/[\0\r\n]/.test(value)
  );
}

function validTime(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function validateGrant(grant: VerificationCapabilityGrantInput): void {
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (
    !safeCoordinate(grant.releaseId) ||
    !safeCoordinate(grant.runId) ||
    !safeCoordinate(grant.sandboxInstanceId) ||
    !DIGEST.test(grant.artifactDigest) ||
    !DIGEST.test(grant.policyDigest) ||
    !safeToken(grant.nonce) ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 15 * 60 * 1000 ||
    !Number.isSafeInteger(grant.maxCalls) ||
    grant.maxCalls < 1 ||
    grant.maxCalls > 1_000 ||
    !Number.isSafeInteger(grant.maxPayloadBytes) ||
    grant.maxPayloadBytes < 1 ||
    grant.maxPayloadBytes > 1024 * 1024 ||
    !Array.isArray(grant.fixtures) ||
    grant.fixtures.length === 0 ||
    grant.fixtures.length > 100 ||
    grant.fixtures.some((fixture) => !safeAction(fixture.action))
  ) {
    throw new DeveloperVerificationCapabilityError(
      'DEVELOPER_VERIFICATION_CAPABILITY_GRANT_INVALID',
    );
  }
}
