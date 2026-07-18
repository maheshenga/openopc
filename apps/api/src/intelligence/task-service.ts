import {
  type IntelligenceCreateTaskRequest,
  IntelligenceCreateTaskRequestSchema,
  StudioErrorCodeSchema,
  type StudioEstimateResponse,
  type StudioJobEvent,
} from '@kortix/api-contract';
import { type Database, intelligenceTaskEvents, intelligenceTasks, studioJobs } from '@kortix/db';
import { type TaskEvent, TaskEventSchema } from '@kortix/intelligence-contracts';
import { canonicalStudioRequestHash } from '@kortix/studio-runtime';
import { and, asc, eq, gt, max, sql } from 'drizzle-orm';
import type { StudioCredentialBindingExists } from '../studio';
import { resolveStudioEstimate } from '../studio/estimates';
import type { StudioRepository } from '../studio/types';

const PUBLIC_EVENT_PAGE_SIZE = 100;
const MAX_STUDIO_SYNC_PAGES = 10;
const CAPABILITY_VERSION = '1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sharedStoreCreateLocks = new WeakMap<object, Map<string, Promise<void>>>();

function sharedCreateLocks(object: object): Map<string, Promise<void>> {
  const existing = sharedStoreCreateLocks.get(object);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  sharedStoreCreateLocks.set(object, created);
  return created;
}

async function withObjectCreateLock<T>(
  object: object,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const locks = sharedCreateLocks(object);
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

type IntelligenceTaskStatus = TaskEvent['status'];

export type IntelligenceTaskCreateInput = {
  accountId: string;
  projectId: string;
  actorUserId: string | null;
  actorType: 'user' | 'agent' | 'system';
  actingTokenId: string | null;
  agentName: string | null;
  sessionId: string | null;
  request: IntelligenceCreateTaskRequest;
};

export type IntelligenceTaskCreateResult = {
  taskId: string;
  jobId: string;
  created: boolean;
};

export type IntelligenceTaskRecord = {
  taskId: string;
  accountId: string;
  projectId: string;
  jobId: string | null;
  actorUserId: string | null;
  actorType: 'user' | 'agent' | 'system';
  actingTokenId: string | null;
  agentName: string | null;
  sessionId: string | null;
  parentTaskId: string | null;
  capabilityId: 'studio.image.generate';
  capabilityVersion: '1.0.0';
  providerConfigId: string;
  model: string;
  requestHash: string;
  idempotencyKey: string;
  status: IntelligenceTaskStatus;
  agentCardHash: string;
  studioSourceCursor: string | null;
  deadlineAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type IntelligenceTaskInsertInput = Omit<IntelligenceTaskRecord, 'taskId' | 'studioSourceCursor'> & {
  taskId?: string;
  studioSourceCursor?: string | null;
};

type IntelligenceTaskJobContext = {
  task: IntelligenceTaskRecord;
  parentJobId: string | null;
};

export type IntelligenceStoredTaskEvent = TaskEvent & {
  studioCursor: string | null;
};

export interface IntelligenceTaskStore {
  createWithJob(
    input: IntelligenceTaskInsertInput,
    createJob: (context: IntelligenceTaskJobContext) => Promise<{
      jobId: string;
      created: boolean;
    }>,
  ): Promise<{
    task: IntelligenceTaskRecord;
    jobId: string | null;
    created: boolean;
    inserted: boolean;
  }>;
  reserve(input: IntelligenceTaskInsertInput): Promise<{
    task: IntelligenceTaskRecord;
    inserted: boolean;
  }>;
  attachJob(input: {
    accountId: string;
    projectId: string;
    taskId: string;
    jobId: string;
    updatedAt: string;
  }): Promise<IntelligenceTaskRecord>;
  get(input: {
    accountId: string;
    projectId: string;
    taskId: string;
  }): Promise<IntelligenceTaskRecord | null>;
  findByIdempotency(input: {
    accountId: string;
    projectId: string;
    idempotencyKey: string;
  }): Promise<IntelligenceTaskRecord | null>;
  lastStudioCursor(taskId: string): Promise<string | null>;
  advanceStudioCursor(input: {
    taskId: string;
    studioCursor: string;
    updatedAt: string;
  }): Promise<void>;
  appendEvent(input: {
    taskId: string;
    eventId: string;
    studioCursor: string | null;
    type: TaskEvent['type'];
    status: TaskEvent['status'];
    payload: Pick<TaskEvent, 'progress' | 'error_code' | 'asset_ids'>;
    createdAt: string;
  }): Promise<IntelligenceStoredTaskEvent | null>;
  listEvents(input: {
    taskId: string;
    afterSequence: number;
    limit: number;
  }): Promise<{ items: IntelligenceStoredTaskEvent[]; hasMore: boolean }>;
}

export class IntelligenceTaskServiceError extends Error {
  constructor(
    readonly code:
      | 'INTELLIGENCE_IDEMPOTENCY_MISMATCH'
      | 'INTELLIGENCE_TASK_EXECUTION_FAILED'
      | 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE'
      | 'INTELLIGENCE_VALIDATION_ERROR',
    readonly status: 400 | 409 | 503,
  ) {
    super(code);
    this.name = 'IntelligenceTaskServiceError';
  }
}

export function isIntelligenceTaskServiceError(
  error: unknown,
): error is Pick<IntelligenceTaskServiceError, 'code' | 'status'> {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as Record<string, unknown>;
  return (
    (candidate.code === 'INTELLIGENCE_IDEMPOTENCY_MISMATCH' && candidate.status === 409) ||
    (candidate.code === 'INTELLIGENCE_VALIDATION_ERROR' && candidate.status === 400) ||
    ((candidate.code === 'INTELLIGENCE_TASK_EXECUTION_FAILED' ||
      candidate.code === 'INTELLIGENCE_TASK_EVENTS_UNAVAILABLE') &&
      candidate.status === 503)
  );
}

type StudioJobCreator = (
  input: IntelligenceTaskCreateInput & {
    requestHash: string;
    studioRequestHash: string;
    studioIdempotencyKey: string;
    parentJobId: string | null;
  },
) => Promise<{ jobId: string; created: boolean }>;

type StudioEventReader = (input: {
  projectId: string;
  jobId: string;
  cursor: string | null;
}) => Promise<{ items: StudioJobEvent[]; next_cursor: string | null }>;

export class IntelligenceTaskService {
  constructor(
    private readonly input: {
      store: IntelligenceTaskStore;
      createStudioJob: StudioJobCreator;
      readStudioEvents: StudioEventReader;
      now?: () => Date;
    },
  ) {}

  async create(input: IntelligenceTaskCreateInput): Promise<IntelligenceTaskCreateResult> {
    const parsed = IntelligenceCreateTaskRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
    }
    const normalized = { ...input, request: parsed.data };
    return this.withCreateLock(
      `${normalized.projectId}\u0000${normalized.request.idempotency_key}`,
      () => this.createLocked(normalized),
    );
  }

  async replay(
    input: Pick<IntelligenceTaskCreateInput, 'accountId' | 'projectId' | 'request'>,
  ): Promise<IntelligenceTaskCreateResult | null> {
    const parsed = IntelligenceCreateTaskRequestSchema.safeParse(input.request);
    if (!parsed.success) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
    }
    const task = await this.input.store.findByIdempotency({
      accountId: input.accountId,
      projectId: input.projectId,
      idempotencyKey: parsed.data.idempotency_key,
    });
    if (!task) return null;
    if (
      task.accountId !== input.accountId ||
      task.projectId !== input.projectId ||
      task.requestHash !== intelligenceTaskRequestHash(parsed.data)
    ) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
    }
    // This lookup runs before current capability/card checks at the route seam.
    // Only already-bound work is safe to replay here; unbound recovery must go
    // through the authorized create path again.
    if (!task.jobId) return null;
    return { taskId: task.taskId, jobId: task.jobId, created: false };
  }

  async events(input: {
    accountId: string;
    projectId: string;
    taskId: string;
    cursor: string | null;
  }): Promise<{ items: TaskEvent[]; nextCursor: string | null } | null> {
    const afterSequence = parsePublicCursor(input.cursor);
    const task = await this.input.store.get(input);
    if (!task) return null;

    if (task.jobId) await this.synchronizeStudioEvents(task);
    const page = await this.input.store.listEvents({
      taskId: task.taskId,
      afterSequence,
      limit: PUBLIC_EVENT_PAGE_SIZE + 1,
    });
    const items = page.items.slice(0, PUBLIC_EVENT_PAGE_SIZE).map(toPublicTaskEvent);
    return {
      items,
      nextCursor:
        page.hasMore && items.length > 0 ? String(items[items.length - 1].sequence) : null,
    };
  }

  read(input: {
    accountId: string;
    projectId: string;
    taskId: string;
    cursor: string | null;
  }) {
    return this.events(input);
  }

  private async createLocked(
    input: IntelligenceTaskCreateInput,
  ): Promise<IntelligenceTaskCreateResult> {
    const now = this.now().toISOString();
    const requestHash = intelligenceTaskRequestHash(input.request);
    const result = await this.input.store.createWithJob(
      {
        accountId: input.accountId,
        projectId: input.projectId,
        jobId: null,
        actorUserId: input.actorUserId,
        actorType: input.actorType,
        actingTokenId: input.actingTokenId,
        agentName: input.agentName,
        sessionId: input.sessionId,
        parentTaskId: input.request.parent_task_id ?? null,
        capabilityId: input.request.capability_id,
        capabilityVersion: CAPABILITY_VERSION,
        providerConfigId: input.request.provider_config_id,
        model: input.request.model,
        requestHash,
        idempotencyKey: input.request.idempotency_key,
        status: 'queued',
        agentCardHash: input.request.agent_card_hash,
        studioSourceCursor: null,
        deadlineAt: input.request.deadline_at ?? null,
        createdAt: now,
        updatedAt: now,
      },
      async ({ task, parentJobId }) => {
        if (
          task.accountId !== input.accountId ||
          task.projectId !== input.projectId ||
          task.requestHash !== requestHash
        ) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
        }
        if (input.request.parent_task_id && !parentJobId) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
        }
        return this.input.createStudioJob({
          ...input,
          requestHash,
          studioRequestHash: studioRequestHash(input.request),
          studioIdempotencyKey: intelligenceStudioIdempotencyKey(
            input.projectId,
            input.request.idempotency_key,
          ),
          parentJobId,
        });
      },
    );
    if (
      result.task.accountId !== input.accountId ||
      result.task.projectId !== input.projectId ||
      result.task.requestHash !== requestHash
    ) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
    }
    if (!result.jobId) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
    }
    if (result.task.jobId !== result.jobId) {
      throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
    }
    return {
      taskId: result.task.taskId,
      jobId: result.jobId,
      created: result.inserted,
    };
  }

  private async synchronizeStudioEvents(task: IntelligenceTaskRecord): Promise<void> {
    let cursor = await this.input.store.lastStudioCursor(task.taskId);
    let status = task.status;
    for (let pageIndex = 0; pageIndex < MAX_STUDIO_SYNC_PAGES; pageIndex += 1) {
      const pageStartCursor = cursor;
      const result = await this.input.readStudioEvents({
        projectId: task.projectId,
        jobId: task.jobId as string,
        cursor,
      });
      const sorted = [...result.items].sort(
        (left, right) => Number(left.cursor) - Number(right.cursor),
      );
      for (const event of sorted) {
        if (event.job_id !== task.jobId) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
        }
        const studioCursor = parseStudioCursor(event.cursor);
        if (cursor !== null && studioCursor <= Number(cursor)) continue;
        const mapped = mapStudioEvent(task.taskId, event);
        if (!mapped) {
          await this.input.store.advanceStudioCursor({
            taskId: task.taskId,
            studioCursor: String(studioCursor),
            updatedAt: safeDateTime(event.created_at),
          });
          cursor = String(studioCursor);
          continue;
        }
        if (isTerminalStatus(status) && !isTerminalStatus(mapped.status)) {
          await this.input.store.advanceStudioCursor({
            taskId: task.taskId,
            studioCursor: String(studioCursor),
            updatedAt: mapped.created_at,
          });
          cursor = String(studioCursor);
          continue;
        }
        const stored = await this.input.store.appendEvent({
          taskId: task.taskId,
          eventId: mapped.event_id,
          studioCursor: String(studioCursor),
          type: mapped.type,
          status: mapped.status,
          payload: publicEventPayload(mapped),
          createdAt: mapped.created_at,
        });
        if (!stored) {
          cursor = String(studioCursor);
          continue;
        }
        cursor = stored.studioCursor;
        status = stored.status;
      }
      if (result.next_cursor === null) return;
      if (cursor === pageStartCursor) {
        throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
      }
    }
  }

  private now(): Date {
    return (this.input.now ?? (() => new Date()))();
  }

  private async withCreateLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const createLocks = sharedCreateLocks(this.input.store);
    const previous = createLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    createLocks.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (createLocks.get(key) === tail) createLocks.delete(key);
    }
  }
}

export function intelligenceTaskRequestHash(request: IntelligenceCreateTaskRequest): string {
  const { idempotency_key: _idempotencyKey, ...requestWithoutIdempotency } = request;
  return canonicalStudioRequestHash({
    ...requestWithoutIdempotency,
    parent_task_id: request.parent_task_id ?? null,
    deadline_at: request.deadline_at ?? null,
  });
}

export function studioRequestHash(request: IntelligenceCreateTaskRequest): string {
  return canonicalStudioRequestHash({
    capability: request.input.capability,
    provider_config_id: request.provider_config_id,
    model: request.model,
    input: request.input,
  });
}

export function intelligenceStudioIdempotencyKey(
  projectId: string,
  idempotencyKey: string,
): string {
  return `intelligence:v1:${projectId}:${canonicalStudioRequestHash({ projectId, idempotencyKey })}`;
}

export function createStudioJobBridge(input: {
  repository: StudioRepository;
  credentialBindingExists?: StudioCredentialBindingExists;
  assertReadyBeforeReservation: () => Promise<void>;
  now?: () => Date;
}): StudioJobCreator {
  return async (task) => {
    try {
      const existing = await input.repository.findJobByIdempotency(
        task.accountId,
        task.studioIdempotencyKey,
      );
      if (existing) {
        if (
          existing.account_id !== task.accountId ||
          existing.project_id !== task.projectId ||
          existing.idempotency_key !== task.studioIdempotencyKey ||
          existing.request_hash !== task.studioRequestHash
        ) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
        }
        return { jobId: existing.job_id, created: false };
      }
      await input.assertReadyBeforeReservation();
      const resolution = await resolveStudioEstimate({
        repository: input.repository,
        accountId: task.accountId,
        projectId: task.projectId,
        request: {
          capability: task.request.input.capability,
          provider_config_id: task.request.provider_config_id,
          model: task.request.model,
          input: task.request.input,
        },
        credentialBindingExists: input.credentialBindingExists,
      });
      if (!resolution.ok) {
        throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
      }
      const createdAt = (input.now ?? (() => new Date()))();
      const estimate: StudioEstimateResponse = {
        estimate_id: crypto.randomUUID(),
        expires_at: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
        currency: 'credits',
        input_hash: task.studioRequestHash,
        estimate_token: 'intelligence-internal',
        ...resolution.value.costs,
      };
      const result = await input.repository.createJob(
        {
          capability: task.request.input.capability,
          provider_config_id: task.request.provider_config_id,
          model: task.request.model,
          input: task.request.input,
          estimate_id: estimate.estimate_id,
          estimate_token: estimate.estimate_token,
          idempotency_key: task.studioIdempotencyKey,
          request_hash: task.studioRequestHash,
          account_id: task.accountId,
          project_id: task.projectId,
          actor_user_id: task.actorUserId,
          actor_type: task.actorType,
          acting_token_id: task.actingTokenId,
          agent_name: task.agentName,
          session_id: task.sessionId,
          parent_job_id: task.parentJobId,
        },
        resolution.value.provider,
        estimate,
        resolution.value.productionBinding,
      );
      if (result.mismatch) {
        throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
      }
      if (result.job.account_id !== task.accountId || result.job.project_id !== task.projectId) {
        throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
      }
      return { jobId: result.job.job_id, created: result.created };
    } catch (error) {
      if (isIntelligenceTaskServiceError(error)) throw error;
      throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
    }
  };
}

export function createDrizzleIntelligenceTaskStore(database: Database): IntelligenceTaskStore {
  return {
    async createWithJob(input, createJob) {
      const advisoryLockKey = `intelligence-task:v1:${canonicalStudioRequestHash({
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      })}`;
      return withObjectCreateLock(database, advisoryLockKey, async () => {
        const reserved = await database.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${advisoryLockKey}, 0))`,
          );
          let parentJobId: string | null = null;
          if (input.parentTaskId) {
            const [parent] = await tx
              .select({ jobId: intelligenceTasks.jobId })
              .from(intelligenceTasks)
              .innerJoin(
                studioJobs,
                and(
                  eq(studioJobs.jobId, intelligenceTasks.jobId),
                  eq(studioJobs.accountId, input.accountId),
                  eq(studioJobs.projectId, input.projectId),
                ),
              )
              .where(
                and(
                  eq(intelligenceTasks.taskId, input.parentTaskId),
                  eq(intelligenceTasks.accountId, input.accountId),
                  eq(intelligenceTasks.projectId, input.projectId),
                ),
              )
              .limit(1);
            parentJobId = parent?.jobId ?? null;
            if (!parentJobId) {
              throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
            }
          }
          const taskId = input.taskId ?? crypto.randomUUID();
          const inserted = await tx
            .insert(intelligenceTasks)
            .values({
              taskId,
              accountId: input.accountId,
              projectId: input.projectId,
              jobId: input.jobId,
              actorUserId: input.actorUserId,
              actorType: input.actorType,
              actingTokenId: input.actingTokenId,
              agentName: input.agentName,
              sessionId: input.sessionId,
              parentTaskId: input.parentTaskId,
              capabilityId: input.capabilityId,
              capabilityVersion: input.capabilityVersion,
              providerConfigId: input.providerConfigId,
              model: input.model,
              requestHash: input.requestHash,
              idempotencyKey: input.idempotencyKey,
              status: input.status,
              agentCardHash: input.agentCardHash,
              studioSourceCursor:
                input.studioSourceCursor === null || input.studioSourceCursor === undefined
                  ? null
                  : Number(input.studioSourceCursor),
              deadlineAt: input.deadlineAt,
              createdAt: input.createdAt,
              updatedAt: input.updatedAt,
            })
            .onConflictDoNothing({
              target: [intelligenceTasks.projectId, intelligenceTasks.idempotencyKey],
            })
            .returning();
          const row =
            inserted[0] ??
            (
              await tx
                .select()
                .from(intelligenceTasks)
                .where(
                  and(
                    eq(intelligenceTasks.projectId, input.projectId),
                    eq(intelligenceTasks.idempotencyKey, input.idempotencyKey),
                  ),
                )
                .limit(1)
            )[0];
          if (!row) throw new Error('Intelligence task reservation could not be reloaded');
          if (
            row.accountId !== input.accountId ||
            row.projectId !== input.projectId ||
            row.requestHash !== input.requestHash
          ) {
            throw new IntelligenceTaskServiceError('INTELLIGENCE_IDEMPOTENCY_MISMATCH', 409);
          }
          if (inserted[0]) {
            await tx.insert(intelligenceTaskEvents).values({
              eventId: crypto.randomUUID(),
              taskId: row.taskId,
              sequence: 1,
              studioCursor: null,
              eventType: 'created',
              status: 'queued',
              payload: {},
              createdAt: input.createdAt,
            });
          }
          return {
            task: serializeTask(row),
            parentJobId,
            inserted: inserted.length === 1,
          };
        });
        if (reserved.task.jobId) {
          return {
            task: reserved.task,
            jobId: reserved.task.jobId,
            created: false,
            inserted: reserved.inserted,
          };
        }

        // Keep an unbound reservation when the callback fails. The callback runs
        // outside the reservation transaction, so deleting here can race with
        // another process that is reusing the same stable Studio key.
        const job = await createJob({ task: reserved.task, parentJobId: reserved.parentJobId });

        return await database.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${advisoryLockKey}, 0))`,
          );
          const [current] = await tx
            .select()
            .from(intelligenceTasks)
            .where(
              and(
                eq(intelligenceTasks.accountId, input.accountId),
                eq(intelligenceTasks.projectId, input.projectId),
                eq(intelligenceTasks.taskId, reserved.task.taskId),
              ),
            )
            .limit(1);
          if (!current) throw new Error('Intelligence task disappeared before attachment');
          if (current.jobId) {
            if (current.jobId !== job.jobId) {
              throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
            }
            return {
              task: serializeTask(current),
              jobId: current.jobId,
              created: false,
              inserted: reserved.inserted,
            };
          }
          const [ownedJob] = await tx
            .select({ jobId: studioJobs.jobId })
            .from(studioJobs)
            .where(
              and(
                eq(studioJobs.jobId, job.jobId),
                eq(studioJobs.accountId, input.accountId),
                eq(studioJobs.projectId, input.projectId),
              ),
            )
            .limit(1);
          if (!ownedJob) throw new Error('Intelligence task Studio job scope is invalid');
          const [attached] = await tx
            .update(intelligenceTasks)
            .set({ jobId: job.jobId, status: 'queued', updatedAt: input.updatedAt })
            .where(
              and(
                eq(intelligenceTasks.accountId, input.accountId),
                eq(intelligenceTasks.projectId, input.projectId),
                eq(intelligenceTasks.taskId, reserved.task.taskId),
                sql`(${intelligenceTasks.jobId} IS NULL OR ${intelligenceTasks.jobId} = ${job.jobId}::uuid)`,
              ),
            )
            .returning();
          if (!attached) throw new Error('Intelligence task job attachment failed');
          return {
            task: serializeTask(attached),
            jobId: job.jobId,
            created: job.created,
            inserted: reserved.inserted,
          };
        });
      });
    },

    async reserve(input) {
      return database.transaction(async (tx) => {
        const taskId = input.taskId ?? crypto.randomUUID();
        const inserted = await tx
          .insert(intelligenceTasks)
          .values({
            taskId,
            accountId: input.accountId,
            projectId: input.projectId,
            jobId: input.jobId,
            actorUserId: input.actorUserId,
            actorType: input.actorType,
            actingTokenId: input.actingTokenId,
            agentName: input.agentName,
            sessionId: input.sessionId,
            parentTaskId: input.parentTaskId,
            capabilityId: input.capabilityId,
            capabilityVersion: input.capabilityVersion,
            providerConfigId: input.providerConfigId,
            model: input.model,
            requestHash: input.requestHash,
            idempotencyKey: input.idempotencyKey,
            status: input.status,
            agentCardHash: input.agentCardHash,
            studioSourceCursor:
              input.studioSourceCursor === null || input.studioSourceCursor === undefined
                ? null
                : Number(input.studioSourceCursor),
            deadlineAt: input.deadlineAt,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          })
          .onConflictDoNothing({
            target: [intelligenceTasks.projectId, intelligenceTasks.idempotencyKey],
          })
          .returning();
        const row =
          inserted[0] ??
          (
            await tx
              .select()
              .from(intelligenceTasks)
              .where(
                and(
                  eq(intelligenceTasks.projectId, input.projectId),
                  eq(intelligenceTasks.idempotencyKey, input.idempotencyKey),
                ),
              )
              .limit(1)
          )[0];
        if (!row) throw new Error('Intelligence task reservation could not be reloaded');
        if (inserted[0]) {
          await tx.insert(intelligenceTaskEvents).values({
            eventId: crypto.randomUUID(),
            taskId: row.taskId,
            sequence: 1,
            studioCursor: null,
            eventType: 'created',
            status: 'queued',
            payload: {},
            createdAt: input.createdAt,
          });
        }
        return { task: serializeTask(row), inserted: inserted.length === 1 };
      });
    },

    async attachJob(input) {
      const [row] = await database
        .update(intelligenceTasks)
        .set({ jobId: input.jobId, status: 'queued', updatedAt: input.updatedAt })
        .where(
          and(
            eq(intelligenceTasks.accountId, input.accountId),
            eq(intelligenceTasks.projectId, input.projectId),
            eq(intelligenceTasks.taskId, input.taskId),
            sql`(${intelligenceTasks.jobId} IS NULL OR ${intelligenceTasks.jobId} = ${input.jobId}::uuid)`,
          ),
        )
        .returning();
      if (!row || (row.jobId !== null && row.jobId !== input.jobId)) {
        throw new Error('Intelligence task job attachment failed');
      }
      return serializeTask(row);
    },

    async get(input) {
      const [row] = await database
        .select()
        .from(intelligenceTasks)
        .where(
          and(
            eq(intelligenceTasks.accountId, input.accountId),
            eq(intelligenceTasks.projectId, input.projectId),
            eq(intelligenceTasks.taskId, input.taskId),
          ),
        )
        .limit(1);
      return row ? serializeTask(row) : null;
    },

    async findByIdempotency(input) {
      const [row] = await database
        .select()
        .from(intelligenceTasks)
        .where(
          and(
            eq(intelligenceTasks.accountId, input.accountId),
            eq(intelligenceTasks.projectId, input.projectId),
            eq(intelligenceTasks.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.jobId) {
        const expectedStudioKey = intelligenceStudioIdempotencyKey(
          input.projectId,
          input.idempotencyKey,
        );
        const [job] = await database
          .select({ jobId: studioJobs.jobId })
          .from(studioJobs)
          .where(
            and(
              eq(studioJobs.jobId, row.jobId),
              eq(studioJobs.accountId, input.accountId),
              eq(studioJobs.projectId, input.projectId),
              eq(studioJobs.idempotencyKey, expectedStudioKey),
            ),
          )
          .limit(1);
        if (!job) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EXECUTION_FAILED', 503);
        }
      }
      return serializeTask(row);
    },

    async lastStudioCursor(taskId) {
      const [row] = await database
        .select({ studioSourceCursor: intelligenceTasks.studioSourceCursor })
        .from(intelligenceTasks)
        .where(eq(intelligenceTasks.taskId, taskId))
        .limit(1);
      return row?.studioSourceCursor == null ? null : String(row.studioSourceCursor);
    },

    async advanceStudioCursor(input) {
      await database
        .update(intelligenceTasks)
        .set({
          studioSourceCursor: sql`GREATEST(COALESCE(${intelligenceTasks.studioSourceCursor}, 0), ${Number(input.studioCursor)})`,
          updatedAt: sql`GREATEST(${intelligenceTasks.updatedAt}, ${input.updatedAt}::timestamptz)`,
        })
        .where(eq(intelligenceTasks.taskId, input.taskId));
    },

    async appendEvent(input) {
      return database.transaction(async (tx) => {
        const [lockedTask] = await tx
          .select({
            taskId: intelligenceTasks.taskId,
            studioSourceCursor: intelligenceTasks.studioSourceCursor,
            status: intelligenceTasks.status,
          })
          .from(intelligenceTasks)
          .where(eq(intelligenceTasks.taskId, input.taskId))
          .for('update');
        if (!lockedTask) throw new Error('Intelligence task event target not found');
        if (input.studioCursor !== null) {
          const [existing] = await tx
            .select()
            .from(intelligenceTaskEvents)
            .where(
              and(
                eq(intelligenceTaskEvents.taskId, input.taskId),
                eq(intelligenceTaskEvents.studioCursor, Number(input.studioCursor)),
              ),
            )
            .limit(1);
          if (existing) {
            const stored = serializeStoredEvent(existing);
            assertSameStoredEvent(stored, input);
            return stored;
          }
          if (
            lockedTask.studioSourceCursor !== null &&
            Number(input.studioCursor) <= lockedTask.studioSourceCursor
          ) {
            throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
          }
          if (
            isTerminalStatus(lockedTask.status as IntelligenceTaskStatus) &&
            !isTerminalStatus(input.status)
          ) {
            await tx
              .update(intelligenceTasks)
              .set({
                studioSourceCursor: sql`GREATEST(COALESCE(${intelligenceTasks.studioSourceCursor}, 0), ${Number(input.studioCursor)})`,
                updatedAt: sql`GREATEST(${intelligenceTasks.updatedAt}, ${input.createdAt}::timestamptz)`,
              })
              .where(eq(intelligenceTasks.taskId, input.taskId));
            return null;
          }
          if (
            isTerminalStatus(lockedTask.status as IntelligenceTaskStatus) &&
            input.status !== lockedTask.status
          ) {
            throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
          }
        }
        const [maximum] = await tx
          .select({ value: max(intelligenceTaskEvents.sequence) })
          .from(intelligenceTaskEvents)
          .where(eq(intelligenceTaskEvents.taskId, input.taskId));
        const [inserted] = await tx
          .insert(intelligenceTaskEvents)
          .values({
            eventId: input.eventId,
            taskId: input.taskId,
            sequence: Number(maximum?.value ?? 0) + 1,
            studioCursor: input.studioCursor === null ? null : Number(input.studioCursor),
            eventType: input.type,
            status: input.status,
            payload: input.payload,
            createdAt: input.createdAt,
          })
          .returning();
        if (!inserted) throw new Error('Intelligence task event insert failed');
        await tx
          .update(intelligenceTasks)
          .set({
            status: input.status,
            ...(input.studioCursor === null
              ? {}
              : {
                  studioSourceCursor: sql`GREATEST(COALESCE(${intelligenceTasks.studioSourceCursor}, 0), ${Number(input.studioCursor)})`,
                }),
            updatedAt: sql`GREATEST(${intelligenceTasks.updatedAt}, ${input.createdAt}::timestamptz)`,
          })
          .where(eq(intelligenceTasks.taskId, input.taskId));
        return serializeStoredEvent(inserted);
      });
    },

    async listEvents(input) {
      const rows = await database
        .select()
        .from(intelligenceTaskEvents)
        .where(
          and(
            eq(intelligenceTaskEvents.taskId, input.taskId),
            gt(intelligenceTaskEvents.sequence, input.afterSequence),
          ),
        )
        .orderBy(asc(intelligenceTaskEvents.sequence))
        .limit(input.limit);
      return {
        items: rows.map(serializeStoredEvent),
        hasMore: rows.length >= input.limit,
      };
    },
  };
}

export function createInMemoryIntelligenceTaskStore(options: { taskId?: string } = {}) {
  const tasks = new Map<string, IntelligenceTaskRecord>();
  const byIdempotency = new Map<string, string>();
  const events = new Map<string, IntelligenceStoredTaskEvent[]>();
  let creationTail = Promise.resolve();

  const store: IntelligenceTaskStore = {
    async createWithJob(input, createJob) {
      const previous = creationTail;
      let release: () => void = () => undefined;
      creationTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const idempotencyKey = `${input.projectId}\u0000${input.idempotencyKey}`;
        if (!byIdempotency.has(idempotencyKey) && input.parentTaskId) {
          const parent = tasks.get(input.parentTaskId);
          if (
            !parent ||
            parent.accountId !== input.accountId ||
            parent.projectId !== input.projectId ||
            !parent.jobId
          ) {
            throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
          }
        }
        const reserved = await store.reserve(input);
        const task = reserved.task;
        if (task.jobId) {
          return { task, jobId: task.jobId, created: false, inserted: reserved.inserted };
        }
        let parentJobId: string | null = null;
        if (task.parentTaskId) {
          const parent = tasks.get(task.parentTaskId);
          if (
            parent &&
            parent.accountId === task.accountId &&
            parent.projectId === task.projectId
          ) {
            parentJobId = parent.jobId;
          }
        }
        const job = await createJob({ task, parentJobId });
        const attached = await store.attachJob({
          accountId: task.accountId,
          projectId: task.projectId,
          taskId: task.taskId,
          jobId: job.jobId,
          updatedAt: input.updatedAt,
        });
        return {
          task: attached,
          jobId: attached.jobId,
          created: job.created,
          inserted: reserved.inserted,
        };
      } finally {
        release();
      }
    },

    async reserve(input) {
      const key = `${input.projectId}\u0000${input.idempotencyKey}`;
      const existingId = byIdempotency.get(key);
      if (existingId)
        return { task: tasks.get(existingId) as IntelligenceTaskRecord, inserted: false };
      const taskId =
        input.taskId ?? (options.taskId && tasks.size === 0 ? options.taskId : crypto.randomUUID());
      const task = { ...input, taskId } as IntelligenceTaskRecord;
      tasks.set(taskId, task);
      byIdempotency.set(key, taskId);
      const created = TaskEventSchema.parse({
        protocol_version: 'intelligence.v1',
        event_id: crypto.randomUUID(),
        task_id: taskId,
        sequence: 1,
        type: 'created',
        status: 'queued',
        created_at: input.createdAt,
      });
      events.set(taskId, [{ ...created, studioCursor: null }]);
      return { task, inserted: true };
    },

    async attachJob(input) {
      const task = tasks.get(input.taskId);
      if (
        !task ||
        task.accountId !== input.accountId ||
        task.projectId !== input.projectId ||
        (task.jobId !== null && task.jobId !== input.jobId)
      ) {
        throw new Error('Intelligence task job attachment failed');
      }
      const updated = {
        ...task,
        jobId: input.jobId,
        status: 'queued' as const,
        updatedAt: input.updatedAt,
      };
      tasks.set(task.taskId, updated);
      return updated;
    },

    async get(input) {
      const task = tasks.get(input.taskId);
      return task?.accountId === input.accountId && task.projectId === input.projectId
        ? task
        : null;
    },

    async findByIdempotency(input) {
      const taskId = byIdempotency.get(`${input.projectId}\u0000${input.idempotencyKey}`);
      const task = taskId ? tasks.get(taskId) : null;
      return task?.accountId === input.accountId && task.projectId === input.projectId
        ? task
        : null;
    },

    async lastStudioCursor(taskId) {
      return tasks.get(taskId)?.studioSourceCursor ?? null;
    },

    async advanceStudioCursor(input) {
      const task = tasks.get(input.taskId);
      if (!task) throw new Error('Intelligence task cursor update failed');
      const current = task.studioSourceCursor === null ? 0 : Number(task.studioSourceCursor);
      const next = Number(input.studioCursor);
      if (!Number.isSafeInteger(next) || next < current) return;
      tasks.set(input.taskId, {
        ...task,
        studioSourceCursor: String(next),
        updatedAt: maxIsoDate(task.updatedAt, input.updatedAt),
      });
    },

    async appendEvent(input) {
      const list = events.get(input.taskId) ?? [];
      const task = tasks.get(input.taskId);
      if (input.studioCursor !== null) {
        const existing = list.find((event) => event.studioCursor === input.studioCursor);
        if (existing) {
          assertSameStoredEvent(existing, input);
          return existing;
        }
        if (
          task?.studioSourceCursor !== null &&
          task &&
          Number(input.studioCursor) <= Number(task.studioSourceCursor)
        ) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
        }
        if (task && isTerminalStatus(task.status) && !isTerminalStatus(input.status)) {
          tasks.set(input.taskId, {
            ...task,
            studioSourceCursor: input.studioCursor,
            updatedAt: maxIsoDate(task.updatedAt, input.createdAt),
          });
          return null;
        }
        if (task && isTerminalStatus(task.status) && input.status !== task.status) {
          throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
        }
      }
      const event = TaskEventSchema.parse({
        protocol_version: 'intelligence.v1',
        event_id: input.eventId,
        task_id: input.taskId,
        sequence: (list.at(-1)?.sequence ?? 0) + 1,
        type: input.type,
        status: input.status,
        ...input.payload,
        created_at: input.createdAt,
      });
      const stored = { ...event, studioCursor: input.studioCursor };
      list.push(stored);
      events.set(input.taskId, list);
      if (task) {
        const nextCursor =
          input.studioCursor === null
            ? task.studioSourceCursor
            : task.studioSourceCursor === null
              ? input.studioCursor
              : String(Math.max(Number(task.studioSourceCursor), Number(input.studioCursor)));
        tasks.set(input.taskId, {
          ...task,
          status: event.status,
          studioSourceCursor: nextCursor,
          updatedAt: maxIsoDate(task.updatedAt, event.created_at),
        });
      }
      return stored;
    },

    async listEvents(input) {
      const items = (events.get(input.taskId) ?? [])
        .filter((event) => event.sequence > input.afterSequence)
        .slice(0, input.limit);
      const total = (events.get(input.taskId) ?? []).filter(
        (event) => event.sequence > input.afterSequence,
      ).length;
      return { items, hasMore: total >= input.limit };
    },
  };
  return store;
}

export function createIntelligenceTaskService(
  input: ConstructorParameters<typeof IntelligenceTaskService>[0],
) {
  return new IntelligenceTaskService(input);
}

function serializeTask(row: typeof intelligenceTasks.$inferSelect): IntelligenceTaskRecord {
  return {
    taskId: row.taskId,
    accountId: row.accountId,
    projectId: row.projectId,
    jobId: row.jobId ?? null,
    actorUserId: row.actorUserId ?? null,
    actorType: row.actorType as IntelligenceTaskRecord['actorType'],
    actingTokenId: row.actingTokenId ?? null,
    agentName: row.agentName ?? null,
    sessionId: row.sessionId ?? null,
    parentTaskId: row.parentTaskId ?? null,
    capabilityId: row.capabilityId as IntelligenceTaskRecord['capabilityId'],
    capabilityVersion: row.capabilityVersion as IntelligenceTaskRecord['capabilityVersion'],
    providerConfigId: row.providerConfigId,
    model: row.model,
    requestHash: row.requestHash,
    idempotencyKey: row.idempotencyKey,
    status: row.status as IntelligenceTaskStatus,
    agentCardHash: row.agentCardHash,
    studioSourceCursor: row.studioSourceCursor == null ? null : String(row.studioSourceCursor),
    deadlineAt: row.deadlineAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeStoredEvent(
  row: typeof intelligenceTaskEvents.$inferSelect,
): IntelligenceStoredTaskEvent {
  const payload = row.payload ?? {};
  const parsed = TaskEventSchema.parse({
    protocol_version: 'intelligence.v1',
    event_id: row.eventId,
    task_id: row.taskId,
    sequence: Number(row.sequence),
    type: row.eventType,
    status: row.status,
    ...(typeof payload.progress === 'number' ? { progress: payload.progress } : {}),
    ...(typeof payload.error_code === 'string' ? { error_code: payload.error_code } : {}),
    ...(Array.isArray(payload.asset_ids) ? { asset_ids: payload.asset_ids } : {}),
    created_at: row.createdAt,
  });
  return {
    ...parsed,
    studioCursor: row.studioCursor == null ? null : String(row.studioCursor),
  };
}

function assertSameStoredEvent(
  stored: IntelligenceStoredTaskEvent,
  incoming: {
    eventId: string;
    studioCursor: string | null;
    type: TaskEvent['type'];
    status: TaskEvent['status'];
    payload: Pick<TaskEvent, 'progress' | 'error_code' | 'asset_ids'>;
  },
): void {
  const samePayload =
    JSON.stringify(publicEventPayload(stored)) === JSON.stringify(incoming.payload);
  if (
    stored.event_id !== incoming.eventId ||
    stored.studioCursor !== incoming.studioCursor ||
    stored.type !== incoming.type ||
    stored.status !== incoming.status ||
    !samePayload
  ) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
  }
}

function mapStudioEvent(taskId: string, event: StudioJobEvent): TaskEvent | null {
  const progress = safeProgress(event.payload.progress);
  const errorCode = safeErrorCode(event.payload.error_code ?? event.payload.code);
  const assetId = safeUuid(event.payload.asset_id);
  let type: TaskEvent['type'];
  let status: TaskEvent['status'];
  switch (event.type) {
    case 'queued':
      type = 'queued';
      status = 'queued';
      break;
    case 'claimed':
    case 'provider-submitted':
      type = 'running';
      status = 'running';
      break;
    case 'progress':
      if (progress === undefined) return null;
      type = 'progress';
      status = 'running';
      break;
    case 'retry-scheduled':
    case 'billing-settled':
      // These are durable Studio bookkeeping markers. Keep their source
      // cursor, but do not manufacture public progress or billing details.
      return null;
    case 'asset-created':
      if (assetId === undefined) return null;
      type = 'asset_created';
      status = 'running';
      break;
    case 'succeeded':
      type = 'succeeded';
      status = 'succeeded';
      break;
    case 'failed':
      type = 'failed';
      status = 'failed';
      break;
    case 'cancelled':
      type = 'cancelled';
      status = 'cancelled';
      break;
  }
  return TaskEventSchema.parse({
    protocol_version: 'intelligence.v1',
    event_id: event.event_id,
    task_id: taskId,
    sequence: 1,
    type,
    status,
    ...(progress !== undefined && type === 'progress' ? { progress } : {}),
    ...(errorCode !== undefined && (type === 'failed' || type === 'progress')
      ? { error_code: errorCode }
      : {}),
    ...(assetId !== undefined && type === 'asset_created' ? { asset_ids: [assetId] } : {}),
    created_at: safeDateTime(event.created_at),
  });
}

function publicEventPayload(event: TaskEvent) {
  return {
    ...(event.progress === undefined ? {} : { progress: event.progress }),
    ...(event.error_code === undefined ? {} : { error_code: event.error_code }),
    ...(event.asset_ids === undefined ? {} : { asset_ids: event.asset_ids }),
  };
}

function toPublicTaskEvent(event: IntelligenceStoredTaskEvent): TaskEvent {
  const { studioCursor: _studioCursor, ...publicEvent } = event;
  return TaskEventSchema.parse(publicEvent);
}

function parsePublicCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_VALIDATION_ERROR', 400);
  }
  return value;
}

function parseStudioCursor(cursor: string): number {
  if (!/^\d+$/.test(cursor)) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
  }
  return value;
}

function safeProgress(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  const parsed = StudioErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function safeUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

function safeDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new IntelligenceTaskServiceError('INTELLIGENCE_TASK_EVENTS_UNAVAILABLE', 503);
  }
  return date.toISOString();
}

function maxIsoDate(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function isTerminalStatus(status: IntelligenceTaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
