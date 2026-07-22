import { describe, expect, test } from 'bun:test';
import {
  type Database,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import { createPostgresApprovalService } from './approval-service';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const STEP_ID = '40000000-0000-4000-a000-000000000001';
const USER_ID = '50000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const EVENT_ID = '70000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const NOW = new Date('2026-07-23T10:00:00.000Z');
const APPROVAL_EXPIRES_AT = '2026-07-23T10:10:00.000Z';

type UpdateTarget = 'approval' | 'job' | 'step';
type InsertTarget = 'event';

type FakeState = {
  selections: unknown[][];
  selects: number;
  updates: Array<Record<string, unknown>>;
  updateTargets: UpdateTarget[];
  inserts: Array<Record<string, unknown>>;
  insertTargets: InsertTarget[];
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  updateReturning?: Partial<Record<UpdateTarget, unknown[]>>;
  failInsertTarget?: InsertTarget;
};

function awaitableQuery(result: unknown[], onRowLock?: () => void) {
  const query = Promise.resolve(result) as Promise<unknown[]> & {
    from(): typeof query;
    innerJoin(): typeof query;
    where(): typeof query;
    limit(): typeof query;
    for(): typeof query;
  };
  query.from = () => query;
  query.innerJoin = () => query;
  query.where = () => query;
  query.limit = () => query;
  query.for = () => {
    onRowLock?.();
    return query;
  };
  return query;
}

function fakeDatabase(
  selectionResults: unknown[][],
  options: FakeDatabaseOptions = {},
): { db: Database; state: FakeState } {
  const state: FakeState = {
    selections: [...selectionResults],
    selects: 0,
    updates: [],
    updateTargets: [],
    inserts: [],
    insertTargets: [],
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    rowLocks: 0,
  };
  const db = {
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      state.transactions += 1;
      const pendingUpdates: Array<{ target: UpdateTarget; values: Record<string, unknown> }> = [];
      const pendingInserts: Array<{ target: InsertTarget; values: Record<string, unknown> }> = [];
      const transaction = {
        select: () => {
          state.selects += 1;
          return awaitableQuery(state.selections.shift() ?? [], () => {
            state.rowLocks += 1;
          });
        },
        update: (table: unknown) => ({
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  returning: async () => {
                    const target: UpdateTarget =
                      table === automationApprovals
                        ? 'approval'
                        : table === automationJobs
                          ? 'job'
                          : table === automationJobSteps
                            ? 'step'
                            : (() => {
                                throw new Error('unexpected fake update target');
                              })();
                    const returning =
                      options.updateReturning?.[target] ??
                      (target === 'approval'
                        ? [{ approvalId: APPROVAL_ID }]
                        : target === 'job'
                          ? [{ jobId: JOB_ID }]
                          : [{ stepId: STEP_ID }]);
                    if (returning.length > 0) pendingUpdates.push({ target, values });
                    return returning;
                  },
                };
              },
            };
          },
        }),
        insert: (table: unknown) => ({
          values: async (values: Record<string, unknown>) => {
            if (table !== automationJobEvents) throw new Error('unexpected fake insert target');
            if (options.failInsertTarget === 'event') throw new Error('fake event insert failed');
            pendingInserts.push({ target: 'event', values });
          },
        }),
      };
      try {
        const result = await callback(transaction);
        state.updates.push(...pendingUpdates.map(({ values }) => values));
        state.updateTargets.push(...pendingUpdates.map(({ target }) => target));
        state.inserts.push(...pendingInserts.map(({ values }) => values));
        state.insertTargets.push(...pendingInserts.map(({ target }) => target));
        state.commits += 1;
        return result;
      } catch (error) {
        state.rollbacks += 1;
        throw error;
      }
    },
  } as unknown as Database;
  return { db, state };
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    status: 'pending',
    actingUserId: null,
    tokenHash: null,
    expiresAt: APPROVAL_EXPIRES_AT,
    resolvedAt: null,
    createdAt: '2026-07-23T09:59:00.000Z',
    ...overrides,
  };
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    actorUserId: USER_ID,
    status: 'awaiting_approval',
    leaseOwner: null,
    leaseExpiresAt: null,
    killSwitchGeneration: 7,
    deadlineAt: '2026-07-23T10:20:00.000Z',
    ...overrides,
  };
}

function resolveInput(decision: 'approve' | 'reject' = 'approve') {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    approvalId: APPROVAL_ID,
    actionHash: ACTION_HASH,
    actorUserId: USER_ID,
    decision,
  } as const;
}

describe('PostgreSQL execution approval resolution', () => {
  test('preserves default-disabled approval resolution without inspecting steps', async () => {
    const { db, state } = fakeDatabase([[approvalRow()], [jobRow()]]);
    let generationReads = 0;
    const service = createPostgresApprovalService(db, {
      now: () => NOW,
      currentGeneration: async () => {
        generationReads += 1;
        return 7;
      },
    });

    const resolved = await service.resolve(resolveInput());

    expect(resolved?.token).toMatch(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);
    expect(generationReads).toBe(1);
    expect(state.selects).toBe(2);
    expect(state.rowLocks).toBe(1);
    expect(state.updateTargets).toEqual(['approval']);
    expect(state.insertTargets).toEqual([]);
    expect(JSON.stringify(state.updates)).not.toContain(resolved?.token);
  });

  test('preserves ordinary approval resolution when durable handling is enabled', async () => {
    const { db, state } = fakeDatabase([
      [approvalRow()],
      [jobRow()],
      [
        {
          stepId: STEP_ID,
          sequence: 20,
          status: 'pending',
          actionHash: ACTION_HASH,
          approvalId: null,
        },
      ],
    ]);
    const service = createPostgresApprovalService(db, {
      now: () => NOW,
      currentGeneration: async () => 7,
      durableExecutionResolutionEnabled: true,
      newEventId: () => EVENT_ID,
    });

    const resolved = await service.resolve(resolveInput());

    expect(resolved?.token).toMatch(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);
    expect(state.selects).toBe(3);
    expect(state.rowLocks).toBe(3);
    expect(state.updateTargets).toEqual(['approval']);
    expect(state.insertTargets).toEqual([]);
  });

  test('fails closed when durable execution approval resolution is not composed', async () => {
    const { db, state } = fakeDatabase([
      [approvalRow()],
      [jobRow()],
      [
        {
          stepId: STEP_ID,
          sequence: 20,
          status: 'awaiting_approval',
          actionHash: ACTION_HASH,
          approvalId: APPROVAL_ID,
        },
      ],
    ]);
    let generationReads = 0;
    const service = createPostgresApprovalService(db, {
      now: () => NOW,
      currentGeneration: async () => {
        generationReads += 1;
        return 7;
      },
      durableExecutionResolutionEnabled: true,
      newEventId: () => EVENT_ID,
    });

    await expect(service.resolve(resolveInput())).rejects.toMatchObject({
      code: 'AUTOMATION_CONFLICT',
    });
    expect(generationReads).toBe(0);
    expect(state.selects).toBe(3);
    expect(state.updates).toEqual([]);
    expect(state.inserts).toEqual([]);
  });
});
