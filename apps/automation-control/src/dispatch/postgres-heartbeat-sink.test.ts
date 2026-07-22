import { describe, expect, test } from 'bun:test';
import {
  type Database,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import { automationLeaseOwnerPrefix } from '../lease-manager';
import { createPostgresHeartbeatEventSink } from './postgres-heartbeat-sink';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const PREVIOUS_STEP_ID = '50000000-0000-4000-a000-000000000002';
const NEXT_STEP_ID = '50000000-0000-4000-a000-000000000003';
const EVIDENCE_REFERENCE = 'evidence:60000000-0000-4000-a000-000000000001';
const APPROVAL_ID = '70000000-0000-4000-a000-000000000001';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const PREVIOUS_HASH = `sha256:${'b'.repeat(64)}` as const;
const NEXT_HASH = `sha256:${'c'.repeat(64)}` as const;
const NOW = new Date('2026-07-22T10:00:00.000Z');

const BINDING = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  jobId: JOB_ID,
  leaseId: LEASE_ID,
  owner: `browser-worker-1:${LEASE_ID}`,
  killSwitchGeneration: 7,
} as const;

type UpdateTarget = 'job' | 'step';
type InsertTarget = 'approval' | 'event';

type FakeState = {
  selections: unknown[][];
  inserts: Array<Record<string, unknown>>;
  insertTargets: InsertTarget[];
  updates: Array<Record<string, unknown>>;
  updateTargets: UpdateTarget[];
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  failInsert?: boolean;
  failInsertTarget?: InsertTarget;
  updateReturning?: Partial<Record<UpdateTarget, unknown[]>>;
};

function awaitableQuery(result: unknown[], onRowLock?: () => void) {
  const query = Promise.resolve(result) as Promise<unknown[]> & {
    from(): typeof query;
    where(): typeof query;
    limit(): typeof query;
    for(): typeof query;
  };
  query.from = () => query;
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
    inserts: [],
    insertTargets: [],
    updates: [],
    updateTargets: [],
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    rowLocks: 0,
  };
  const db = {
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      state.transactions += 1;
      const pendingInserts: Array<{ target: InsertTarget; values: Record<string, unknown> }> = [];
      const pendingUpdates: Array<{ target: UpdateTarget; values: Record<string, unknown> }> = [];
      const transaction = {
        select: () =>
          awaitableQuery(state.selections.shift() ?? [], () => {
            state.rowLocks += 1;
          }),
        update: (table: unknown) => ({
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  returning: async () => {
                    const target: UpdateTarget =
                      table === automationJobSteps
                        ? 'step'
                        : table === automationJobs
                          ? 'job'
                          : (() => {
                              throw new Error('unexpected fake update target');
                            })();
                    const returning =
                      options.updateReturning?.[target] ??
                      (target === 'step' ? [{ stepId: STEP_ID }] : [{ jobId: JOB_ID }]);
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
            const target: InsertTarget =
              table === automationApprovals
                ? 'approval'
                : table === automationJobEvents
                  ? 'event'
                  : (() => {
                      throw new Error('unexpected fake insert target');
                    })();
            if (options.failInsert || options.failInsertTarget === target) {
              throw new Error(`fake ${target} insert failed`);
            }
            pendingInserts.push({ target, values });
          },
        }),
      };
      try {
        const result = await callback(transaction);
        state.inserts.push(...pendingInserts.map(({ values }) => values));
        state.insertTargets.push(...pendingInserts.map(({ target }) => target));
        state.updates.push(...pendingUpdates.map(({ values }) => values));
        state.updateTargets.push(...pendingUpdates.map(({ target }) => target));
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

function heartbeatInput(ordinal = 1) {
  return {
    binding: BINDING,
    workerId: 'browser-worker-1',
    workerOrdinal: ordinal,
    observedAt: NOW,
    event: {
      type: 'heartbeat' as const,
      payload: { last_completed_step: 0 },
      trace_id: null,
    },
  };
}

describe('PostgreSQL heartbeat event sink', () => {
  test('locks the scoped job and atomically records sequence plus lease-scoped worker ordinal', async () => {
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 0 }],
      [{ value: 4 }],
    ]);
    const sink = createPostgresHeartbeatEventSink(db);

    const result = await sink.append(heartbeatInput());

    expect(result).toMatchObject({
      accepted: true,
      event: { job_id: JOB_ID, sequence: 5, type: 'heartbeat', status: null },
    });
    expect(state.transactions).toBe(1);
    expect(state.rowLocks).toBe(1);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        jobId: JOB_ID,
        sequence: 5,
        workerId: 'browser-worker-1',
        workerLeaseId: LEASE_ID,
        workerOrdinal: 1,
      }),
    ]);
  });

  test('rejects replayed or skipped ordinals without changing job or event state', async () => {
    for (const ordinal of [1, 3]) {
      const { db, state } = fakeDatabase([[{ jobId: JOB_ID, status: 'running' }], [{ value: 1 }]]);

      await expect(
        createPostgresHeartbeatEventSink(db).append(heartbeatInput(ordinal)),
      ).resolves.toEqual({ accepted: false, reason: 'replayed_ordinal' });
      expect(state.updates).toHaveLength(0);
      expect(state.updateTargets).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
      expect(state.rowLocks).toBe(1);
    }
  });

  test('rejects a stale durable lease before reading or consuming the worker ordinal', async () => {
    const { db, state } = fakeDatabase([[]]);

    await expect(createPostgresHeartbeatEventSink(db).append(heartbeatInput())).resolves.toEqual({
      accepted: false,
      reason: 'stale_lease',
    });
    expect(state.selections).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
    expect(state.updateTargets).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.rowLocks).toBe(1);
  });

  test('accepts the lease-manager owner form when a long worker id is hashed for storage', async () => {
    const workerId = `browser-worker-${'a'.repeat(100)}`;
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 0 }],
      [{ value: 2 }],
    ]);
    const input = {
      ...heartbeatInput(),
      binding: {
        ...BINDING,
        owner: `${automationLeaseOwnerPrefix(workerId)}:${LEASE_ID}`,
      },
      workerId,
    };

    const result = await createPostgresHeartbeatEventSink(db).append(input);

    expect(result).toMatchObject({ accepted: true, event: { sequence: 3 } });
    expect(state.inserts).toEqual([
      expect.objectContaining({ workerId, workerLeaseId: LEASE_ID, workerOrdinal: 1 }),
    ]);
  });

  test('rejects a different long worker identity even when the first 91 characters match', async () => {
    const sharedPrefix = `browser-worker-${'a'.repeat(100)}`;
    const assignedWorkerId = `${sharedPrefix}1`;
    const collidingWorkerId = `${sharedPrefix}2`;
    const { db, state } = fakeDatabase([]);
    const input = {
      ...heartbeatInput(),
      binding: {
        ...BINDING,
        owner: `${automationLeaseOwnerPrefix(assignedWorkerId)}:${LEASE_ID}`,
      },
      workerId: collidingWorkerId,
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
      accepted: false,
      reason: 'stale_lease',
    });
    expect(state.transactions).toBe(0);
  });

  test('leaves the ordinal unused when the event cannot transition the current job', async () => {
    const { db, state } = fakeDatabase([[{ jobId: JOB_ID, status: 'dispatched' }], [{ value: 0 }]]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'job_failed' as const,
        payload: { cleanup_error_count: 0, project_id: PROJECT_ID },
        trace_id: null,
      },
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
      accepted: false,
      reason: 'semantic_mismatch',
    });
    expect(state.transactions).toBe(1);
    expect(state.updates).toHaveLength(0);
    expect(state.updateTargets).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.rowLocks).toBe(1);
  });

  test('updates the job and event in the same transaction for a valid terminal worker failure', async () => {
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 0 }],
      [{ value: 9 }],
    ]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'job_failed' as const,
        payload: { cleanup_error_count: 0, project_id: PROJECT_ID },
        trace_id: null,
      },
    };

    const result = await createPostgresHeartbeatEventSink(db).append(input);

    expect(result).toMatchObject({
      accepted: true,
      event: { sequence: 10, type: 'job_failed', status: 'failed' },
    });
    expect(state.updates).toEqual([
      expect.objectContaining({
        status: 'failed',
        leaseOwner: null,
        leaseExpiresAt: null,
        terminalAt: NOW.toISOString(),
      }),
    ]);
    expect(state.inserts).toHaveLength(1);
  });

  test('atomically starts a pending step and records the worker event', async () => {
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 0 }],
      [{ stepId: STEP_ID, status: 'pending' }],
      [{ value: 4 }],
    ]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'step_started' as const,
        payload: { step_id: STEP_ID },
        trace_id: null,
      },
    };

    const result = await createPostgresHeartbeatEventSink(db).append(input);

    expect(result).toMatchObject({
      accepted: true,
      event: { type: 'step_started', status: 'running', sequence: 5 },
    });
    expect(state.updateTargets).toEqual(['step']);
    expect(state.updates).toEqual([
      expect.objectContaining({ status: 'running', startedAt: NOW.toISOString() }),
    ]);
    expect(state.inserts).toHaveLength(1);
    expect(state.commits).toBe(1);
  });

  test('rejects an unknown or non-pending step without committing state', async () => {
    for (const stepRows of [
      [],
      [{ stepId: STEP_ID, status: 'running' }],
      [{ stepId: STEP_ID, status: 'succeeded' }],
    ]) {
      const { db, state } = fakeDatabase([
        [{ jobId: JOB_ID, status: 'running' }],
        [{ value: 0 }],
        stepRows,
      ]);
      const input = {
        ...heartbeatInput(),
        event: {
          type: 'step_started' as const,
          payload: { step_id: STEP_ID },
          trace_id: null,
        },
      };

      await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
        accepted: false,
        reason: 'semantic_mismatch',
      });
      expect(state.updateTargets).toHaveLength(0);
      expect(state.updates).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
    }
  });

  test('rejects a step start when its conditional update no longer matches', async () => {
    const { db, state } = fakeDatabase(
      [
        [{ jobId: JOB_ID, status: 'running' }],
        [{ value: 0 }],
        [{ stepId: STEP_ID, status: 'pending' }],
      ],
      { updateReturning: { step: [] } },
    );
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'step_started' as const,
        payload: { step_id: STEP_ID },
        trace_id: null,
      },
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
      accepted: false,
      reason: 'semantic_mismatch',
    });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  test('rolls back a step update when the worker event insert fails', async () => {
    const { db, state } = fakeDatabase(
      [
        [{ jobId: JOB_ID, status: 'running' }],
        [{ value: 0 }],
        [{ stepId: STEP_ID, status: 'pending' }],
        [{ value: 4 }],
      ],
      { failInsert: true },
    );
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'step_started' as const,
        payload: { step_id: STEP_ID },
        trace_id: null,
      },
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).rejects.toThrow(
      'fake event insert failed',
    );
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.commits).toBe(0);
    expect(state.rollbacks).toBe(1);
  });

  test('atomically completes a running step with its evidence reference', async () => {
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 1 }],
      [{ stepId: STEP_ID, status: 'running' }],
      [{ value: 5 }],
    ]);
    const input = {
      ...heartbeatInput(2),
      event: {
        type: 'step_completed' as const,
        payload: { step_id: STEP_ID, evidence_reference: EVIDENCE_REFERENCE },
        trace_id: null,
      },
    };

    const result = await createPostgresHeartbeatEventSink(db).append(input);

    expect(result).toMatchObject({
      accepted: true,
      event: { type: 'step_completed', status: 'running', sequence: 6 },
    });
    expect(state.updateTargets).toEqual(['step']);
    expect(state.updates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        endedAt: NOW.toISOString(),
        resultRef: EVIDENCE_REFERENCE,
      }),
    ]);
    expect(state.inserts).toHaveLength(1);
  });

  test('rejects an unknown or non-running step completion without committing state', async () => {
    for (const stepRows of [
      [],
      [{ stepId: STEP_ID, status: 'pending' }],
      [{ stepId: STEP_ID, status: 'succeeded' }],
    ]) {
      const { db, state } = fakeDatabase([
        [{ jobId: JOB_ID, status: 'running' }],
        [{ value: 0 }],
        stepRows,
      ]);
      const input = {
        ...heartbeatInput(),
        event: {
          type: 'step_completed' as const,
          payload: { step_id: STEP_ID, evidence_reference: EVIDENCE_REFERENCE },
          trace_id: null,
        },
      };

      await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
        accepted: false,
        reason: 'semantic_mismatch',
      });
      expect(state.updateTargets).toHaveLength(0);
      expect(state.updates).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
    }
  });

  test('succeeds the job only after locking and verifying every step', async () => {
    const { db, state } = fakeDatabase([
      [{ jobId: JOB_ID, status: 'running' }],
      [{ value: 2 }],
      [
        { stepId: STEP_ID, sequence: 1, status: 'succeeded' },
        {
          stepId: '50000000-0000-4000-a000-000000000002',
          sequence: 2,
          status: 'succeeded',
        },
      ],
      [{ value: 6 }],
    ]);
    const input = {
      ...heartbeatInput(3),
      event: { type: 'job_succeeded' as const, payload: {}, trace_id: null },
    };

    const result = await createPostgresHeartbeatEventSink(db).append(input);

    expect(result).toMatchObject({
      accepted: true,
      event: { type: 'job_succeeded', status: 'succeeded', sequence: 7 },
    });
    expect(state.updateTargets).toEqual(['job']);
    expect(state.updates).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        terminalAt: NOW.toISOString(),
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    ]);
    expect(state.rowLocks).toBe(2);
    expect(state.inserts).toHaveLength(1);
  });

  test('rejects job success when the step set is empty or incomplete', async () => {
    const invalidStepSets = [
      [],
      [{ stepId: STEP_ID, sequence: 1, status: 'pending' }],
      [{ stepId: STEP_ID, sequence: 1, status: 'running' }],
      [
        { stepId: STEP_ID, sequence: 1, status: 'succeeded' },
        {
          stepId: '50000000-0000-4000-a000-000000000002',
          sequence: 2,
          status: 'running',
        },
      ],
    ];

    for (const stepRows of invalidStepSets) {
      const { db, state } = fakeDatabase([
        [{ jobId: JOB_ID, status: 'running' }],
        [{ value: 0 }],
        stepRows,
      ]);
      const input = {
        ...heartbeatInput(),
        event: { type: 'job_succeeded' as const, payload: {}, trace_id: null },
      };

      await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
        accepted: false,
        reason: 'semantic_mismatch',
      });
      expect(state.updateTargets).toHaveLength(0);
      expect(state.updates).toHaveLength(0);
      expect(state.inserts).toHaveLength(0);
      expect(state.rowLocks).toBe(2);
    }
  });

  test('fails closed without consuming the ordinal when worker approval resume is not durable', async () => {
    const { db, state } = fakeDatabase([[{ jobId: JOB_ID, status: 'running' }], [{ value: 0 }]]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'approval_required' as const,
        payload: {
          step_id: '50000000-0000-4000-a000-000000000001',
          action_hash: ACTION_HASH,
        },
        trace_id: null,
      },
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
      accepted: false,
      reason: 'semantic_mismatch',
    });
    expect(state.transactions).toBe(0);
    expect(state.updates).toHaveLength(0);
    expect(state.updateTargets).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(state.rowLocks).toBe(0);
  });

  test('validates durable approval pause TTL bounds at construction', () => {
    const { db } = fakeDatabase([]);

    expect(() =>
      createPostgresHeartbeatEventSink(db, {
        durableApprovalPauseEnabled: true,
        approvalTtlMs: 59_999,
      }),
    ).toThrow();
    expect(() =>
      createPostgresHeartbeatEventSink(db, {
        durableApprovalPauseEnabled: true,
        approvalTtlMs: 3_600_001,
      }),
    ).toThrow();
    expect(() =>
      createPostgresHeartbeatEventSink(db, {
        durableApprovalPauseEnabled: true,
        approvalTtlMs: 600_000,
      }),
    ).not.toThrow();
  });

  test('projects enabled worker approval into a lease-fenced transaction', async () => {
    const { db, state } = fakeDatabase([
      [
        {
          jobId: JOB_ID,
          status: 'running',
          deadlineAt: '2026-07-22T10:30:00.000Z',
          deadlineCurrent: true,
        },
      ],
      [{ value: 0 }],
    ]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'approval_required' as const,
        payload: { step_id: STEP_ID, action_hash: ACTION_HASH },
        trace_id: null,
      },
    };

    await expect(
      createPostgresHeartbeatEventSink(db, {
        durableApprovalPauseEnabled: true,
        approvalTtlMs: 600_000,
        newApprovalId: () => APPROVAL_ID,
      }).append(input),
    ).resolves.toEqual({ accepted: false, reason: 'semantic_mismatch' });
    expect(state.transactions).toBe(1);
    expect(state.rowLocks).toBe(2);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  test('atomically pauses a valid browser step and creates its durable approval', async () => {
    const { db, state } = fakeDatabase([
      [
        {
          jobId: JOB_ID,
          status: 'running',
          deadlineAt: '2026-07-22T10:30:00.000Z',
          deadlineCurrent: true,
        },
      ],
      [{ value: 0 }],
      [
        {
          stepId: PREVIOUS_STEP_ID,
          sequence: 10,
          status: 'succeeded',
          risk: 'observe',
          actionHash: PREVIOUS_HASH,
          approvalId: null,
        },
        {
          stepId: STEP_ID,
          sequence: 20,
          status: 'pending',
          risk: 'operate',
          actionHash: ACTION_HASH,
          approvalId: null,
        },
        {
          stepId: NEXT_STEP_ID,
          sequence: 30,
          status: 'pending',
          risk: 'observe',
          actionHash: NEXT_HASH,
          approvalId: null,
        },
      ],
      [{ value: 4 }],
    ]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'approval_required' as const,
        payload: { step_id: STEP_ID, action_hash: ACTION_HASH },
        trace_id: null,
      },
    };

    const result = await createPostgresHeartbeatEventSink(db, {
      durableApprovalPauseEnabled: true,
      approvalTtlMs: 600_000,
      newApprovalId: () => APPROVAL_ID,
    }).append(input);

    expect(result).toMatchObject({
      accepted: true,
      event: {
        job_id: JOB_ID,
        sequence: 5,
        type: 'approval_required',
        status: 'awaiting_approval',
        payload: {
          step_id: STEP_ID,
          action_hash: ACTION_HASH,
          approval_id: APPROVAL_ID,
          expires_at: '2026-07-22T10:10:00.000Z',
          resume_after_sequence: 10,
        },
      },
    });
    expect(state.transactions).toBe(1);
    expect(state.commits).toBe(1);
    expect(state.rollbacks).toBe(0);
    expect(state.rowLocks).toBe(2);
    expect(state.updateTargets).toEqual(['step', 'job']);
    expect(state.insertTargets).toEqual(['approval', 'event']);
    expect(state.updates[0]).toMatchObject({
      status: 'awaiting_approval',
      approvalId: APPROVAL_ID,
    });
    expect(state.updates[1]).toMatchObject({
      status: 'awaiting_approval',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(state.inserts[0]).toMatchObject({
      approvalId: APPROVAL_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      actionHash: ACTION_HASH,
      status: 'pending',
      expiresAt: '2026-07-22T10:10:00.000Z',
      createdAt: NOW.toISOString(),
    });
    expect(state.inserts[1]).toMatchObject({
      jobId: JOB_ID,
      sequence: 5,
      type: 'approval_required',
      status: 'awaiting_approval',
      workerId: 'browser-worker-1',
      workerLeaseId: LEASE_ID,
      workerOrdinal: 1,
      payload: {
        step_id: STEP_ID,
        action_hash: ACTION_HASH,
        approval_id: APPROVAL_ID,
        expires_at: '2026-07-22T10:10:00.000Z',
        resume_after_sequence: 10,
      },
    });
  });

  test('rejects worker payload project substitution as a semantic mismatch', async () => {
    const { db, state } = fakeDatabase([]);
    const input = {
      ...heartbeatInput(),
      event: {
        type: 'job_failed' as const,
        payload: {
          cleanup_error_count: 0,
          project_id: '20000000-0000-4000-a000-000000000099',
        },
        trace_id: null,
      },
    };

    await expect(createPostgresHeartbeatEventSink(db).append(input)).resolves.toEqual({
      accepted: false,
      reason: 'semantic_mismatch',
    });
    expect(state.transactions).toBe(0);
    expect(state.inserts).toHaveLength(0);
  });
});
