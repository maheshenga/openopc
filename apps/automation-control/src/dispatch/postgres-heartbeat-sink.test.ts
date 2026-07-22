import { describe, expect, test } from 'bun:test';
import { type Database, automationJobSteps, automationJobs } from '@kortix/db';
import { automationLeaseOwnerPrefix } from '../lease-manager';
import { createPostgresHeartbeatEventSink } from './postgres-heartbeat-sink';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const EVIDENCE_REFERENCE = 'evidence:60000000-0000-4000-a000-000000000001';
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

type FakeState = {
  selections: unknown[][];
  inserts: Array<Record<string, unknown>>;
  updates: Array<Record<string, unknown>>;
  updateTargets: UpdateTarget[];
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  failInsert?: boolean;
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
      const pendingInserts: Array<Record<string, unknown>> = [];
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
        insert: () => ({
          values: async (values: Record<string, unknown>) => {
            if (options.failInsert) throw new Error('fake event insert failed');
            pendingInserts.push(values);
          },
        }),
      };
      try {
        const result = await callback(transaction);
        state.inserts.push(...pendingInserts);
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
      expect(state.inserts).toHaveLength(0);
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
    expect(state.inserts).toHaveLength(0);
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
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
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

  test('fails closed on success until durable validation is wired', async () => {
    const events = [{ type: 'job_succeeded' as const, payload: {}, trace_id: null }];

    for (const event of events) {
      const { db, state } = fakeDatabase([]);
      await expect(
        createPostgresHeartbeatEventSink(db).append({ ...heartbeatInput(), event }),
      ).resolves.toEqual({ accepted: false, reason: 'semantic_mismatch' });
      expect(state.transactions).toBe(0);
      expect(state.inserts).toHaveLength(0);
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
          action_hash: `sha256:${'a'.repeat(64)}`,
        },
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
