import {
  type Database,
  developerModuleReleases,
  moduleCapabilityGrants,
  moduleExecutionEvents,
  moduleExecutionEvidence,
  moduleExecutionInputs,
  moduleExecutionLeases,
  moduleExecutionOutbox,
  moduleExecutions,
  moduleKillSwitchGenerations,
  moduleRunnerProfiles,
  moduleRunners,
  moduleRuntimeArtifacts,
  moduleRuntimeDescriptors,
  projectModuleConsentRevisions,
  projectModuleInstallations,
} from '@kortix/db';
import {
  type Sha256Digest,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
  parseRuntimeDescriptor,
} from '@openopc/module-runtime-contracts';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, max, or, sql } from 'drizzle-orm';

import type { ExecutionInputStore, ModuleExecutionInput } from './execution-inputs';
import {
  type AppendModuleExecutionEvidenceCommand,
  type ClaimNextModuleExecutionCommand,
  type FinalizeModuleExecutionCommand,
  type ModuleCapabilityGrant,
  type ModuleExecution,
  ModuleExecutionError,
  type ModuleExecutionEvent,
  type ModuleExecutionEvidence,
  type ModuleExecutionLease,
  type ModuleExecutionOutboxEntry,
  type ModuleExecutionRepository,
  type StoreModuleCapabilityGrantsCommand,
} from './executions';
import type {
  ModuleRunnerNode,
  ModuleRunnerRepository,
  RunnerClaimBindingResolver,
} from './runner-protocol';

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type ExecutionRow = typeof moduleExecutions.$inferSelect;
type ExecutionInputRow = typeof moduleExecutionInputs.$inferSelect;
type LeaseRow = typeof moduleExecutionLeases.$inferSelect;
type EventRow = typeof moduleExecutionEvents.$inferSelect;
type EvidenceRow = typeof moduleExecutionEvidence.$inferSelect;
type OutboxRow = typeof moduleExecutionOutbox.$inferSelect;
type GrantRow = typeof moduleCapabilityGrants.$inferSelect;
type RunnerRow = typeof moduleRunners.$inferSelect;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function execution(row: ExecutionRow): ModuleExecution {
  return {
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    installationId: row.installationId,
    releaseId: row.releaseId,
    consentRevisionId: row.consentRevisionId,
    runtimeDescriptorId: row.runtimeDescriptorId,
    runtimeKind: row.runtimeKind,
    runtimeProfile: row.runtimeProfile,
    state: row.state,
    idempotencyKey: row.idempotencyKey,
    workEnvelopeDigest: row.workEnvelopeDigest as Sha256Digest,
    killSwitchGeneration: row.killSwitchGeneration,
    deadlineAt: row.deadlineAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    terminalAt: row.terminalAt,
  };
}

function executionInput(row: ExecutionInputRow): ModuleExecutionInput {
  return {
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    payload: new Uint8Array(row.inputPayload),
    digest: row.inputDigest as Sha256Digest,
    createdAt: row.createdAt,
  };
}

function lease(row: LeaseRow): ModuleExecutionLease {
  return {
    leaseId: row.leaseId,
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    runnerId: row.runnerId,
    generation: row.generation,
    deadlineAt: row.deadlineAt,
    claimedAt: row.claimedAt,
    releasedAt: row.releasedAt,
  };
}

function event(row: EventRow): ModuleExecutionEvent {
  return {
    eventId: row.eventId,
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    sequence: row.sequence,
    eventType: row.eventType,
    payload: row.payload,
    createdAt: row.createdAt,
  };
}

function evidence(row: EvidenceRow): ModuleExecutionEvidence {
  return {
    evidenceId: row.evidenceId,
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    leaseId: row.leaseId,
    generation: row.generation,
    runnerId: row.runnerId,
    outcome: row.outcome as ModuleExecutionEvidence['outcome'],
    evidenceDigest: row.evidenceDigest as Sha256Digest,
    evidence: row.evidence,
    createdAt: row.createdAt,
  };
}

function outbox(row: OutboxRow): ModuleExecutionOutboxEntry {
  return {
    outboxId: row.outboxId,
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    idempotencyKey: row.idempotencyKey,
    payload: row.payload,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function grant(row: GrantRow): ModuleCapabilityGrant {
  return {
    grantId: row.grantId,
    executionId: row.executionId,
    accountId: row.accountId,
    projectId: row.projectId,
    leaseId: row.leaseId,
    audience: row.audience,
    tokenHash: row.tokenHash as Sha256Digest,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

function runner(row: RunnerRow, profiles: ModuleRunnerNode['profiles']): ModuleRunnerNode {
  return {
    runnerId: row.runnerId,
    accountId: row.accountId,
    nodeIdentity: row.nodeIdentity,
    status: row.status,
    softwareVersion: row.softwareVersion,
    attestationDigest: row.attestationDigest as Sha256Digest,
    certificateThumbprint: row.certificateThumbprint,
    profiles,
    updatedAt: row.updatedAt,
  };
}

function conflict(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('lease')) {
    throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
  }
  throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
}

async function appendEvent(
  tx: Transaction,
  input: {
    executionId: string;
    accountId: string;
    projectId: string;
    eventType: string;
    payload?: Record<string, unknown>;
    createdAt?: string;
  },
): Promise<ModuleExecutionEvent> {
  await tx.execute(sql`
    SELECT execution_id
    FROM kortix.module_executions
    WHERE execution_id = ${input.executionId}
      AND account_id = ${input.accountId}
      AND project_id = ${input.projectId}
    FOR UPDATE
  `);
  const [last] = await tx
    .select({ sequence: max(moduleExecutionEvents.sequence) })
    .from(moduleExecutionEvents)
    .where(eq(moduleExecutionEvents.executionId, input.executionId));
  const [created] = await tx
    .insert(moduleExecutionEvents)
    .values({
      executionId: input.executionId,
      accountId: input.accountId,
      projectId: input.projectId,
      sequence: Number(last?.sequence ?? 0) + 1,
      eventType: input.eventType,
      payload: input.payload ?? {},
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();
  if (!created) throw new Error('Module execution event insert returned no row');
  return event(created);
}

async function getExecution(
  source: Database | Transaction,
  accountId: string,
  projectId: string,
  executionId: string,
): Promise<ExecutionRow | null> {
  const [row] = await source
    .select()
    .from(moduleExecutions)
    .where(
      and(
        eq(moduleExecutions.accountId, accountId),
        eq(moduleExecutions.projectId, projectId),
        eq(moduleExecutions.executionId, executionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function getExecutionInput(
  source: Database | Transaction,
  accountId: string,
  projectId: string,
  executionId: string,
): Promise<ExecutionInputRow | null> {
  const [row] = await source
    .select()
    .from(moduleExecutionInputs)
    .where(
      and(
        eq(moduleExecutionInputs.accountId, accountId),
        eq(moduleExecutionInputs.projectId, projectId),
        eq(moduleExecutionInputs.executionId, executionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export function createDrizzleModuleExecutionInputStore(db: Database): ExecutionInputStore {
  return {
    async get(accountId, projectId, executionId) {
      const row = await getExecutionInput(db, accountId, projectId, executionId);
      return row ? executionInput(row) : null;
    },
  };
}

export function createDrizzleModuleExecutionRepository(db: Database): ModuleExecutionRepository {
  return {
    async create(input) {
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(moduleExecutions)
          .values({
            executionId: input.execution.executionId,
            accountId: input.execution.accountId,
            projectId: input.execution.projectId,
            installationId: input.execution.installationId,
            releaseId: input.execution.releaseId,
            consentRevisionId: input.execution.consentRevisionId,
            runtimeDescriptorId: input.execution.runtimeDescriptorId,
            runtimeKind: input.execution.runtimeKind,
            runtimeProfile: input.execution.runtimeProfile,
            state: input.execution.state,
            idempotencyKey: input.execution.idempotencyKey,
            workEnvelopeDigest: input.execution.workEnvelopeDigest,
            killSwitchGeneration: input.execution.killSwitchGeneration,
            deadlineAt: input.execution.deadlineAt,
            createdAt: input.execution.createdAt,
            updatedAt: input.execution.updatedAt,
          })
          .onConflictDoNothing({
            target: [moduleExecutions.projectId, moduleExecutions.idempotencyKey],
          })
          .returning();
        if (!created) {
          const [prior] = await tx
            .select()
            .from(moduleExecutions)
            .where(
              and(
                eq(moduleExecutions.projectId, input.execution.projectId),
                eq(moduleExecutions.idempotencyKey, input.execution.idempotencyKey),
              ),
            )
            .limit(1);
          const priorInput = prior
            ? await getExecutionInput(tx, prior.accountId, prior.projectId, prior.executionId)
            : null;
          if (
            prior &&
            priorInput &&
            prior.accountId === input.execution.accountId &&
            prior.installationId === input.execution.installationId &&
            prior.releaseId === input.execution.releaseId &&
            prior.consentRevisionId === input.execution.consentRevisionId &&
            prior.runtimeDescriptorId === input.execution.runtimeDescriptorId &&
            prior.runtimeKind === input.execution.runtimeKind &&
            prior.runtimeProfile === input.execution.runtimeProfile &&
            prior.workEnvelopeDigest === input.execution.workEnvelopeDigest &&
            prior.deadlineAt === input.execution.deadlineAt &&
            priorInput.inputDigest === input.input.digest
          ) {
            return execution(prior);
          }
          throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        }
        await tx.insert(moduleExecutionInputs).values({
          executionId: input.input.executionId,
          accountId: input.input.accountId,
          projectId: input.input.projectId,
          inputPayload: input.input.payload,
          inputDigest: input.input.digest,
          createdAt: input.input.createdAt,
        });
        await appendEvent(tx, {
          executionId: created.executionId,
          accountId: created.accountId,
          projectId: created.projectId,
          eventType: 'execution_created',
          payload: { state: created.state },
          createdAt: created.createdAt,
        });
        return execution(created);
      });
    },

    async get(accountId, projectId, executionId) {
      const row = await getExecution(db, accountId, projectId, executionId);
      return row ? execution(row) : null;
    },

    async expire(input) {
      return db.transaction(async (tx) => {
        const [expired] = await tx
          .update(moduleExecutions)
          .set({ state: 'failed', terminalAt: input.now, updatedAt: input.now })
          .where(
            and(
              eq(moduleExecutions.accountId, input.accountId),
              eq(moduleExecutions.projectId, input.projectId),
              eq(moduleExecutions.executionId, input.executionId),
              inArray(moduleExecutions.state, [
                'pending',
                'awaiting_confirmation',
                'dispatchable',
                'leased',
                'running',
              ]),
              lte(moduleExecutions.deadlineAt, input.now),
            ),
          )
          .returning();
        if (expired) {
          await tx
            .update(moduleExecutionLeases)
            .set({ releasedAt: input.now })
            .where(
              and(
                eq(moduleExecutionLeases.executionId, input.executionId),
                isNull(moduleExecutionLeases.releasedAt),
              ),
            );
          await tx
            .update(moduleCapabilityGrants)
            .set({ revokedAt: input.now })
            .where(
              and(
                eq(moduleCapabilityGrants.executionId, input.executionId),
                isNull(moduleCapabilityGrants.revokedAt),
              ),
            );
          await appendEvent(tx, {
            executionId: input.executionId,
            accountId: input.accountId,
            projectId: input.projectId,
            eventType: 'execution_timed_out',
            payload: { state: 'failed' },
            createdAt: input.now,
          });
          return execution(expired);
        }
        const current = await getExecution(tx, input.accountId, input.projectId, input.executionId);
        return current ? execution(current) : null;
      });
    },

    async transitionState(input) {
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(moduleExecutions)
          .set({ state: input.state, updatedAt: sql`now()` })
          .where(
            and(
              eq(moduleExecutions.accountId, input.accountId),
              eq(moduleExecutions.projectId, input.projectId),
              eq(moduleExecutions.executionId, input.executionId),
              eq(moduleExecutions.state, input.expectedState),
            ),
          )
          .returning();
        if (!updated) throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        await appendEvent(tx, {
          executionId: input.executionId,
          accountId: input.accountId,
          projectId: input.projectId,
          eventType: input.eventType,
          payload: input.eventPayload ?? { state: input.state },
        });
        return execution(updated);
      });
    },

    async listEvents(accountId, projectId, executionId) {
      const rows = await db
        .select()
        .from(moduleExecutionEvents)
        .where(
          and(
            eq(moduleExecutionEvents.accountId, accountId),
            eq(moduleExecutionEvents.projectId, projectId),
            eq(moduleExecutionEvents.executionId, executionId),
          ),
        )
        .orderBy(asc(moduleExecutionEvents.sequence));
      return rows.map(event);
    },

    async claimNext(command: ClaimNextModuleExecutionCommand) {
      return db.transaction(async (tx) => {
        let claimed: Array<{ leaseId: string; executionId: string; projectId: string }>;
        try {
          claimed = (await tx.execute(sql`
            SELECT
              lease_id AS "leaseId",
              execution_id AS "executionId",
              project_id AS "projectId"
            FROM kortix.claim_next_module_execution(
              ${command.accountId}::uuid,
              ${command.runnerId}::uuid
            )
          `)) as typeof claimed;
        } catch (error) {
          conflict(error);
        }
        const selected = claimed[0];
        if (!selected) return null;
        const row = await getExecution(
          tx,
          command.accountId,
          selected.projectId,
          selected.executionId,
        );
        const [leaseRow] = await tx
          .select()
          .from(moduleExecutionLeases)
          .where(eq(moduleExecutionLeases.leaseId, selected.leaseId))
          .limit(1);
        if (!row || !leaseRow)
          throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        return { execution: execution(row), lease: lease(leaseRow) };
      });
    },

    async abandonClaim(command) {
      return db.transaction(async (tx) => {
        const abandonedAt = new Date().toISOString();
        const lockedExecution = await tx.execute<{ executionId: string }>(sql`
          SELECT execution.execution_id AS "executionId"
          FROM kortix.module_executions AS execution
          WHERE execution.execution_id = ${command.executionId}::uuid
            AND execution.account_id = ${command.accountId}::uuid
            AND execution.project_id = ${command.projectId}::uuid
            AND execution.state = 'leased'
          FOR UPDATE
        `);
        if (!lockedExecution[0]) {
          throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
        }
        const [releasedLease] = await tx
          .update(moduleExecutionLeases)
          .set({ releasedAt: abandonedAt })
          .where(
            and(
              eq(moduleExecutionLeases.leaseId, command.leaseId),
              eq(moduleExecutionLeases.executionId, command.executionId),
              eq(moduleExecutionLeases.accountId, command.accountId),
              eq(moduleExecutionLeases.projectId, command.projectId),
              eq(moduleExecutionLeases.runnerId, command.runnerId),
              eq(moduleExecutionLeases.generation, command.generation),
              isNull(moduleExecutionLeases.releasedAt),
            ),
          )
          .returning();
        const [dispatchable] = await tx
          .update(moduleExecutions)
          .set({ state: 'dispatchable', updatedAt: abandonedAt })
          .where(
            and(
              eq(moduleExecutions.executionId, command.executionId),
              eq(moduleExecutions.accountId, command.accountId),
              eq(moduleExecutions.projectId, command.projectId),
              eq(moduleExecutions.state, 'leased'),
            ),
          )
          .returning();
        if (!releasedLease || !dispatchable) {
          throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
        }
        await tx
          .update(moduleCapabilityGrants)
          .set({ revokedAt: abandonedAt })
          .where(
            and(
              eq(moduleCapabilityGrants.leaseId, command.leaseId),
              isNull(moduleCapabilityGrants.revokedAt),
            ),
          );
        await appendEvent(tx, {
          executionId: command.executionId,
          accountId: command.accountId,
          projectId: command.projectId,
          eventType: 'execution_claim_abandoned',
          payload: { lease_id: command.leaseId, generation: command.generation },
          createdAt: abandonedAt,
        });
        return execution(dispatchable);
      });
    },

    async storeCapabilityGrants(command: StoreModuleCapabilityGrantsCommand) {
      const firstGrant = command.grants[0];
      if (!firstGrant) return [];
      const expiryTimestamps = command.grants.map((item) => Date.parse(item.expiresAt));
      if (expiryTimestamps.some((timestamp) => !Number.isFinite(timestamp))) {
        throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
      }
      const latestExpiresAt = new Date(Math.max(...expiryTimestamps)).toISOString();
      return db.transaction(async (tx) => {
        const activeExecution = await tx.execute<{ executionId: string }>(sql`
          SELECT execution.execution_id AS "executionId"
          FROM kortix.module_executions AS execution
          WHERE execution.execution_id = ${command.executionId}::uuid
            AND execution.account_id = ${command.accountId}::uuid
            AND execution.project_id = ${command.projectId}::uuid
            AND execution.state IN ('leased', 'running')
          FOR UPDATE
        `);
        if (!activeExecution[0]) {
          throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
        }
        const liveLease = await tx.execute<{ leaseId: string }>(sql`
          SELECT lease_row.lease_id AS "leaseId"
          FROM kortix.module_execution_leases AS lease_row
          WHERE lease_row.lease_id = ${command.leaseId}::uuid
            AND lease_row.execution_id = ${command.executionId}::uuid
            AND lease_row.account_id = ${command.accountId}::uuid
            AND lease_row.project_id = ${command.projectId}::uuid
            AND lease_row.runner_id = ${command.runnerId}::uuid
            AND lease_row.generation = ${command.generation}::integer
            AND lease_row.released_at IS NULL
            AND lease_row.deadline_at > now()
            AND ${latestExpiresAt}::timestamptz <= lease_row.deadline_at
          FOR UPDATE
        `);
        if (!liveLease[0]) {
          throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
        }
        const rows = await tx
          .insert(moduleCapabilityGrants)
          .values(
            command.grants.map((item) => ({
              grantId: item.grantId,
              executionId: command.executionId,
              accountId: command.accountId,
              projectId: command.projectId,
              leaseId: command.leaseId,
              audience: item.audience,
              tokenHash: item.tokenHash,
              expiresAt: item.expiresAt,
            })),
          )
          .returning();
        return rows.map(grant);
      });
    },

    async heartbeatLease(command) {
      try {
        await db.execute(sql`
          SELECT * FROM kortix.heartbeat_module_execution(
            ${command.accountId}::uuid,
            ${command.projectId}::uuid,
            ${command.executionId}::uuid,
            ${command.leaseId}::uuid,
            ${command.generation}::integer,
            ${command.runnerId}::uuid
          )
        `);
      } catch (error) {
        conflict(error);
      }
      const row = await getExecution(db, command.accountId, command.projectId, command.executionId);
      const [leaseRow] = await db
        .select()
        .from(moduleExecutionLeases)
        .where(
          and(
            eq(moduleExecutionLeases.leaseId, command.leaseId),
            eq(moduleExecutionLeases.generation, command.generation),
            eq(moduleExecutionLeases.runnerId, command.runnerId),
          ),
        )
        .limit(1);
      if (!row || !leaseRow) throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      return { execution: execution(row), lease: lease(leaseRow) };
    },

    async appendEvidence(command: AppendModuleExecutionEvidenceCommand) {
      let payloadBytes = Number.POSITIVE_INFINITY;
      try {
        payloadBytes = new TextEncoder().encode(JSON.stringify(command.evidence)).byteLength;
      } catch {
        payloadBytes = Number.POSITIVE_INFINITY;
      }
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(command.eventType) || payloadBytes > 262_144) {
        throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
      }
      return db.transaction(async (tx) => {
        const live = await tx.execute<{ executionId: string }>(sql`
          SELECT execution.execution_id AS "executionId"
          FROM kortix.module_executions AS execution
          INNER JOIN kortix.module_execution_leases AS lease_row
            ON lease_row.execution_id = execution.execution_id
           AND lease_row.account_id = execution.account_id
           AND lease_row.project_id = execution.project_id
          WHERE execution.execution_id = ${command.executionId}::uuid
            AND execution.account_id = ${command.accountId}::uuid
            AND execution.project_id = ${command.projectId}::uuid
            AND execution.state IN ('leased', 'running')
            AND lease_row.lease_id = ${command.leaseId}::uuid
            AND lease_row.execution_id = ${command.executionId}::uuid
            AND lease_row.account_id = ${command.accountId}::uuid
            AND lease_row.project_id = ${command.projectId}::uuid
            AND lease_row.runner_id = ${command.runnerId}::uuid
            AND lease_row.generation = ${command.generation}::integer
            AND lease_row.released_at IS NULL
            AND lease_row.deadline_at > now()
          FOR UPDATE OF execution
        `);
        if (!live[0]) throw new ModuleExecutionError('MODULE_EXECUTION_LEASE_STALE', 409);
        return appendEvent(tx, {
          executionId: command.executionId,
          accountId: command.accountId,
          projectId: command.projectId,
          eventType: command.eventType,
          payload: command.evidence,
        });
      });
    },

    async cancel(command) {
      return db.transaction(async (tx) => {
        const cancelledAt = new Date().toISOString();
        const [cancelled] = await tx
          .update(moduleExecutions)
          .set({ state: 'cancelled', terminalAt: cancelledAt, updatedAt: cancelledAt })
          .where(
            and(
              eq(moduleExecutions.accountId, command.accountId),
              eq(moduleExecutions.projectId, command.projectId),
              eq(moduleExecutions.executionId, command.executionId),
              inArray(moduleExecutions.state, [
                'pending',
                'awaiting_confirmation',
                'dispatchable',
                'leased',
                'running',
              ]),
            ),
          )
          .returning();
        if (!cancelled) {
          const current = await getExecution(
            tx,
            command.accountId,
            command.projectId,
            command.executionId,
          );
          if (current?.state === 'cancelled') return execution(current);
          throw new ModuleExecutionError(
            current ? 'MODULE_EXECUTION_STATE_CONFLICT' : 'MODULE_EXECUTION_NOT_FOUND',
            current ? 409 : 404,
          );
        }
        await tx
          .update(moduleExecutionLeases)
          .set({ releasedAt: cancelledAt })
          .where(
            and(
              eq(moduleExecutionLeases.executionId, command.executionId),
              isNull(moduleExecutionLeases.releasedAt),
            ),
          );
        await tx
          .update(moduleCapabilityGrants)
          .set({ revokedAt: cancelledAt })
          .where(
            and(
              eq(moduleCapabilityGrants.executionId, command.executionId),
              isNull(moduleCapabilityGrants.revokedAt),
            ),
          );
        await appendEvent(tx, {
          executionId: command.executionId,
          accountId: command.accountId,
          projectId: command.projectId,
          eventType: 'execution_cancelled',
          payload: { state: 'cancelled' },
          createdAt: cancelledAt,
        });
        return execution(cancelled);
      });
    },

    async finalize(command: FinalizeModuleExecutionCommand) {
      return db.transaction(async (tx) => {
        try {
          await tx.execute(sql`
            SELECT * FROM kortix.finalize_module_execution(
              ${command.accountId}::uuid,
              ${command.projectId}::uuid,
              ${command.executionId}::uuid,
              ${command.leaseId}::uuid,
              ${command.generation}::integer,
              ${command.runnerId}::uuid,
              ${command.outcome}::kortix.module_execution_state,
              ${command.evidenceDigest}::varchar,
              ${JSON.stringify(command.evidence)}::jsonb,
              ${`execution:${command.executionId}:terminal`}::varchar,
              ${JSON.stringify(command.usage)}::jsonb
            )
          `);
        } catch (error) {
          conflict(error);
        }
        const row = await getExecution(
          tx,
          command.accountId,
          command.projectId,
          command.executionId,
        );
        const [evidenceRow] = await tx
          .select()
          .from(moduleExecutionEvidence)
          .where(eq(moduleExecutionEvidence.executionId, command.executionId))
          .limit(1);
        const [outboxRow] = await tx
          .select()
          .from(moduleExecutionOutbox)
          .where(eq(moduleExecutionOutbox.executionId, command.executionId))
          .limit(1);
        if (!row || !evidenceRow || !outboxRow) {
          throw new ModuleExecutionError('MODULE_EXECUTION_STATE_CONFLICT', 409);
        }
        await appendEvent(tx, {
          executionId: command.executionId,
          accountId: command.accountId,
          projectId: command.projectId,
          eventType: 'execution_finalized',
          payload: { state: command.outcome },
        });
        return {
          execution: execution(row),
          evidence: evidence(evidenceRow),
          outbox: outbox(outboxRow),
        };
      });
    },
  };
}

export function createDrizzleModuleExecutionBindingResolver(
  db: Database,
): RunnerClaimBindingResolver & {
  resolve(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    actorUserId: string;
  }): ReturnType<RunnerClaimBindingResolver['resolveForClaim']>;
} {
  const resolve = async (input: {
    accountId?: string;
    projectId?: string;
    installationId?: string;
    executionId?: string;
  }) => {
    let coordinates = input;
    if (input.executionId) {
      const [row] = await db
        .select({
          accountId: moduleExecutions.accountId,
          projectId: moduleExecutions.projectId,
          installationId: moduleExecutions.installationId,
        })
        .from(moduleExecutions)
        .where(eq(moduleExecutions.executionId, input.executionId))
        .limit(1);
      if (!row) return null;
      coordinates = row;
    }
    if (!coordinates.accountId || !coordinates.projectId || !coordinates.installationId) {
      return null;
    }
    const [row] = await db
      .select({
        installation: projectModuleInstallations,
        release: developerModuleReleases,
        consent: projectModuleConsentRevisions,
        descriptor: moduleRuntimeDescriptors,
        artifact: moduleRuntimeArtifacts,
      })
      .from(projectModuleInstallations)
      .innerJoin(
        developerModuleReleases,
        and(
          eq(developerModuleReleases.releaseId, projectModuleInstallations.activeReleaseId),
          eq(developerModuleReleases.accountId, projectModuleInstallations.accountId),
        ),
      )
      .innerJoin(
        projectModuleConsentRevisions,
        and(
          eq(
            projectModuleConsentRevisions.installationId,
            projectModuleInstallations.installationId,
          ),
          eq(
            projectModuleConsentRevisions.installRevision,
            projectModuleInstallations.installRevision,
          ),
          eq(projectModuleConsentRevisions.releaseId, projectModuleInstallations.activeReleaseId),
        ),
      )
      .innerJoin(
        moduleRuntimeDescriptors,
        and(
          eq(moduleRuntimeDescriptors.releaseId, developerModuleReleases.releaseId),
          eq(moduleRuntimeDescriptors.accountId, developerModuleReleases.accountId),
        ),
      )
      .innerJoin(
        moduleRuntimeArtifacts,
        and(
          eq(moduleRuntimeArtifacts.accountId, developerModuleReleases.accountId),
          eq(moduleRuntimeArtifacts.releaseId, developerModuleReleases.releaseId),
          eq(moduleRuntimeArtifacts.runtimeDescriptorId, moduleRuntimeDescriptors.descriptorId),
        ),
      )
      .where(
        and(
          eq(projectModuleInstallations.accountId, coordinates.accountId),
          eq(projectModuleInstallations.projectId, coordinates.projectId),
          eq(projectModuleInstallations.installationId, coordinates.installationId),
          eq(projectModuleInstallations.status, 'active'),
          eq(developerModuleReleases.status, 'published'),
          isNull(developerModuleReleases.revokedAt),
          isNotNull(developerModuleReleases.signaturePayloadDigest),
          isNotNull(developerModuleReleases.verificationPolicyDigest),
          isNotNull(developerModuleReleases.signature),
          eq(
            moduleRuntimeDescriptors.descriptorDigest,
            developerModuleReleases.runtimeDescriptorDigest,
          ),
          eq(moduleRuntimeDescriptors.runtimeKind, developerModuleReleases.runtimeKind),
        ),
      )
      .orderBy(desc(projectModuleConsentRevisions.createdAt))
      .limit(1);
    if (!row) return null;
    if (!row.release.signaturePayloadDigest || !row.release.verificationPolicyDigest) return null;
    let descriptor: ReturnType<typeof parseRuntimeDescriptor>;
    try {
      descriptor = parseRuntimeDescriptor(row.descriptor.descriptor);
    } catch {
      return null;
    }
    if (descriptor.runtime.kind !== 'wasi-component') return null;
    if (!row.artifact) return null;
    const artifactBytes = Number(row.artifact.artifactBytes);
    if (
      row.artifact.releaseId !== row.release.releaseId ||
      row.artifact.runtimeDescriptorId !== row.descriptor.descriptorId ||
      !SHA256_DIGEST.test(row.artifact.artifactDigest) ||
      !Number.isSafeInteger(artifactBytes) ||
      artifactBytes < 1 ||
      artifactBytes > WASI_RUNTIME_ARTIFACT_MAX_BYTES ||
      row.artifact.mediaType !== 'application/wasm'
    ) {
      return null;
    }
    const killSwitches = await db
      .select({
        generation: moduleKillSwitchGenerations.generation,
        active: moduleKillSwitchGenerations.active,
      })
      .from(moduleKillSwitchGenerations)
      .where(
        and(
          eq(moduleKillSwitchGenerations.accountId, coordinates.accountId),
          or(
            eq(moduleKillSwitchGenerations.scope, 'account'),
            and(
              eq(moduleKillSwitchGenerations.scope, 'project'),
              eq(moduleKillSwitchGenerations.projectId, coordinates.projectId),
            ),
          ),
        ),
      )
      .orderBy(desc(moduleKillSwitchGenerations.generation));
    if (killSwitches.some((item) => item.active)) return null;
    return {
      accountId: row.installation.accountId,
      projectId: row.installation.projectId,
      installationId: row.installation.installationId,
      installRevision: row.installation.installRevision,
      releaseId: row.release.releaseId,
      releaseDigest: row.release.signaturePayloadDigest as Sha256Digest,
      consentRevisionId: row.consent.consentRevisionId,
      permissionDigest: row.consent.permissionDigest as Sha256Digest,
      policyDigest: row.release.verificationPolicyDigest as Sha256Digest,
      runtimeDescriptorId: row.descriptor.descriptorId,
      runtimeDescriptorDigest: row.descriptor.descriptorDigest as Sha256Digest,
      runtimeDescriptor: descriptor,
      runtimeArtifactDigest: row.artifact.artifactDigest as Sha256Digest,
      runtimeArtifactBytes: artifactBytes,
      runtimeKind: descriptor.runtime.kind,
      runtimeProfile: 'openopc-wasi-v1',
      killSwitchGeneration: Number(killSwitches[0]?.generation ?? 0),
      resourceCeilings: {
        cpuMillis: row.consent.resourceCpuMillisCeiling,
        memoryMiB: row.consent.resourceMemoryMibCeiling,
        wallTimeMs: row.consent.resourceWallTimeMsCeiling,
        costMicro: row.consent.costCeilingMicro,
      },
      confirmationRequired: row.consent.costCeilingMicro > 0,
    };
  };
  return {
    resolve: (input) => resolve(input),
    resolveForClaim: (executionId) => resolve({ executionId }),
  };
}

export function createDrizzleModuleRunnerRepository(db: Database): ModuleRunnerRepository {
  const profiles = async (runnerId: string) =>
    db
      .select({
        profileName: moduleRunnerProfiles.profileName,
        runtimeKind: moduleRunnerProfiles.runtimeKind,
      })
      .from(moduleRunnerProfiles)
      .where(eq(moduleRunnerProfiles.runnerId, runnerId))
      .orderBy(asc(moduleRunnerProfiles.profileName));

  return {
    async get(runnerId) {
      const [row] = await db
        .select()
        .from(moduleRunners)
        .where(eq(moduleRunners.runnerId, runnerId))
        .limit(1);
      return row ? runner(row, await profiles(row.runnerId)) : null;
    },

    async register(input) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(moduleRunners)
          .values({
            runnerId: input.runnerId,
            accountId: input.accountId,
            nodeIdentity: input.nodeIdentity,
            status: input.status,
            softwareVersion: input.softwareVersion,
            attestationDigest: input.attestationDigest,
            certificateThumbprint: input.certificateThumbprint,
            updatedAt: input.updatedAt,
          })
          .returning();
        if (!row) throw new Error('Module Runner insert returned no row');
        const createdProfiles = await tx
          .insert(moduleRunnerProfiles)
          .values(
            input.profiles.map((profile) => ({
              runnerId: row.runnerId,
              accountId: row.accountId,
              profileName: profile.profileName,
              runtimeKind: profile.runtimeKind,
            })),
          )
          .returning();
        return runner(
          row,
          createdProfiles.map((profile) => ({
            profileName: profile.profileName,
            runtimeKind: profile.runtimeKind,
          })),
        );
      });
    },

    async heartbeat(input) {
      const [row] = await db
        .update(moduleRunners)
        .set({
          softwareVersion: input.softwareVersion,
          attestationDigest: input.attestationDigest,
          updatedAt: input.updatedAt,
        })
        .where(eq(moduleRunners.runnerId, input.runnerId))
        .returning();
      if (!row) throw new ModuleExecutionError('MODULE_EXECUTION_NOT_FOUND', 404);
      return runner(row, await profiles(row.runnerId));
    },
  };
}
