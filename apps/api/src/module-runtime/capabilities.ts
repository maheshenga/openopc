import { createHash, randomUUID } from 'node:crypto';
import { sign } from 'paseto-ts/v4';

import {
  type CapabilityTokenClaimsV1,
  parseCapabilityTokenClaims,
} from '@openopc/module-runtime-contracts';

import type { ModuleCapabilityAudience, ModuleCapabilityGrant } from './executions';

export interface PersistModuleCapabilityInput {
  grantId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  leaseId: string;
  runnerId: string;
  leaseGeneration: number;
  audience: ModuleCapabilityAudience;
  tokenHash: `sha256:${string}`;
  expiresAt: string;
}

export interface ModuleCapabilityPersistence {
  store(input: PersistModuleCapabilityInput): Promise<ModuleCapabilityGrant>;
  revokeByExecution(input: {
    accountId: string;
    projectId: string;
    executionId: string;
    revokedAt: string;
  }): Promise<number>;
}

export interface IssueModuleCapabilityInput {
  accountId: string;
  projectId: string;
  installationId: string;
  executionId: string;
  releaseDigest: `sha256:${string}`;
  actor: CapabilityTokenClaimsV1['actor'];
  action: string;
  audience: ModuleCapabilityAudience;
  runtimeKind: CapabilityTokenClaimsV1['runtimeKind'];
  lease: CapabilityTokenClaimsV1['lease'];
  killSwitchGeneration: number;
  certificateThumbprint: string;
  expiresAt: string;
  ceilings: CapabilityTokenClaimsV1['ceilings'];
  egress?: CapabilityTokenClaimsV1['egress'];
}

export class ModuleCapabilityError extends Error {
  constructor(readonly code: 'MODULE_CAPABILITY_INPUT_INVALID' | 'MODULE_CAPABILITY_UNAVAILABLE') {
    super(code);
    this.name = 'ModuleCapabilityError';
  }
}

export function hashModuleCapabilityToken(token: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export class ModuleCapabilityBroker {
  readonly #input: {
    persistence: ModuleCapabilityPersistence;
    secretKey: string;
    keyId: string;
    now: () => Date;
    createGrantId: () => string;
    createNonce: () => string;
  };

  constructor(input: {
    persistence: ModuleCapabilityPersistence;
    secretKey: string;
    keyId: string;
    now?: () => Date;
    createGrantId?: () => string;
    createNonce?: () => string;
  }) {
    if (
      !input.secretKey.startsWith('k4.secret.') ||
      !/^openopc-capability-(?:development|test|staging)-[A-Za-z0-9._-]{1,64}$/.test(input.keyId)
    ) {
      throw new ModuleCapabilityError('MODULE_CAPABILITY_UNAVAILABLE');
    }
    this.#input = {
      ...input,
      now: input.now ?? (() => new Date()),
      createGrantId: input.createGrantId ?? randomUUID,
      createNonce: input.createNonce ?? randomUUID,
    };
  }

  async issue(
    input: IssueModuleCapabilityInput,
  ): Promise<{ token: string; grant: ModuleCapabilityGrant }> {
    if (input.actor.type !== 'runner') {
      throw new ModuleCapabilityError('MODULE_CAPABILITY_INPUT_INVALID');
    }
    const now = this.#input.now();
    const claims: CapabilityTokenClaimsV1 = {
      capabilityVersion: 1,
      iss: 'openopc-control-plane',
      aud: `openopc:capability/${input.audience}`,
      sub: input.executionId,
      jti: this.#input.createNonce(),
      iat: now.toISOString(),
      exp: input.expiresAt,
      grantId: this.#input.createGrantId(),
      accountId: input.accountId,
      projectId: input.projectId,
      installationId: input.installationId,
      releaseDigest: input.releaseDigest,
      actor: input.actor,
      action: input.action,
      runtimeKind: input.runtimeKind,
      lease: { ...input.lease },
      killSwitchGeneration: input.killSwitchGeneration,
      cnf: { certificateSha256: input.certificateThumbprint },
      ceilings: { ...input.ceilings },
      ...(input.egress ? { egress: structuredClone(input.egress) } : {}),
    };
    try {
      parseCapabilityTokenClaims(claims);
    } catch {
      throw new ModuleCapabilityError('MODULE_CAPABILITY_INPUT_INVALID');
    }
    let token: string;
    try {
      token = await sign(this.#input.secretKey, claims, {
        footer: { kid: this.#input.keyId },
        addIat: false,
        addExp: false,
        maxDepth: 8,
        maxKeys: 64,
        validatePayload: false,
      });
    } catch {
      throw new ModuleCapabilityError('MODULE_CAPABILITY_UNAVAILABLE');
    }
    const tokenHash = hashModuleCapabilityToken(token);
    const grant = await this.#input.persistence.store({
      grantId: claims.grantId,
      executionId: claims.sub,
      accountId: claims.accountId,
      projectId: claims.projectId,
      leaseId: claims.lease.id,
      runnerId: claims.actor.id,
      leaseGeneration: claims.lease.generation,
      audience: input.audience,
      tokenHash,
      expiresAt: claims.exp,
    });
    return { token, grant };
  }

  async revokeByExecution(input: {
    accountId: string;
    projectId: string;
    executionId: string;
  }): Promise<number> {
    return this.#input.persistence.revokeByExecution({
      ...input,
      revokedAt: this.#input.now().toISOString(),
    });
  }
}
