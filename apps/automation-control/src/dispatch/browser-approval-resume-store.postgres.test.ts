import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { type Database, automationApprovalResumeAttempts } from '@kortix/db';
import {
  type AutomationJob,
  type AutomationJobRequest,
  AutomationJobRequestSchema,
  AutomationJobSchema,
  type AutomationLease,
  AutomationLeaseSchema,
  canonicalAutomationRequestJson,
} from '@kortix/intelligence-contracts';
import {
  type BrowserApprovalResumeCandidate,
  createPostgresBrowserApprovalResumeStore,
} from './browser-approval-resume-store';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const USER_ID = '30000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const PREVIOUS_STEP_ID = '50000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000002';
const NEXT_STEP_ID = '50000000-0000-4000-a000-000000000003';
const APPROVAL_ID = '60000000-0000-4000-a000-000000000001';
const OTHER_APPROVAL_ID = '60000000-0000-4000-a000-000000000002';
const ATTEMPT_ID = '70000000-0000-4000-a000-000000000001';
const LEASE_ID = '80000000-0000-4000-a000-000000000001';
const OTHER_LEASE_ID = '80000000-0000-4000-a000-000000000002';
const PREVIOUS_HASH = `sha256:${'b'.repeat(64)}` as const;
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const NEXT_HASH = `sha256:${'c'.repeat(64)}` as const;
const NOW = new Date('2099-07-23T08:00:00.000Z');
const APPROVAL_EXPIRES_AT = '2099-07-23T08:04:00.000Z';
const LEASE_EXPIRES_AT = '2099-07-23T08:03:00.000Z';
const JOB_DEADLINE_AT = '2099-07-23T08:05:00.000Z';
const TOKEN_PEPPER = 'resume-token-pepper-with-at-least-32-bytes';

type FakeState = {
  selections: unknown[][];
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
  updates: Array<{ table: unknown; values: Record<string, unknown> }>;
  transactions: number;
  commits: number;
  rollbacks: number;
  rowLocks: number;
};

type FakeDatabaseOptions = {
  selections: unknown[][];
  failInsert?: boolean;
  updateReturning?: unknown[];
};

function awaitableQuery(result: unknown[], onRowLock?: () => void) {
  const query = Promise.resolve(result) as Promise<unknown[]> & {
    from(): typeof query;
    innerJoin(): typeof query;
    where(): typeof query;
    orderBy(): typeof query;
    limit(): typeof query;
    for(): typeof query;
  };
  query.from = () => query;
  query.innerJoin = () => query;
  query.where = () => query;
  query.orderBy = () => query;
  query.limit = () => query;
  query.for = () => {
    onRowLock?.();
    return query;
  };
  return query;
}

function fakeDatabase(options: FakeDatabaseOptions): { db: Database; state: FakeState } {
  const state: FakeState = {
    selections: [...options.selections],
    inserts: [],
    updates: [],
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    rowLocks: 0,
  };
  const select = () =>
    awaitableQuery(state.selections.shift() ?? [], () => {
      state.rowLocks += 1;
    });
  const db = {
    select,
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      state.transactions += 1;
      const pendingInserts: FakeState['inserts'] = [];
      const pendingUpdates: FakeState['updates'] = [];
      const tx = {
        select,
        update: (table: unknown) => ({
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  async returning() {
                    pendingUpdates.push({ table, values });
                    return options.updateReturning ?? [];
                  },
                };
              },
            };
          },
        }),
        insert: (table: unknown) => ({
          values(values: Record<string, unknown>) {
            return {
              async returning() {
                if (options.failInsert) throw new Error('fake attempt insert failed');
                pendingInserts.push({ table, values });
                return [{ attemptId: values.attemptId }];
              },
            };
          },
        }),
      };
      try {
        const result = await callback(tx);
        state.inserts.push(...pendingInserts);
        state.updates.push(...pendingUpdates);
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

function requestHash(request: AutomationJobRequest): `sha256:${string}` {
  return `sha256:${createHash('sha256')
    .update(canonicalAutomationRequestJson(request))
    .digest('hex')}`;
}

function browserRequest(): AutomationJobRequest {
  return AutomationJobRequestSchema.parse({
    protocol_version: 'automation.v1',
    tenant_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    source_run_id: null,
    execution_domain: 'browser',
    steps: [
      {
        step_id: PREVIOUS_STEP_ID,
        sequence: 1,
        action: 'browser.read',
        args: { selector: '#before' },
        risk: 'observe',
        action_hash: PREVIOUS_HASH,
      },
      {
        step_id: STEP_ID,
        sequence: 3,
        action: 'browser.submit',
        args: { selector: '#submit' },
        risk: 'external_effect',
        action_hash: ACTION_HASH,
      },
      {
        step_id: NEXT_STEP_ID,
        sequence: 4,
        action: 'browser.read',
        args: { selector: '#after' },
        risk: 'observe',
        action_hash: NEXT_HASH,
      },
    ],
    capability_requirements: [
      {
        capability: 'browser',
        methods: ['read', 'submit'],
        scope: { project_id: PROJECT_ID },
      },
    ],
    approval_policy: 'project-default',
    browser_policy: {
      allowed_origins: ['https://example.com'],
      network_mode: 'allowlist',
      open_network_expires_at: null,
      context: { mode: 'temporary', profile_id: null },
    },
    desktop_policy: null,
    idempotency_key: 'browser-resume-attempt-0001',
    deadline_at: JOB_DEADLINE_AT,
    traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
  });
}

function jobFixture(): AutomationJob {
  const request = browserRequest();
  return AutomationJobSchema.parse({
    job_id: JOB_ID,
    account_id: ACCOUNT_ID,
    actor_user_id: USER_ID,
    request,
    request_hash: requestHash(request),
    status: 'dispatched',
    policy_version: `sha256:${'d'.repeat(64)}`,
    kill_switch_generation: 7,
    created_at: '2099-07-23T07:55:00.000Z',
    updated_at: '2099-07-23T07:59:00.000Z',
    terminal_at: null,
  });
}

function jobRow(overrides: Record<string, unknown> = {}) {
  const job = jobFixture();
  return {
    jobId: job.job_id,
    accountId: job.account_id,
    projectId: job.request.project_id,
    actorUserId: job.actor_user_id,
    requestEnvelope: job.request,
    requestHash: job.request_hash,
    status: job.status,
    executionDomain: job.request.execution_domain,
    policySnapshotHash: job.policy_version,
    killSwitchGeneration: job.kill_switch_generation,
    leaseOwner: `browser-worker-1:${LEASE_ID}`,
    leaseExpiresAt: LEASE_EXPIRES_AT,
    cancelRequestedAt: null,
    deadlineAt: job.request.deadline_at,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    terminalAt: job.terminal_at,
    ...overrides,
  };
}

function approvalRow(overrides: Record<string, unknown> = {}) {
  return {
    approvalId: APPROVAL_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    status: 'approved',
    expiresAt: APPROVAL_EXPIRES_AT,
    ...overrides,
  };
}

function stepRows(overrides: Partial<Record<'previous' | 'target' | 'next', object>> = {}) {
  return [
    {
      stepId: PREVIOUS_STEP_ID,
      jobId: JOB_ID,
      sequence: 1,
      status: 'succeeded',
      actionHash: PREVIOUS_HASH,
      approvalId: null,
      ...overrides.previous,
    },
    {
      stepId: STEP_ID,
      jobId: JOB_ID,
      sequence: 3,
      status: 'pending',
      actionHash: ACTION_HASH,
      approvalId: APPROVAL_ID,
      ...overrides.target,
    },
    {
      stepId: NEXT_STEP_ID,
      jobId: JOB_ID,
      sequence: 4,
      status: 'pending',
      actionHash: NEXT_HASH,
      approvalId: null,
      ...overrides.next,
    },
  ];
}

function leaseFixture(overrides: Partial<AutomationLease> = {}): AutomationLease {
  const job = jobFixture();
  return AutomationLeaseSchema.parse({
    lease_id: LEASE_ID,
    job_id: JOB_ID,
    project_id: PROJECT_ID,
    execution_domain: 'browser',
    owner: `browser-worker-1:${LEASE_ID}`,
    permission_id: null,
    request_hash: job.request_hash,
    kill_switch_generation: 7,
    issued_at: '2099-07-23T07:59:30.000Z',
    expires_at: LEASE_EXPIRES_AT,
    signature: `hmac-sha256:${'e'.repeat(64)}`,
    ...overrides,
  });
}

function candidateFixture(overrides: Partial<BrowserApprovalResumeCandidate> = {}) {
  return {
    job: jobFixture(),
    approvalId: APPROVAL_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    resumeAfterSequence: 1,
    approvalExpiresAt: APPROVAL_EXPIRES_AT,
    ...overrides,
  } satisfies BrowserApprovalResumeCandidate;
}

function storeFor(options: FakeDatabaseOptions) {
  const fake = fakeDatabase(options);
  const observations: unknown[] = [];
  const store = createPostgresBrowserApprovalResumeStore(fake.db, {
    tokenPepper: TOKEN_PEPPER,
    newAttemptId: () => ATTEMPT_ID,
    randomBytes: (size) => Buffer.alloc(size),
    observe: (event) => observations.push(event),
  });
  return { ...fake, store, observations };
}

describe('PostgreSQL browser approval resume store issuance', () => {
  test('lists only approved pending Browser resume candidates in sequence order', async () => {
    const { store } = storeFor({
      selections: [[{ job: jobRow(), approval: approvalRow(), step: stepRows()[1] }], stepRows()],
    });

    const candidates = await store.listCandidates({ now: NOW, limit: 4 });

    expect(candidates).toEqual([
      expect.objectContaining({
        approvalId: APPROVAL_ID,
        stepId: STEP_ID,
        actionHash: ACTION_HASH,
        resumeAfterSequence: 1,
        approvalExpiresAt: APPROVAL_EXPIRES_AT,
      }),
    ]);
  });

  test('issues one lease-bound credential and persists only its hash', async () => {
    const { store, state, observations } = storeFor({
      selections: [[jobRow()], [approvalRow()], stepRows(), []],
    });

    const issued = await store.issue({
      candidate: candidateFixture(),
      lease: leaseFixture(),
      now: NOW,
    });

    expect(issued).toEqual(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        approvalId: APPROVAL_ID,
        token: `approval-resume.v1.${'A'.repeat(43)}`,
        expiresAt: LEASE_EXPIRES_AT,
      }),
    );
    expect(JSON.stringify(state.inserts.map((insert) => insert.values))).not.toContain(
      issued?.token,
    );
    expect(state.inserts.at(-1)).toEqual({
      table: automationApprovalResumeAttempts,
      values: expect.objectContaining({
        attemptId: ATTEMPT_ID,
        leaseId: LEASE_ID,
        leaseOwner: `browser-worker-1:${LEASE_ID}`,
        status: 'issued',
        tokenHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    });
    expect(state.transactions).toBe(1);
    expect(state.commits).toBe(1);
    expect(state.rowLocks).toBe(4);
    expect(observations).toEqual([
      expect.objectContaining({
        type: 'browser_resume_attempt_issued',
        attemptId: ATTEMPT_ID,
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain('token');
  });

  test('refuses issuance when approval, step, lease, generation, cursor, or expiry changed', async () => {
    const invalidLockedSnapshots = [
      { selections: [[jobRow()], [approvalRow({ status: 'rejected' })], stepRows(), []] },
      {
        selections: [[jobRow()], [approvalRow()], stepRows({ target: { status: 'running' } }), []],
      },
      {
        selections: [[jobRow()], [approvalRow({ approvalId: OTHER_APPROVAL_ID })], stepRows(), []],
      },
      {
        selections: [[jobRow()], [approvalRow({ actionHash: NEXT_HASH })], stepRows(), []],
      },
      {
        selections: [[jobRow({ leaseOwner: `browser-worker-1:${OTHER_LEASE_ID}` })]],
      },
      { selections: [[jobRow({ killSwitchGeneration: 8 })]] },
      {
        selections: [
          [jobRow()],
          [approvalRow()],
          stepRows({ previous: { status: 'running' } }),
          [],
        ],
      },
      {
        selections: [[jobRow()], [approvalRow()], stepRows({ next: { status: 'succeeded' } }), []],
      },
      {
        selections: [[jobRow()], [approvalRow({ expiresAt: NOW.toISOString() })], stepRows(), []],
      },
      {
        selections: [[jobRow({ leaseExpiresAt: NOW.toISOString() })]],
      },
      {
        selections: [[jobRow({ deadlineAt: NOW.toISOString() })]],
      },
    ];

    for (const changed of invalidLockedSnapshots) {
      const { store } = storeFor(changed);
      expect(
        await store.issue({ candidate: candidateFixture(), lease: leaseFixture(), now: NOW }),
      ).toBeNull();
    }

    const { store } = storeFor({ selections: [[jobRow()]] });
    expect(
      await store.issue({
        candidate: candidateFixture(),
        lease: leaseFixture({ lease_id: OTHER_LEASE_ID }),
        now: NOW,
      }),
    ).toBeNull();
  });

  test('rejects an undersized token pepper before accessing the database', () => {
    const { db } = fakeDatabase({ selections: [] });
    expect(() =>
      createPostgresBrowserApprovalResumeStore(db, { tokenPepper: 'too-short' }),
    ).toThrow(/pepper/i);
  });
});
