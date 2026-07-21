import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type Database, automationApprovals, automationJobSteps, automationJobs } from '@kortix/db';
import { type AutomationApproval, AutomationApprovalSchema } from '@kortix/intelligence-contracts';
import { and, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';

const UuidSchema = z.string().uuid();
const ActionHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ApprovalTokenSchema = z.string().regex(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);

export type ApprovalRequest = {
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  requestedByUserId: string;
  expiresAt: Date;
};

export type OneTimeApprovalToken = {
  token: string;
  approvalId: string;
  projectId: string;
  actionHash: `sha256:${string}`;
  expiresAt: string;
};

export interface ApprovalService {
  request(input: ApprovalRequest): Promise<AutomationApproval>;
  resolve(input: {
    accountId: string;
    projectId: string;
    approvalId: string;
    actionHash: `sha256:${string}`;
    actorUserId: string;
    decision: 'approve' | 'reject';
  }): Promise<OneTimeApprovalToken | null>;
  consume(input: {
    token: string;
    projectId: string;
    approvalId: string;
    actionHash: `sha256:${string}`;
    now: Date;
  }): Promise<boolean>;
}

export type ApprovalGenerationReader = (scope: {
  accountId: string;
  projectId: string;
}) => Promise<number>;

type ApprovalErrorCode =
  | 'AUTOMATION_INVALID_REQUEST'
  | 'AUTOMATION_NOT_FOUND'
  | 'AUTOMATION_FORBIDDEN'
  | 'AUTOMATION_CONFLICT'
  | 'AUTOMATION_APPROVAL_EXPIRED';

export class AutomationApprovalServiceError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AutomationApprovalServiceError';
  }
}

type StoredApprovalRecord = {
  approvalId: string;
  accountId: string;
  projectId: string;
  jobId: string;
  stepId: string;
  actionHash: `sha256:${string}`;
  requestedByUserId: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  actingUserId: string | null;
  tokenHash: `sha256:${string}` | null;
  expiresAt: string;
  resolvedAt: string | null;
  createdAt: string;
};

export class MemoryApprovalStore {
  readonly #records = new Map<string, StoredApprovalRecord>();

  get(approvalId: string): StoredApprovalRecord | undefined {
    return this.#records.get(approvalId);
  }

  set(record: StoredApprovalRecord): void {
    this.#records.set(record.approvalId, record);
  }

  snapshot(): readonly Readonly<StoredApprovalRecord>[] {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export function createMemoryApprovalStore(): MemoryApprovalStore {
  return new MemoryApprovalStore();
}

function validateRequest(input: ApprovalRequest, now: Date): ApprovalRequest {
  const parsed = z
    .object({
      accountId: UuidSchema,
      projectId: UuidSchema,
      jobId: UuidSchema,
      stepId: UuidSchema,
      actionHash: ActionHashSchema,
      requestedByUserId: UuidSchema,
      expiresAt: z.date(),
    })
    .strict()
    .parse(input) as ApprovalRequest;
  if (parsed.expiresAt.getTime() <= now.getTime()) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_INVALID_REQUEST',
      'Approval expiry must be in the future',
    );
  }
  return parsed;
}

function issueRawToken(): string {
  return `approval.v1.${randomBytes(32).toString('base64url')}`;
}

function boundTokenHash(input: {
  token: string;
  approvalId: string;
  projectId: string;
  actionHash: string;
  expiresAt: string;
  generation: number;
}): `sha256:${string}` {
  const digest = createHash('sha256')
    .update(
      [
        input.token,
        input.approvalId,
        input.projectId,
        input.actionHash,
        input.expiresAt,
        input.generation,
      ].join('\0'),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

function hashesEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function toAutomationApproval(record: StoredApprovalRecord): AutomationApproval {
  return AutomationApprovalSchema.parse({
    approval_id: record.approvalId,
    job_id: record.jobId,
    step_id: record.stepId,
    project_id: record.projectId,
    action_hash: record.actionHash,
    status: record.status,
    acting_user_id: record.actingUserId,
    expires_at: record.expiresAt,
    resolved_at: record.resolvedAt,
  });
}

function notFound(): AutomationApprovalServiceError {
  return new AutomationApprovalServiceError('AUTOMATION_NOT_FOUND', 'Approval was not found');
}

function assertResolvable(
  record: StoredApprovalRecord,
  input: {
    accountId: string;
    projectId: string;
    actionHash: string;
    actorUserId: string;
  },
  now: Date,
): void {
  if (record.accountId !== input.accountId || record.projectId !== input.projectId) {
    throw notFound();
  }
  if (record.actionHash !== input.actionHash) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval action hash does not match',
    );
  }
  if (record.requestedByUserId !== input.actorUserId) {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_FORBIDDEN',
      'Approval actor does not match the requesting user',
    );
  }
  if (record.status !== 'pending') {
    throw new AutomationApprovalServiceError(
      'AUTOMATION_CONFLICT',
      'Approval is no longer pending',
    );
  }
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    throw new AutomationApprovalServiceError('AUTOMATION_APPROVAL_EXPIRED', 'Approval has expired');
  }
}

export function createMemoryApprovalService(options?: {
  store?: MemoryApprovalStore;
  now?: () => Date;
  currentGeneration?: ApprovalGenerationReader;
}): ApprovalService {
  const store = options?.store ?? createMemoryApprovalStore();
  const now = options?.now ?? (() => new Date());
  const currentGeneration = options?.currentGeneration ?? (async () => 0);

  return {
    async request(requestInput) {
      const input = validateRequest(requestInput, now());
      const createdAt = now().toISOString();
      const record: StoredApprovalRecord = {
        approvalId: randomUUID(),
        accountId: input.accountId,
        projectId: input.projectId,
        jobId: input.jobId,
        stepId: input.stepId,
        actionHash: input.actionHash,
        requestedByUserId: input.requestedByUserId,
        status: 'pending',
        actingUserId: null,
        tokenHash: null,
        expiresAt: input.expiresAt.toISOString(),
        resolvedAt: null,
        createdAt,
      };
      store.set(record);
      return toAutomationApproval(record);
    },

    async resolve(input) {
      const record = store.get(input.approvalId);
      if (!record) throw notFound();
      const resolvedAt = now();
      assertResolvable(record, input, resolvedAt);

      if (input.decision === 'reject') {
        record.status = 'rejected';
        record.actingUserId = input.actorUserId;
        record.resolvedAt = resolvedAt.toISOString();
        return null;
      }

      const generation = await currentGeneration({
        accountId: record.accountId,
        projectId: record.projectId,
      });
      const token = issueRawToken();
      record.status = 'approved';
      record.actingUserId = input.actorUserId;
      record.resolvedAt = resolvedAt.toISOString();
      record.tokenHash = boundTokenHash({
        token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
        generation,
      });
      return {
        token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
      };
    },

    async consume(input) {
      if (!ApprovalTokenSchema.safeParse(input.token).success) return false;
      const record = store.get(input.approvalId);
      if (
        !record ||
        record.projectId !== input.projectId ||
        record.actionHash !== input.actionHash ||
        record.status !== 'approved' ||
        record.tokenHash === null ||
        Date.parse(record.expiresAt) <= Math.max(input.now.getTime(), now().getTime())
      ) {
        return false;
      }
      const generation = await currentGeneration({
        accountId: record.accountId,
        projectId: record.projectId,
      });
      const candidateHash = boundTokenHash({
        token: input.token,
        approvalId: record.approvalId,
        projectId: record.projectId,
        actionHash: record.actionHash,
        expiresAt: record.expiresAt,
        generation,
      });
      if (!hashesEqual(candidateHash, record.tokenHash)) return false;

      record.status = 'consumed';
      return true;
    },
  };
}

function rowToApproval(
  row: typeof automationApprovals.$inferSelect,
  projectId: string,
): AutomationApproval {
  return AutomationApprovalSchema.parse({
    approval_id: row.approvalId,
    job_id: row.jobId,
    step_id: row.stepId,
    project_id: projectId,
    action_hash: row.actionHash,
    status: row.status,
    acting_user_id: row.actingUserId,
    expires_at: row.expiresAt,
    resolved_at: row.resolvedAt,
  });
}

export function createPostgresApprovalService(
  db: Database,
  options?: {
    now?: () => Date;
    currentGeneration?: ApprovalGenerationReader;
  },
): ApprovalService {
  const now = options?.now ?? (() => new Date());
  const currentGeneration = options?.currentGeneration ?? (async () => 0);

  return {
    async request(requestInput) {
      const input = validateRequest(requestInput, now());
      const [scope] = await db
        .select({ actorUserId: automationJobs.actorUserId })
        .from(automationJobs)
        .innerJoin(
          automationJobSteps,
          and(
            eq(automationJobSteps.jobId, automationJobs.jobId),
            eq(automationJobSteps.stepId, input.stepId),
          ),
        )
        .where(
          and(
            eq(automationJobs.accountId, input.accountId),
            eq(automationJobs.projectId, input.projectId),
            eq(automationJobs.jobId, input.jobId),
            eq(automationJobSteps.actionHash, input.actionHash),
          ),
        )
        .limit(1);
      if (!scope) throw notFound();
      if (scope.actorUserId !== input.requestedByUserId) {
        throw new AutomationApprovalServiceError(
          'AUTOMATION_FORBIDDEN',
          'Approval requester does not own the job action',
        );
      }

      const [created] = await db
        .insert(automationApprovals)
        .values({
          approvalId: randomUUID(),
          jobId: input.jobId,
          stepId: input.stepId,
          actionHash: input.actionHash,
          status: 'pending',
          expiresAt: input.expiresAt.toISOString(),
          createdAt: now().toISOString(),
        })
        .returning();
      if (!created) throw new Error('Approval insert returned no row');
      return rowToApproval(created, input.projectId);
    },

    async resolve(input) {
      return db.transaction(async (tx) => {
        const [approval] = await tx
          .select()
          .from(automationApprovals)
          .where(eq(automationApprovals.approvalId, input.approvalId))
          .limit(1)
          .for('update');
        if (!approval) throw notFound();
        const [job] = await tx
          .select({
            accountId: automationJobs.accountId,
            projectId: automationJobs.projectId,
            actorUserId: automationJobs.actorUserId,
          })
          .from(automationJobs)
          .where(eq(automationJobs.jobId, approval.jobId))
          .limit(1);
        if (!job) throw notFound();

        const record: StoredApprovalRecord = {
          approvalId: approval.approvalId,
          accountId: job.accountId,
          projectId: job.projectId,
          jobId: approval.jobId,
          stepId: approval.stepId,
          actionHash: approval.actionHash as `sha256:${string}`,
          requestedByUserId: job.actorUserId,
          status: approval.status,
          actingUserId: approval.actingUserId,
          tokenHash: approval.tokenHash as `sha256:${string}` | null,
          expiresAt: approval.expiresAt,
          resolvedAt: approval.resolvedAt,
          createdAt: approval.createdAt,
        };
        const resolvedAt = now();
        assertResolvable(record, input, resolvedAt);

        if (input.decision === 'reject') {
          const [updated] = await tx
            .update(automationApprovals)
            .set({
              status: 'rejected',
              actingUserId: input.actorUserId,
              resolvedAt: resolvedAt.toISOString(),
            })
            .where(
              and(
                eq(automationApprovals.approvalId, approval.approvalId),
                eq(automationApprovals.status, 'pending'),
                gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
              ),
            )
            .returning({ approvalId: automationApprovals.approvalId });
          if (!updated) {
            throw new AutomationApprovalServiceError(
              'AUTOMATION_APPROVAL_EXPIRED',
              'Approval has expired',
            );
          }
          return null;
        }

        const generation = await currentGeneration({
          accountId: job.accountId,
          projectId: job.projectId,
        });
        const token = issueRawToken();
        const tokenHash = boundTokenHash({
          token,
          approvalId: approval.approvalId,
          projectId: job.projectId,
          actionHash: approval.actionHash,
          expiresAt: approval.expiresAt,
          generation,
        });
        const [updated] = await tx
          .update(automationApprovals)
          .set({
            status: 'approved',
            actingUserId: input.actorUserId,
            tokenHash,
            resolvedAt: resolvedAt.toISOString(),
          })
          .where(
            and(
              eq(automationApprovals.approvalId, approval.approvalId),
              eq(automationApprovals.status, 'pending'),
              gt(automationApprovals.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ approvalId: automationApprovals.approvalId });
        if (!updated) {
          throw new AutomationApprovalServiceError(
            'AUTOMATION_APPROVAL_EXPIRED',
            'Approval has expired',
          );
        }
        return {
          token,
          approvalId: approval.approvalId,
          projectId: job.projectId,
          actionHash: approval.actionHash as `sha256:${string}`,
          expiresAt: approval.expiresAt,
        };
      });
    },

    async consume(input) {
      if (!ApprovalTokenSchema.safeParse(input.token).success) return false;
      return db.transaction(async (tx) => {
        const [approval] = await tx
          .select()
          .from(automationApprovals)
          .where(eq(automationApprovals.approvalId, input.approvalId))
          .limit(1)
          .for('update');
        if (!approval || approval.status !== 'approved' || approval.tokenHash === null) {
          return false;
        }
        const [job] = await tx
          .select({
            accountId: automationJobs.accountId,
            projectId: automationJobs.projectId,
          })
          .from(automationJobs)
          .where(eq(automationJobs.jobId, approval.jobId))
          .limit(1);
        if (!job || job.projectId !== input.projectId || approval.actionHash !== input.actionHash) {
          return false;
        }

        const generation = await currentGeneration(job);
        const candidateHash = boundTokenHash({
          token: input.token,
          approvalId: approval.approvalId,
          projectId: job.projectId,
          actionHash: approval.actionHash,
          expiresAt: approval.expiresAt,
          generation,
        });
        if (!hashesEqual(candidateHash, approval.tokenHash)) return false;

        const [consumed] = await tx
          .update(automationApprovals)
          .set({ status: 'consumed' })
          .where(
            and(
              eq(automationApprovals.approvalId, approval.approvalId),
              eq(automationApprovals.status, 'approved'),
              eq(automationApprovals.tokenHash, candidateHash),
              gt(
                automationApprovals.expiresAt,
                sql`GREATEST(clock_timestamp(), ${input.now.toISOString()}::timestamptz)`,
              ),
            ),
          )
          .returning({ approvalId: automationApprovals.approvalId });
        return consumed !== undefined;
      });
    },
  };
}
