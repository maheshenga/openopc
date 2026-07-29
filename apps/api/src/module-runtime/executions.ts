import { randomUUID } from 'node:crypto';

import {
  MODULE_EXECUTION_INPUT_MAX_BYTES,
  type RuntimeDescriptorV1,
  type Sha256Digest,
  canonicalDigest,
  canonicalJsonBytes,
  sha256Digest,
} from '@openopc/module-runtime-contracts';

import {
  type ExecutionInputStore,
  type ModuleExecutionInput,
  type MutableExecutionInputStore,
  createMemoryExecutionInputStore,
} from './execution-inputs';

export const MODULE_EXECUTION_LEASE_DURATION_MS = 30_000;

export type ModuleExecutionState =
  | 'pending'
  | 'awaiting_confirmation'
  | 'dispatchable'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type ModuleExecutionTerminalState = Extract<
  ModuleExecutionState,
  'succeeded' | 'failed' | 'cancelled' | 'unknown'
>;

export interface ModuleExecution {
  executionId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseId: string;
  consentRevisionId: string;
  runtimeDescriptorId: string;
  runtimeKind: ModuleExecutionBinding['runtimeKind'];
  runtimeProfile: string;
  state: ModuleExecutionState;
  idempotencyKey: string;
  workEnvelopeDigest: Sha256Digest;
  killSwitchGeneration: number;
  deadlineAt: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface ModuleExecutionLease {
  leaseId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  runnerId: string;
  generation: number;
  deadlineAt: string;
  claimedAt: string;
  releasedAt: string | null;
}

export type ModuleCapabilityAudience = 'secret' | 'egress' | 'model' | 'desktop' | 'paid-call';

export interface ModuleCapabilityGrant {
  grantId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  leaseId: string;
  audience: ModuleCapabilityAudience;
  tokenHash: Sha256Digest;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface ClaimNextModuleExecutionCommand {
  accountId: string;
  runnerId: string;
}

export interface ClaimModuleExecutionResult {
  execution: ModuleExecution;
  lease: ModuleExecutionLease;
}

export interface ModuleRunnerProfileSnapshot {
  runnerId: string;
  accountId: string;
  status: 'active' | 'draining' | 'quarantined' | 'revoked';
  runtimeKind: ModuleExecutionBinding['runtimeKind'];
  profileName: string;
}

export interface AbandonModuleExecutionClaimCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
}

export interface StoreModuleCapabilityGrantsCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  runnerId: string;
  generation: number;
  grants: readonly Pick<
    ModuleCapabilityGrant,
    'grantId' | 'audience' | 'tokenHash' | 'expiresAt'
  >[];
}

export interface HeartbeatModuleExecutionLeaseCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
}

export interface HeartbeatModuleExecutionLeaseResult {
  execution: ModuleExecution;
  lease: ModuleExecutionLease;
}

export interface AppendModuleExecutionEvidenceCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
  eventType: string;
  evidence: Record<string, unknown>;
}

export interface ModuleExecutionBinding {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  releaseId: string;
  releaseDigest: Sha256Digest;
  consentRevisionId: string;
  permissionDigest: Sha256Digest;
  policyDigest: Sha256Digest;
  runtimeDescriptorId: string;
  runtimeDescriptorDigest: Sha256Digest;
  runtimeDescriptor: RuntimeDescriptorV1;
  runtimeArtifactDigest: Sha256Digest | null;
  runtimeArtifactBytes: number | null;
  runtimeKind: 'wasi-component' | 'oci-image';
  runtimeProfile: string;
  killSwitchGeneration: number;
  resourceCeilings: {
    cpuMillis: number;
    memoryMiB: number;
    wallTimeMs: number;
    costMicro: number;
  };
  confirmationRequired: boolean;
}

export interface ResolveModuleExecutionBindingInput {
  accountId: string;
  projectId: string;
  installationId: string;
  actorUserId: string;
}

export interface ModuleExecutionBindingResolver {
  resolve(input: ResolveModuleExecutionBindingInput): Promise<ModuleExecutionBinding | null>;
}

export interface CreateModuleExecutionCommand extends ResolveModuleExecutionBindingInput {
  idempotencyKey: string;
  deadlineAt: string;
  input: unknown;
}

export interface ModuleExecutionEstimate {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  releaseId: string;
  releaseDigest: Sha256Digest;
  runtimeKind: ModuleExecutionBinding['runtimeKind'];
  runtimeProfile: string;
  resourceCeilings: ModuleExecutionBinding['resourceCeilings'];
  confirmationRequired: boolean;
}

export interface CreateModuleExecutionPersistenceInput {
  execution: ModuleExecution;
  input: ModuleExecutionInput;
}

export interface ConfirmModuleExecutionCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  actorUserId: string;
}

export interface GetModuleExecutionCommand {
  accountId: string;
  projectId: string;
  executionId: string;
}

export interface TransitionModuleExecutionStateInput {
  accountId: string;
  projectId: string;
  executionId: string;
  expectedState: ModuleExecutionState;
  state: ModuleExecutionState;
  eventType: string;
  eventPayload?: Record<string, unknown>;
}

export interface ModuleExecutionEvent {
  eventId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  sequence: number;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ModuleExecutionEvidence {
  evidenceId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
  outcome: ModuleExecutionTerminalState;
  evidenceDigest: Sha256Digest;
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface ModuleExecutionOutboxEntry {
  outboxId: string;
  executionId: string;
  accountId: string;
  projectId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}

export interface FinalizeModuleExecutionCommand {
  accountId: string;
  projectId: string;
  executionId: string;
  leaseId: string;
  generation: number;
  runnerId: string;
  outcome: ModuleExecutionTerminalState;
  evidenceDigest: Sha256Digest;
  evidence: Record<string, unknown>;
  usage: Record<string, unknown>;
}

export interface FinalizeModuleExecutionResult {
  execution: ModuleExecution;
  evidence: ModuleExecutionEvidence;
  outbox: ModuleExecutionOutboxEntry;
}

export interface CancelModuleExecutionCommand {
  accountId: string;
  projectId: string;
  executionId: string;
}

export type ModuleExecutionErrorCode =
  | 'MODULE_EXECUTION_INPUT_INVALID'
  | 'MODULE_EXECUTION_BINDING_UNAVAILABLE'
  | 'MODULE_EXECUTION_BINDING_STALE'
  | 'MODULE_EXECUTION_NOT_FOUND'
  | 'MODULE_EXECUTION_LEASE_STALE'
  | 'MODULE_EXECUTION_STATE_CONFLICT';

export class ModuleExecutionError extends Error {
  constructor(
    readonly code: ModuleExecutionErrorCode,
    readonly status: 400 | 404 | 409,
  ) {
    super(code);
    this.name = 'ModuleExecutionError';
  }
}

export interface ModuleExecutionRepository {
  create(input: CreateModuleExecutionPersistenceInput): Promise<ModuleExecution>;
  get(accountId: string, projectId: string, executionId: string): Promise<ModuleExecution | null>;
  expire(input: GetModuleExecutionCommand & { now: string }): Promise<ModuleExecution | null>;
  transitionState(input: TransitionModuleExecutionStateInput): Promise<ModuleExecution>;
  listEvents(
    accountId: string,
    projectId: string,
    executionId: string,
  ): Promise<readonly ModuleExecutionEvent[]>;
  claimNext(
    command: ClaimNextModuleExecutionCommand,
  ): Promise<ClaimModuleExecutionResult | null>;
  abandonClaim(command: AbandonModuleExecutionClaimCommand): Promise<ModuleExecution>;
  storeCapabilityGrants(
    command: StoreModuleCapabilityGrantsCommand,
  ): Promise<readonly ModuleCapabilityGrant[]>;
  heartbeatLease(
    command: HeartbeatModuleExecutionLeaseCommand,
  ): Promise<HeartbeatModuleExecutionLeaseResult>;
  appendEvidence(command: AppendModuleExecutionEvidenceCommand): Promise<ModuleExecutionEvent>;
  cancel(command: CancelModuleExecutionCommand): Promise<ModuleExecution>;
  finalize(command: FinalizeModuleExecutionCommand): Promise<FinalizeModuleExecutionResult>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function computeModuleExecutionBindingDigest(
  binding: ModuleExecutionBinding,
  deadlineAt: string,
  inputDigest: Sha256Digest,
): Promise<Sha256Digest> {
  return canonicalDigest({
    accountId: binding.accountId,
    projectId: binding.projectId,
    installationId: binding.installationId,
    installRevision: binding.installRevision,
    releaseId: binding.releaseId,
    releaseDigest: binding.releaseDigest,
    consentRevisionId: binding.consentRevisionId,
    permissionDigest: binding.permissionDigest,
    policyDigest: binding.policyDigest,
    runtimeDescriptorId: binding.runtimeDescriptorId,
    runtimeDescriptorDigest: binding.runtimeDescriptorDigest,
    runtimeKind: binding.runtimeKind,
    runtimeProfile: binding.runtimeProfile,
    runtimeArtifactDigest: binding.runtimeArtifactDigest,
    runtimeArtifactBytes: binding.runtimeArtifactBytes,
    killSwitchGeneration: binding.killSwitchGeneration,
    resourceCeilings: binding.resourceCeilings,
    deadlineAt: new Date(deadlineAt).toISOString(),
    inputDigest,
  });
}

export class ModuleExecutionService {
  constructor(
    private readonly input: {
      repository: ModuleExecutionRepository;
      executionInputStore?: ExecutionInputStore;
      bindingResolver?: ModuleExecutionBindingResolver;
      now?: () => Date;
      createId?: () => string;
    },
  ) {}

  async estimate(input: ResolveModuleExecutionBindingInput): Promise<ModuleExecutionEstimate> {
    const binding = await this.input.bindingResolver?.resolve(input);
    if (
      !binding ||
      binding.accountId !== input.accountId ||
      binding.projectId !== input.projectId ||
      binding.installationId !== input.installationId
    ) {
      throw new ModuleExecutionError('MODULE_EXECUTION_BINDING_UNAVAILABLE', 404);
    }
    return {
      accountId: binding.accountId,
      projectId: binding.projectId,
      installationId: binding.installationId,
      installRevision: binding.installRevision,
      releaseId: binding.releaseId,
      releaseDigest: binding.releaseDigest,
      runtimeKind: binding.runtimeKind,
      runtimeProfile: binding.runtimeProfile,
      resourceCeilings: clone(binding.resourceCeilings),
      confirmationRequired: binding.confirmationRequired,
    };
  }

  async create(command: CreateModuleExecutionCommand): Promise<ModuleExecution> {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,254}$/.test(command.idempotencyKey) ||
      !Number.isFinite(Date.parse(command.deadlineAt)) ||
      Date.parse(command.deadlineAt) <= (this.input.now ?? (() => new Date()))().valueOf()
    ) {
      throw new ModuleExecutionError('MODULE_EXECUTION_INPUT_INVALID', 400);
    }
    let payload: Uint8Array;
    try {
      payload = canonicalJsonBytes(command.input);
    } catch {
      throw new ModuleExecutionError('MODULE_EXECUTION_INPUT_INVALID', 400);
    }
    if (payload.byteLength > MODULE_EXECUTION_INPUT_MAX_BYTES) {
      throw new ModuleExecutionError('MODULE_EXECUTION_INPUT_INVALID', 400);
    }
    const inputDigest = await sha256Digest(payload);
    const binding = await this.input.bindingResolver?.resolve(command);
    if (
      !binding ||
      binding.accountId !== command.accountId ||
      binding.projectId !== command.projectId ||
      binding.installationId !== command.installationId
    ) {
      throw new ModuleExecutionError('MODULE_EXECUTION_BINDING_UNAVAILABLE', 404);
    }

    const createdAt = (this.input.now ?? (() => new Date()))().toISOString();
    const workEnvelopeDigest = await computeModuleExecutionBindingDigest(
      binding,
      command.deadlineAt,
      inputDigest,
    );
    const executionId = (this.input.createId ?? randomUUID)();
    return this.input.repository.create({
      execution: {
        executionId,
        accountId: command.accountId,
        projectId: command.projectId,
        installationId: command.installationId,
        releaseId: binding.releaseId,
        consentRevisionId: binding.consentRevisionId,
        runtimeDescriptorId: binding.runtimeDescriptorId,
        runtimeKind: binding.runtimeKind,
        runtimeProfile: binding.runtimeProfile,
        state: binding.confirmationRequired ? 'awaiting_confirmation' : 'dispatchable',
        idempotencyKey: command.idempotencyKey,
        workEnvelopeDigest,
        killSwitchGeneration: binding.killSwitchGeneration,
        deadlineAt: command.deadlineAt,
        createdAt,
        updatedAt: createdAt,
        terminalAt: null,
      },
      input: {
        executionId,
        accountId: command.accountId,
        projectId: command.projectId,
        payload,
        digest: inputDigest,
        createdAt,
      },
    });
  }

  async confirm(command: ConfirmModuleExecutionCommand): Promise<ModuleExecution> {
    const execution = await this.input.repository.get(
      command.accountId,
      command.projectId,
      command.executionId,
    );
    if (!execution) throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
    if (execution.state !== 'awaiting_confirmation') {
      throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
    }
    const executionInput = await this.input.executionInputStore?.get(
      command.accountId,
      command.projectId,
      command.executionId,
    );
    if (!executionInput) {
      throw new ModuleExecutionError('MODULE_EXECUTION_BINDING_STALE', 409);
    }
    const binding = await this.input.bindingResolver?.resolve({
      accountId: command.accountId,
      projectId: command.projectId,
      installationId: execution.installationId,
      actorUserId: command.actorUserId,
    });
    if (
      !binding ||
      binding.accountId !== execution.accountId ||
      binding.projectId !== execution.projectId ||
      binding.installationId !== execution.installationId ||
      binding.releaseId !== execution.releaseId ||
      binding.consentRevisionId !== execution.consentRevisionId ||
      binding.runtimeDescriptorId !== execution.runtimeDescriptorId ||
      binding.killSwitchGeneration !== execution.killSwitchGeneration ||
      (await computeModuleExecutionBindingDigest(
        binding,
        execution.deadlineAt,
        executionInput.digest,
      )) !== execution.workEnvelopeDigest
    ) {
      throw new ModuleExecutionError('MODULE_EXECUTION_BINDING_STALE', 409);
    }
    return this.input.repository.transitionState({
      accountId: command.accountId,
      projectId: command.projectId,
      executionId: command.executionId,
      expectedState: 'awaiting_confirmation',
      state: 'dispatchable',
      eventType: 'execution_confirmed',
    });
  }

  async get(command: GetModuleExecutionCommand): Promise<ModuleExecution> {
    const execution = await this.input.repository.expire({
      ...command,
      now: (this.input.now ?? (() => new Date()))().toISOString(),
    });
    if (!execution) throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
    return execution;
  }

  async events(command: GetModuleExecutionCommand): Promise<readonly ModuleExecutionEvent[]> {
    await this.get(command);
    return this.input.repository.listEvents(
      command.accountId,
      command.projectId,
      command.executionId,
    );
  }

  cancel(command: CancelModuleExecutionCommand): Promise<ModuleExecution> {
    return this.input.repository.cancel(command);
  }

  finalize(command: FinalizeModuleExecutionCommand): Promise<FinalizeModuleExecutionResult> {
    return this.input.repository.finalize(command);
  }
}

export function createMemoryModuleExecutionRepository(input?: {
  executions?: readonly ModuleExecution[];
  leases?: readonly ModuleExecutionLease[];
  events?: readonly ModuleExecutionEvent[];
  now?: () => Date;
  createId?: () => string;
  executionInputStore?: MutableExecutionInputStore;
  runnerProfiles?: readonly ModuleRunnerProfileSnapshot[];
}): ModuleExecutionRepository {
  const executions = new Map(
    (input?.executions ?? []).map((execution) => [execution.executionId, clone(execution)]),
  );
  const leases = new Map((input?.leases ?? []).map((lease) => [lease.leaseId, clone(lease)]));
  const evidence = new Map<string, ModuleExecutionEvidence>();
  const outbox = new Map<string, ModuleExecutionOutboxEntry>();
  const executionEvents = new Map<string, ModuleExecutionEvent[]>();
  const capabilityGrants = new Map<string, ModuleCapabilityGrant>();
  const idempotency = new Map<string, string>();
  const now = input?.now ?? (() => new Date());
  const createId = input?.createId ?? randomUUID;
  const executionInputStore = input?.executionInputStore ?? createMemoryExecutionInputStore();
  const runnerProfiles = input?.runnerProfiles?.map(clone) ?? null;
  const idempotencyCoordinate = (projectId: string, idempotencyKey: string) =>
    `${projectId}\0${idempotencyKey}`;
  for (const execution of executions.values()) {
    idempotency.set(
      idempotencyCoordinate(execution.projectId, execution.idempotencyKey),
      execution.executionId,
    );
  }
  for (const event of input?.events ?? []) {
    const history = executionEvents.get(event.executionId) ?? [];
    history.push(clone(event));
    executionEvents.set(event.executionId, history);
  }
  const appendEvent = (
    execution: ModuleExecution,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): ModuleExecutionEvent => {
    const history = executionEvents.get(execution.executionId) ?? [];
    const event: ModuleExecutionEvent = {
      eventId: createId(),
      executionId: execution.executionId,
      accountId: execution.accountId,
      projectId: execution.projectId,
      sequence: history.length + 1,
      eventType,
      payload: clone(payload),
      createdAt,
    };
    history.push(event);
    executionEvents.set(execution.executionId, history);
    return clone(event);
  };

  return {
    async create({ execution, input: executionInput }) {
      const coordinate = idempotencyCoordinate(execution.projectId, execution.idempotencyKey);
      const priorId = idempotency.get(coordinate);
      if (priorId) {
        const prior = executions.get(priorId);
        if (
          !prior ||
          prior.accountId !== execution.accountId ||
          prior.installationId !== execution.installationId ||
          prior.releaseId !== execution.releaseId ||
          prior.consentRevisionId !== execution.consentRevisionId ||
          prior.runtimeDescriptorId !== execution.runtimeDescriptorId ||
          prior.runtimeKind !== execution.runtimeKind ||
          prior.runtimeProfile !== execution.runtimeProfile ||
          prior.workEnvelopeDigest !== execution.workEnvelopeDigest ||
          prior.deadlineAt !== execution.deadlineAt ||
          (
            await executionInputStore.get(
              execution.accountId,
              execution.projectId,
              prior.executionId,
            )
          )?.digest !== executionInput.digest
        ) {
          throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        }
        return clone(prior);
      }
      await executionInputStore.store(executionInput);
      executions.set(execution.executionId, clone(execution));
      idempotency.set(coordinate, execution.executionId);
      appendEvent(execution, 'execution_created', { state: execution.state }, execution.createdAt);
      return clone(execution);
    },

    async get(accountId, projectId, executionId) {
      const execution = executions.get(executionId);
      return execution?.accountId === accountId && execution.projectId === projectId
        ? clone(execution)
        : null;
    },

    async expire(input) {
      const execution = executions.get(input.executionId);
      if (
        !execution ||
        execution.accountId !== input.accountId ||
        execution.projectId !== input.projectId
      ) {
        return null;
      }
      if (
        execution.terminalAt !== null ||
        Date.parse(execution.deadlineAt) > Date.parse(input.now)
      ) {
        return clone(execution);
      }
      const expired: ModuleExecution = {
        ...execution,
        state: 'failed',
        updatedAt: input.now,
        terminalAt: input.now,
      };
      executions.set(input.executionId, expired);
      for (const [leaseId, lease] of leases) {
        if (lease.executionId === input.executionId && lease.releasedAt === null) {
          leases.set(leaseId, { ...lease, releasedAt: input.now });
        }
      }
      appendEvent(expired, 'execution_timed_out', { state: 'failed' }, input.now);
      return clone(expired);
    },

    async transitionState(input) {
      const execution = executions.get(input.executionId);
      if (
        !execution ||
        execution.accountId !== input.accountId ||
        execution.projectId !== input.projectId
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
      }
      if (execution.state !== input.expectedState) {
        throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
      }
      const updatedAt = now().toISOString();
      const updated: ModuleExecution = { ...execution, state: input.state, updatedAt };
      executions.set(input.executionId, updated);
      appendEvent(
        updated,
        input.eventType,
        input.eventPayload ?? { state: input.state },
        updatedAt,
      );
      return clone(updated);
    },

    async listEvents(accountId, projectId, executionId) {
      const execution = executions.get(executionId);
      if (!execution || execution.accountId !== accountId || execution.projectId !== projectId) {
        return [];
      }
      return (executionEvents.get(executionId) ?? [])
        .slice()
        .sort((left, right) => left.sequence - right.sequence)
        .map(clone);
    },

    async claimNext(command) {
      const observedAt = now();
      const compatibleProfiles = runnerProfiles?.filter(
        (profile) =>
          profile.runnerId === command.runnerId &&
          profile.accountId === command.accountId &&
          profile.status === 'active',
      );
      if (compatibleProfiles && compatibleProfiles.length === 0) return null;
      const execution = [...executions.values()]
        .filter(
          (candidate) =>
            candidate.accountId === command.accountId &&
            candidate.state === 'dispatchable' &&
            Date.parse(candidate.deadlineAt) > observedAt.valueOf() &&
            ![...leases.values()].some(
              (lease) => lease.executionId === candidate.executionId && lease.releasedAt === null,
            ) &&
            (!compatibleProfiles ||
              compatibleProfiles.some(
                (profile) =>
                  profile.runtimeKind === candidate.runtimeKind &&
                  profile.profileName === candidate.runtimeProfile,
              )),
        )
        .sort(
          (left, right) =>
            left.createdAt.localeCompare(right.createdAt) ||
            left.executionId.localeCompare(right.executionId),
        )[0];
      if (!execution) return null;
      const generation =
        Math.max(
          0,
          ...[...leases.values()]
            .filter((lease) => lease.executionId === execution.executionId)
            .map((lease) => lease.generation),
        ) + 1;
      const claimedAt = observedAt.toISOString();
      const deadlineAt = new Date(
        Math.min(
          observedAt.valueOf() + MODULE_EXECUTION_LEASE_DURATION_MS,
          Date.parse(execution.deadlineAt),
        ),
      ).toISOString();
      const lease: ModuleExecutionLease = {
        leaseId: createId(),
        executionId: execution.executionId,
        accountId: execution.accountId,
        projectId: execution.projectId,
        runnerId: command.runnerId,
        generation,
        deadlineAt,
        claimedAt,
        releasedAt: null,
      };
      const claimedExecution: ModuleExecution = {
        ...execution,
        state: 'leased',
        updatedAt: claimedAt,
      };
      leases.set(lease.leaseId, lease);
      executions.set(execution.executionId, claimedExecution);
      appendEvent(
        claimedExecution,
        'execution_claimed',
        { lease_id: lease.leaseId, generation },
        claimedAt,
      );
      return { execution: clone(claimedExecution), lease: clone(lease) };
    },

    async abandonClaim(command) {
      const currentLease = leases.get(command.leaseId);
      const currentExecution = executions.get(command.executionId);
      if (
        !currentLease ||
        !currentExecution ||
        currentLease.executionId !== command.executionId ||
        currentLease.accountId !== command.accountId ||
        currentLease.projectId !== command.projectId ||
        currentLease.runnerId !== command.runnerId ||
        currentLease.generation !== command.generation ||
        currentLease.releasedAt !== null ||
        currentExecution.accountId !== command.accountId ||
        currentExecution.projectId !== command.projectId ||
        currentExecution.state !== 'leased'
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      const abandonedAt = now().toISOString();
      const dispatchable: ModuleExecution = {
        ...currentExecution,
        state: 'dispatchable',
        updatedAt: abandonedAt,
      };
      leases.set(command.leaseId, { ...currentLease, releasedAt: abandonedAt });
      executions.set(command.executionId, dispatchable);
      for (const [grantId, item] of capabilityGrants) {
        if (item.leaseId === command.leaseId && item.revokedAt === null) {
          capabilityGrants.set(grantId, { ...item, revokedAt: abandonedAt });
        }
      }
      appendEvent(
        dispatchable,
        'execution_claim_abandoned',
        { lease_id: command.leaseId, generation: command.generation },
        abandonedAt,
      );
      return clone(dispatchable);
    },

    async storeCapabilityGrants(command) {
      const lease = leases.get(command.leaseId);
      if (
        !lease ||
        lease.executionId !== command.executionId ||
        lease.accountId !== command.accountId ||
        lease.projectId !== command.projectId ||
        lease.runnerId !== command.runnerId ||
        lease.generation !== command.generation ||
        lease.releasedAt !== null
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      const createdAt = now().toISOString();
      const stored: ModuleCapabilityGrant[] = [];
      for (const inputGrant of command.grants) {
        if (
          capabilityGrants.has(inputGrant.grantId) ||
          [...capabilityGrants.values()].some(
            (grant) => grant.tokenHash === inputGrant.tokenHash,
          ) ||
          Date.parse(inputGrant.expiresAt) > Date.parse(lease.deadlineAt)
        ) {
          throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        }
        const grant: ModuleCapabilityGrant = {
          ...inputGrant,
          executionId: command.executionId,
          accountId: command.accountId,
          projectId: command.projectId,
          leaseId: command.leaseId,
          revokedAt: null,
          createdAt,
        };
        stored.push(grant);
      }
      for (const grant of stored) capabilityGrants.set(grant.grantId, clone(grant));
      return stored.map(clone);
    },

    async heartbeatLease(command) {
      const lease = leases.get(command.leaseId);
      const execution = executions.get(command.executionId);
      if (!lease || !execution) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      const observedAt = now();
      const observedAtMs = observedAt.valueOf();
      const executionDeadlineMs = Date.parse(execution.deadlineAt);
      if (
        lease.executionId !== command.executionId ||
        lease.accountId !== command.accountId ||
        lease.projectId !== command.projectId ||
        lease.runnerId !== command.runnerId ||
        lease.generation !== command.generation ||
        lease.releasedAt !== null ||
        Date.parse(lease.deadlineAt) <= observedAtMs ||
        execution.accountId !== command.accountId ||
        execution.projectId !== command.projectId ||
        (execution.state !== 'leased' && execution.state !== 'running') ||
        executionDeadlineMs <= observedAtMs
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      const heartbeatAt = observedAt.toISOString();
      const deadlineAt = new Date(
        Math.min(observedAtMs + MODULE_EXECUTION_LEASE_DURATION_MS, executionDeadlineMs),
      ).toISOString();
      const heartbeatLease: ModuleExecutionLease = {
        ...lease,
        deadlineAt,
      };
      const running: ModuleExecution = {
        ...execution,
        state: 'running',
        updatedAt: heartbeatAt,
      };
      leases.set(command.leaseId, heartbeatLease);
      executions.set(command.executionId, running);
      if (execution.state === 'leased') {
        appendEvent(running, 'execution_running', { generation: lease.generation }, heartbeatAt);
      }
      return { execution: clone(running), lease: clone(heartbeatLease) };
    },

    async appendEvidence(command) {
      const lease = leases.get(command.leaseId);
      const execution = executions.get(command.executionId);
      let payloadBytes = Number.POSITIVE_INFINITY;
      try {
        payloadBytes = new TextEncoder().encode(JSON.stringify(command.evidence)).byteLength;
      } catch {
        payloadBytes = Number.POSITIVE_INFINITY;
      }
      if (
        !lease ||
        !execution ||
        lease.executionId !== command.executionId ||
        lease.accountId !== command.accountId ||
        lease.projectId !== command.projectId ||
        lease.runnerId !== command.runnerId ||
        lease.generation !== command.generation ||
        lease.releasedAt !== null ||
        Date.parse(lease.deadlineAt) <= now().valueOf() ||
        execution.accountId !== command.accountId ||
        execution.projectId !== command.projectId ||
        (execution.state !== 'leased' && execution.state !== 'running') ||
        !/^[a-z][a-z0-9_]{0,63}$/.test(command.eventType) ||
        payloadBytes > 262_144
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      return appendEvent(execution, command.eventType, command.evidence, now().toISOString());
    },

    async cancel(command) {
      const execution = executions.get(command.executionId);
      if (
        !execution ||
        execution.accountId !== command.accountId ||
        execution.projectId !== command.projectId
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
      }
      if (execution.state === 'cancelled') return clone(execution);
      if (
        execution.state === 'succeeded' ||
        execution.state === 'failed' ||
        execution.state === 'unknown'
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
      }

      const terminalAt = now().toISOString();
      const cancelled: ModuleExecution = {
        ...execution,
        state: 'cancelled',
        updatedAt: terminalAt,
        terminalAt,
      };
      executions.set(command.executionId, cancelled);
      for (const [leaseId, lease] of leases) {
        if (lease.executionId === command.executionId && lease.releasedAt === null) {
          leases.set(leaseId, { ...lease, releasedAt: terminalAt });
        }
      }
      appendEvent(cancelled, 'execution_cancelled', { state: 'cancelled' }, terminalAt);
      return clone(cancelled);
    },

    async finalize(command) {
      const execution = executions.get(command.executionId);
      if (
        !execution ||
        execution.accountId !== command.accountId ||
        execution.projectId !== command.projectId
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
      }
      const lease = leases.get(command.leaseId);
      if (
        !lease ||
        lease.executionId !== command.executionId ||
        lease.accountId !== command.accountId ||
        lease.projectId !== command.projectId ||
        lease.runnerId !== command.runnerId ||
        lease.generation !== command.generation ||
        lease.releasedAt !== null ||
        Date.parse(lease.deadlineAt) <= now().valueOf()
      ) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      if (execution.state !== 'leased' && execution.state !== 'running') {
        throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
      }

      const terminalAt = now().toISOString();
      const finalizedExecution: ModuleExecution = {
        ...execution,
        state: command.outcome,
        updatedAt: terminalAt,
        terminalAt,
      };
      const acceptedEvidence: ModuleExecutionEvidence = {
        evidenceId: createId(),
        executionId: command.executionId,
        accountId: command.accountId,
        projectId: command.projectId,
        leaseId: command.leaseId,
        generation: command.generation,
        runnerId: command.runnerId,
        outcome: command.outcome,
        evidenceDigest: command.evidenceDigest,
        evidence: clone(command.evidence),
        createdAt: terminalAt,
      };
      const usageIntent: ModuleExecutionOutboxEntry = {
        outboxId: createId(),
        executionId: command.executionId,
        accountId: command.accountId,
        projectId: command.projectId,
        idempotencyKey: `execution:${command.executionId}:terminal`,
        payload: clone(command.usage),
        status: 'pending',
        createdAt: terminalAt,
        updatedAt: terminalAt,
      };

      executions.set(command.executionId, finalizedExecution);
      leases.set(command.leaseId, { ...lease, releasedAt: terminalAt });
      evidence.set(command.executionId, acceptedEvidence);
      outbox.set(command.executionId, usageIntent);
      appendEvent(
        finalizedExecution,
        'execution_finalized',
        { state: command.outcome },
        terminalAt,
      );

      return {
        execution: clone(finalizedExecution),
        evidence: clone(acceptedEvidence),
        outbox: clone(usageIntent),
      };
    },
  };
}
