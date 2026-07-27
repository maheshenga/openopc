import { createHash, randomUUID } from 'node:crypto';

import {
  type Sha256Digest,
  type WorkEnvelopeV1,
  parseWorkEnvelope,
} from '@openopc/module-runtime-contracts';

import {
  type FinalizeModuleExecutionResult,
  type HeartbeatModuleExecutionLeaseResult,
  MODULE_EXECUTION_LEASE_DURATION_MS,
  type ModuleCapabilityAudience,
  type ModuleExecution,
  type ModuleExecutionBinding,
  type ModuleExecutionEvent,
  type ModuleExecutionLease,
  type ModuleExecutionRepository,
  type ModuleExecutionTerminalState,
  computeModuleExecutionBindingDigest,
} from './executions';

export interface ModuleRunnerIdentity {
  runnerId: string;
  accountId: string;
  certificateThumbprint: string;
}

export interface ModuleRunnerProfile {
  profileName: string;
  runtimeKind: ModuleExecutionBinding['runtimeKind'];
}

export interface ModuleRunnerNode {
  runnerId: string;
  accountId: string;
  nodeIdentity: string;
  status: 'active' | 'draining' | 'quarantined' | 'revoked';
  softwareVersion: string;
  attestationDigest: `sha256:${string}`;
  certificateThumbprint: string;
  profiles: readonly ModuleRunnerProfile[];
  updatedAt: string;
}

export interface ModuleRunnerRepository {
  get(runnerId: string): Promise<ModuleRunnerNode | null>;
  register(runner: ModuleRunnerNode): Promise<ModuleRunnerNode>;
  heartbeat(input: {
    runnerId: string;
    softwareVersion: string;
    attestationDigest: `sha256:${string}`;
    updatedAt: string;
  }): Promise<ModuleRunnerNode>;
}

export interface RunnerRegistrationIdentity {
  certificateThumbprint: string;
}

export interface RunnerRegistrationCommand {
  registrationToken: string;
  nodeIdentity: string;
  softwareVersion: string;
  attestationDigest: `sha256:${string}`;
  profiles: readonly ModuleRunnerProfile[];
}

export interface RunnerRegistrationVerifier {
  verify(input: {
    registrationToken: string;
    certificateThumbprint: string;
  }): Promise<{ accountId: string } | null>;
}

export interface RunnerNodeHeartbeatCommand {
  softwareVersion: string;
  attestationDigest: `sha256:${string}`;
}

export interface RunnerClaimBindingResolver {
  resolveForClaim(executionId: string): Promise<ModuleExecutionBinding | null>;
}

export interface RunnerClaimCommand {
  executionId: string;
}

export interface RunnerLeaseHeartbeatCommand {
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
}

export interface RunnerAppendEvidenceCommand {
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  eventType: string;
  evidence: Record<string, unknown>;
}

export interface RunnerFinalizeCommand {
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  outcome: ModuleExecutionTerminalState;
  evidenceDigest: Sha256Digest;
  evidence: Record<string, unknown>;
  usage: Record<string, unknown>;
}

export interface RunnerClaimResponseV1 {
  signedEnvelope: string;
  capabilityTokens: readonly RunnerCapabilityTokenV1[];
}

export interface RunnerCapabilityTokenV1 {
  grantId: string;
  audience: ModuleCapabilityAudience;
  token: string;
}

export interface IssuedRunnerCapability extends RunnerCapabilityTokenV1 {
  expiresAt: string;
}

export interface RunnerCapabilityIssuer {
  issueForClaim(input: {
    runner: ModuleRunnerNode;
    execution: ModuleExecution;
    lease: ModuleExecutionLease;
    binding: ModuleExecutionBinding;
  }): Promise<readonly IssuedRunnerCapability[]>;
}

export interface WorkEnvelopeSigner {
  sign(envelope: WorkEnvelopeV1, metadata: { traceparent: string }): Promise<string>;
}

export type ModuleRunnerProtocolErrorCode =
  | 'RUNNER_AUTHENTICATION_FAILED'
  | 'RUNNER_REGISTRATION_INVALID'
  | 'RUNNER_EXECUTION_UNAVAILABLE'
  | 'RUNNER_PROFILE_UNAVAILABLE'
  | 'RUNNER_CAPABILITY_BINDING_INVALID'
  | 'RUNNER_CLAIM_UNAVAILABLE';

export class ModuleRunnerProtocolError extends Error {
  constructor(
    readonly code: ModuleRunnerProtocolErrorCode,
    readonly status: 401 | 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'ModuleRunnerProtocolError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function hashCapabilityToken(token: string): Sha256Digest {
  return `sha256:${createHash('sha256').update(token).digest('hex')}`;
}

export function capabilityEnvelopeAudience(audience: ModuleCapabilityAudience): string {
  return `openopc:capability/${audience}`;
}

function workEnvelopeTraceparent(executionId: string, leaseId: string): string {
  const traceId = createHash('sha256')
    .update(`execution:${executionId}`)
    .digest('hex')
    .slice(0, 32);
  const spanId = createHash('sha256').update(`lease:${leaseId}`).digest('hex').slice(0, 16);
  return `00-${traceId}-${spanId}-01`;
}

export function assertCapabilityTokenBindings(
  envelopeValue: unknown,
  tokens: readonly RunnerCapabilityTokenV1[],
): WorkEnvelopeV1 {
  const envelope = parseWorkEnvelope(envelopeValue);
  if (tokens.length !== envelope.grants.length) {
    throw new ModuleRunnerProtocolError('RUNNER_CAPABILITY_BINDING_INVALID', 409);
  }
  const tokensByGrant = new Map(tokens.map((token) => [token.grantId, token]));
  if (tokensByGrant.size !== tokens.length) {
    throw new ModuleRunnerProtocolError('RUNNER_CAPABILITY_BINDING_INVALID', 409);
  }
  for (const grant of envelope.grants) {
    const token = tokensByGrant.get(grant.id);
    if (
      !token ||
      capabilityEnvelopeAudience(token.audience) !== grant.audience ||
      hashCapabilityToken(token.token) !== grant.tokenHash
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_CAPABILITY_BINDING_INVALID', 409);
    }
  }
  return envelope;
}

export class ModuleRunnerProtocol {
  constructor(
    private readonly input: {
      executionRepository: ModuleExecutionRepository;
      runnerRepository: ModuleRunnerRepository;
      bindingResolver: RunnerClaimBindingResolver;
      registrationVerifier?: RunnerRegistrationVerifier;
      capabilityIssuer?: RunnerCapabilityIssuer;
      envelopeSigner?: WorkEnvelopeSigner;
      now?: () => Date;
      createId?: () => string;
      leaseDurationMs?: number;
    },
  ) {}

  private async authenticate(identity: ModuleRunnerIdentity): Promise<ModuleRunnerNode> {
    const runner = await this.input.runnerRepository.get(identity.runnerId);
    if (
      !runner ||
      runner.accountId !== identity.accountId ||
      runner.certificateThumbprint !== identity.certificateThumbprint ||
      runner.status !== 'active'
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
    }
    return runner;
  }

  async register(
    identity: RunnerRegistrationIdentity,
    command: RunnerRegistrationCommand,
  ): Promise<ModuleRunnerNode> {
    const registration = await this.input.registrationVerifier?.verify({
      registrationToken: command.registrationToken,
      certificateThumbprint: identity.certificateThumbprint,
    });
    if (
      !registration ||
      !/^[0-9a-f]{64}$/.test(identity.certificateThumbprint) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(command.nodeIdentity) ||
      command.softwareVersion.trim().length === 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(command.attestationDigest) ||
      command.profiles.length === 0 ||
      new Set(command.profiles.map((profile) => profile.profileName)).size !==
        command.profiles.length ||
      command.profiles.some(
        (profile) =>
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.profileName) ||
          !['wasi-component', 'oci-image'].includes(profile.runtimeKind),
      )
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_REGISTRATION_INVALID', 401);
    }
    const updatedAt = (this.input.now ?? (() => new Date()))().toISOString();
    return this.input.runnerRepository.register({
      runnerId: (this.input.createId ?? randomUUID)(),
      accountId: registration.accountId,
      nodeIdentity: command.nodeIdentity,
      status: 'active',
      softwareVersion: command.softwareVersion,
      attestationDigest: command.attestationDigest,
      certificateThumbprint: identity.certificateThumbprint,
      profiles: command.profiles.map(clone),
      updatedAt,
    });
  }

  async heartbeatNode(
    identity: ModuleRunnerIdentity,
    command: RunnerNodeHeartbeatCommand,
  ): Promise<ModuleRunnerNode> {
    const runner = await this.authenticate(identity);
    if (
      command.softwareVersion.trim().length === 0 ||
      !/^sha256:[0-9a-f]{64}$/.test(command.attestationDigest)
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_REGISTRATION_INVALID', 409);
    }
    return this.input.runnerRepository.heartbeat({
      runnerId: runner.runnerId,
      softwareVersion: command.softwareVersion,
      attestationDigest: command.attestationDigest,
      updatedAt: (this.input.now ?? (() => new Date()))().toISOString(),
    });
  }

  async claim(
    identity: ModuleRunnerIdentity,
    command: RunnerClaimCommand,
  ): Promise<RunnerClaimResponseV1> {
    const runner = await this.authenticate(identity);
    const execution = await this.input.executionRepository.findDispatchable(command.executionId);
    if (!execution || execution.accountId !== runner.accountId) {
      throw new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 404);
    }
    const binding = await this.input.bindingResolver.resolveForClaim(execution.executionId);
    if (
      !binding ||
      binding.accountId !== execution.accountId ||
      binding.projectId !== execution.projectId ||
      binding.installationId !== execution.installationId ||
      binding.releaseId !== execution.releaseId ||
      binding.consentRevisionId !== execution.consentRevisionId ||
      binding.runtimeDescriptorId !== execution.runtimeDescriptorId ||
      binding.killSwitchGeneration !== execution.killSwitchGeneration
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 404);
    }
    const supportsProfile = runner.profiles.some(
      (profile) =>
        profile.runtimeKind === binding.runtimeKind &&
        profile.profileName === binding.runtimeProfile,
    );
    if (!supportsProfile) {
      throw new ModuleRunnerProtocolError('RUNNER_PROFILE_UNAVAILABLE', 409);
    }
    if (
      (await computeModuleExecutionBindingDigest(binding, execution.deadlineAt)) !==
      execution.workEnvelopeDigest
    ) {
      throw new ModuleRunnerProtocolError('RUNNER_EXECUTION_UNAVAILABLE', 404);
    }
    if (!this.input.capabilityIssuer || !this.input.envelopeSigner) {
      throw new ModuleRunnerProtocolError('RUNNER_CLAIM_UNAVAILABLE', 503);
    }

    const now = (this.input.now ?? (() => new Date()))();
    const deadlineAt = new Date(
      Math.min(
        Date.parse(execution.deadlineAt),
        now.valueOf() + (this.input.leaseDurationMs ?? MODULE_EXECUTION_LEASE_DURATION_MS),
      ),
    ).toISOString();
    const claim = await this.input.executionRepository.claim({
      accountId: execution.accountId,
      projectId: execution.projectId,
      executionId: execution.executionId,
      runnerId: runner.runnerId,
      leaseId: (this.input.createId ?? randomUUID)(),
      deadlineAt,
    });
    try {
      const issued = await this.input.capabilityIssuer.issueForClaim({
        runner,
        execution: claim.execution,
        lease: claim.lease,
        binding,
      });
      const tokens: RunnerCapabilityTokenV1[] = issued.map(({ grantId, audience, token }) => ({
        grantId,
        audience,
        token,
      }));
      const grants = issued.map(({ grantId, audience, token, expiresAt }) => ({
        grantId,
        audience,
        tokenHash: hashCapabilityToken(token),
        expiresAt,
      }));
      await this.input.executionRepository.storeCapabilityGrants({
        accountId: execution.accountId,
        projectId: execution.projectId,
        executionId: execution.executionId,
        leaseId: claim.lease.leaseId,
        runnerId: runner.runnerId,
        generation: claim.lease.generation,
        grants,
      });
      const envelope: WorkEnvelopeV1 = {
        envelopeVersion: 1,
        executionId: execution.executionId,
        accountId: execution.accountId,
        projectId: execution.projectId,
        installationId: execution.installationId,
        idempotencyKey: execution.idempotencyKey,
        installRevision: binding.installRevision,
        releaseId: execution.releaseId,
        releaseDigest: binding.releaseDigest,
        consentRevisionId: execution.consentRevisionId,
        permissionDigest: binding.permissionDigest,
        runtimeDescriptorId: execution.runtimeDescriptorId,
        runtimeDescriptorDigest: binding.runtimeDescriptorDigest,
        runtimeKind: binding.runtimeKind,
        runtimeProfile: binding.runtimeProfile,
        policyDigest: binding.policyDigest,
        killSwitchGeneration: execution.killSwitchGeneration,
        executionDeadline: execution.deadlineAt,
        bindingDigest: execution.workEnvelopeDigest,
        resourceCeilings: { ...binding.resourceCeilings },
        lease: {
          id: claim.lease.leaseId,
          generation: claim.lease.generation,
          deadline: claim.lease.deadlineAt,
        },
        grants: grants.map(({ grantId, audience, tokenHash }) => ({
          id: grantId,
          audience: capabilityEnvelopeAudience(audience),
          tokenHash,
        })),
      };
      assertCapabilityTokenBindings(envelope, tokens);
      return {
        signedEnvelope: await this.input.envelopeSigner.sign(envelope, {
          traceparent: workEnvelopeTraceparent(execution.executionId, claim.lease.leaseId),
        }),
        capabilityTokens: tokens,
      };
    } catch (error) {
      await this.input.executionRepository
        .abandonClaim({
          accountId: execution.accountId,
          projectId: execution.projectId,
          executionId: execution.executionId,
          leaseId: claim.lease.leaseId,
          runnerId: runner.runnerId,
          generation: claim.lease.generation,
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async heartbeatLease(
    identity: ModuleRunnerIdentity,
    command: RunnerLeaseHeartbeatCommand,
  ): Promise<HeartbeatModuleExecutionLeaseResult> {
    const runner = await this.authenticate(identity);
    return this.input.executionRepository.heartbeatLease({
      accountId: runner.accountId,
      projectId: command.projectId,
      executionId: command.executionId,
      leaseId: command.leaseId,
      generation: command.generation,
      runnerId: runner.runnerId,
    });
  }

  async appendEvidence(
    identity: ModuleRunnerIdentity,
    command: RunnerAppendEvidenceCommand,
  ): Promise<ModuleExecutionEvent> {
    const runner = await this.authenticate(identity);
    return this.input.executionRepository.appendEvidence({
      accountId: runner.accountId,
      projectId: command.projectId,
      executionId: command.executionId,
      leaseId: command.leaseId,
      generation: command.generation,
      runnerId: runner.runnerId,
      eventType: command.eventType,
      evidence: command.evidence,
    });
  }

  async finalize(
    identity: ModuleRunnerIdentity,
    command: RunnerFinalizeCommand,
  ): Promise<FinalizeModuleExecutionResult> {
    const runner = await this.authenticate(identity);
    return this.input.executionRepository.finalize({
      accountId: runner.accountId,
      projectId: command.projectId,
      executionId: command.executionId,
      leaseId: command.leaseId,
      generation: command.generation,
      runnerId: runner.runnerId,
      outcome: command.outcome,
      evidenceDigest: command.evidenceDigest,
      evidence: command.evidence,
      usage: command.usage,
    });
  }
}

export function createMemoryModuleRunnerRepository(input?: {
  runners?: readonly ModuleRunnerNode[];
}): ModuleRunnerRepository {
  const runners = new Map((input?.runners ?? []).map((runner) => [runner.runnerId, clone(runner)]));
  return {
    async get(runnerId) {
      const runner = runners.get(runnerId);
      return runner ? clone(runner) : null;
    },
    async register(runner) {
      if (
        runners.has(runner.runnerId) ||
        [...runners.values()].some(
          (current) =>
            current.nodeIdentity === runner.nodeIdentity ||
            current.certificateThumbprint === runner.certificateThumbprint,
        )
      ) {
        throw new ModuleRunnerProtocolError('RUNNER_REGISTRATION_INVALID', 409);
      }
      runners.set(runner.runnerId, clone(runner));
      return clone(runner);
    },
    async heartbeat(input) {
      const runner = runners.get(input.runnerId);
      if (!runner) {
        throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
      }
      const updated: ModuleRunnerNode = {
        ...runner,
        softwareVersion: input.softwareVersion,
        attestationDigest: input.attestationDigest,
        updatedAt: input.updatedAt,
      };
      runners.set(input.runnerId, updated);
      return clone(updated);
    },
  };
}
