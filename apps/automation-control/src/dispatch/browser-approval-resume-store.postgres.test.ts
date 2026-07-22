import { describe, expect, test } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  type Database,
  automationApprovalResumeAttempts,
  automationApprovals,
  automationJobEvents,
  automationJobSteps,
  automationJobs,
} from '@kortix/db';
import {
  type AutomationBrowserApprovalConsumeInput,
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
  type BrowserApprovalResumeConsumeResult,
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
const WORKER_ID = 'browser-worker-1';
const RESUME_TOKEN = `approval-resume.v1.${'A'.repeat(43)}`;

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

type SettlementTarget = 'attempt' | 'approval' | 'step' | 'job' | 'event';

type SettlementFakeOptions = {
  selections: unknown[][];
  failTarget?: SettlementTarget;
};

function settlementFakeDatabase(options: SettlementFakeOptions): {
  db: Database;
  state: FakeState;
} {
  const state: FakeState = {
    selections: [...options.selections],
    inserts: [],
    updates: [],
    transactions: 0,
    commits: 0,
    rollbacks: 0,
    rowLocks: 0,
  };
  const targetForTable = (table: unknown): Exclude<SettlementTarget, 'event'> => {
    if (table === automationApprovalResumeAttempts) return 'attempt';
    if (table === automationApprovals) return 'approval';
    if (table === automationJobSteps) return 'step';
    if (table === automationJobs) return 'job';
    throw new Error('unexpected fake update target');
  };
  const db = {
    async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      state.transactions += 1;
      const pendingInserts: FakeState['inserts'] = [];
      const pendingUpdates: FakeState['updates'] = [];
      const tx = {
        select: () =>
          awaitableQuery(state.selections.shift() ?? [], () => {
            state.rowLocks += 1;
          }),
        update: (table: unknown) => ({
          set(values: Record<string, unknown>) {
            return {
              where() {
                return {
                  async returning() {
                    const target = targetForTable(table);
                    if (options.failTarget === target) return [];
                    pendingUpdates.push({ table, values });
                    if (target === 'attempt') return [{ attemptId: ATTEMPT_ID }];
                    if (target === 'approval') return [{ approvalId: APPROVAL_ID }];
                    if (target === 'step') return [{ stepId: STEP_ID }];
                    return [{ jobId: JOB_ID }];
                  },
                };
              },
            };
          },
        }),
        insert: (table: unknown) => ({
          values(values: Record<string, unknown>) {
            if (table !== automationJobEvents) throw new Error('unexpected fake insert target');
            if (options.failTarget === 'event') return Promise.reject(new Error('event failed'));
            pendingInserts.push({ table, values });
            return Promise.resolve();
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

const CONSUME_INPUT = {
  account_id: ACCOUNT_ID,
  project_id: PROJECT_ID,
  job_id: JOB_ID,
  approval_id: APPROVAL_ID,
  attempt_id: ATTEMPT_ID,
  step_id: STEP_ID,
  action_hash: ACTION_HASH,
  lease_id: LEASE_ID,
  lease_owner: `browser-worker-1:${LEASE_ID}`,
  kill_switch_generation: 7,
  resume_after_sequence: 1,
  token: RESUME_TOKEN,
  requested_at: NOW.toISOString(),
} satisfies AutomationBrowserApprovalConsumeInput;

function resumeTokenHash(binding: Record<string, unknown>): `sha256:${string}` {
  const digest = createHmac('sha256', TOKEN_PEPPER)
    .update(
      [
        RESUME_TOKEN,
        binding.accountId,
        binding.projectId,
        binding.approvalId,
        binding.jobId,
        binding.stepId,
        binding.actionHash,
        binding.leaseId,
        binding.leaseOwner,
        binding.killSwitchGeneration,
        binding.attemptId,
        binding.resumeAfterSequence,
        binding.expiresAt,
      ].join('\0'),
    )
    .digest('hex');
  return `sha256:${digest}`;
}

function attemptRow(overrides: Record<string, unknown> = {}) {
  const attempt = {
    attemptId: ATTEMPT_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    approvalId: APPROVAL_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    leaseId: LEASE_ID,
    leaseOwner: `browser-worker-1:${LEASE_ID}`,
    killSwitchGeneration: 7,
    resumeAfterSequence: 1,
    status: 'issued',
    issuedAt: NOW.toISOString(),
    expiresAt: LEASE_EXPIRES_AT,
    consumedAt: null,
    ...overrides,
  };
  return { ...attempt, tokenHash: resumeTokenHash(attempt), ...overrides };
}

function settlementSelections(input?: {
  job?: Record<string, unknown>;
  approval?: Record<string, unknown>;
  steps?: ReturnType<typeof stepRows>;
  attempt?: Record<string, unknown> | null;
  includeSequence?: boolean;
}): unknown[][] {
  return [
    [jobRow(input?.job)],
    [approvalRow(input?.approval)],
    input?.steps ?? stepRows(),
    input?.attempt === null ? [] : [attemptRow(input?.attempt)],
    ...(input?.includeSequence === false ? [] : [[{ value: 4 }]]),
  ];
}

function settlementStore(options: SettlementFakeOptions) {
  const fake = settlementFakeDatabase(options);
  const observations: unknown[] = [];
  return {
    ...fake,
    observations,
    store: createPostgresBrowserApprovalResumeStore(fake.db, {
      tokenPepper: TOKEN_PEPPER,
      observe: (event) => observations.push(event),
    }),
  };
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

describe('PostgreSQL browser approval resume store settlement', () => {
  test('atomically consumes an Attempt and starts its Job and Step', async () => {
    const { store, state, observations } = settlementStore({
      selections: settlementSelections(),
    });

    const result = await store.consumeAndStart({ ...CONSUME_INPUT, workerId: WORKER_ID, now: NOW });

    expect(result).toEqual({ accepted: true, idempotent: false, startedAt: NOW.toISOString() });
    expect(state.commits).toBe(1);
    expect(state.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ values: expect.objectContaining({ status: 'consumed' }) }),
        expect.objectContaining({ values: expect.objectContaining({ status: 'running' }) }),
      ]),
    );
    expect(state.inserts.at(-1)?.values).toEqual(
      expect.objectContaining({
        type: 'job_started',
        status: 'running',
        workerId: null,
        workerLeaseId: null,
        workerOrdinal: null,
      }),
    );
    expect(observations).toEqual([
      expect.objectContaining({ type: 'browser_resume_consumed', attemptId: ATTEMPT_ID }),
    ]);
    expect(JSON.stringify(observations)).not.toContain(RESUME_TOKEN);
    expect(JSON.stringify(observations)).not.toContain('tokenHash');
  });

  test('returns idempotent success for the same consumed Attempt only', async () => {
    const later = new Date(NOW.getTime() + 1_000);
    const { store, state, observations } = settlementStore({
      selections: settlementSelections({
        job: { status: 'running' },
        approval: { status: 'consumed' },
        steps: stepRows({ target: { status: 'running', startedAt: NOW.toISOString() } }),
        attempt: { status: 'consumed', consumedAt: NOW.toISOString() },
        includeSequence: false,
      }),
    });

    const result = await store.consumeAndStart({
      ...CONSUME_INPUT,
      workerId: WORKER_ID,
      now: later,
    });

    expect(result).toEqual({ accepted: true, idempotent: true, startedAt: NOW.toISOString() });
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
    expect(observations).toEqual([
      expect.objectContaining({ type: 'browser_resume_duplicate', attemptId: ATTEMPT_ID }),
    ]);
  });

  test('rolls back Approval, Step, Job, Attempt, and event on every write failure', async () => {
    for (const failTarget of ['attempt', 'approval', 'step', 'job', 'event'] as const) {
      const failing = settlementStore({
        selections: settlementSelections(),
        failTarget,
      });
      await expect(
        failing.store.consumeAndStart({ ...CONSUME_INPUT, workerId: WORKER_ID, now: NOW }),
      ).rejects.toThrow();
      expect(failing.state.commits).toBe(0);
      expect(failing.state.rollbacks).toBe(1);
      expect(failing.state.updates).toHaveLength(0);
      expect(failing.state.inserts).toHaveLength(0);
    }
  });

  test('rejects invalid credentials, stale leases, dispatch mismatches, terminal approvals, and conflicts', async () => {
    const cases: Array<{
      reason: Extract<BrowserApprovalResumeConsumeResult, { accepted: false }>['reason'];
      input?: Partial<AutomationBrowserApprovalConsumeInput>;
      selections: unknown[][];
    }> = [
      {
        reason: 'credential_invalid',
        selections: settlementSelections({ attempt: null, includeSequence: false }),
      },
      {
        reason: 'stale_lease',
        input: { lease_owner: `browser-worker-1:${OTHER_LEASE_ID}` },
        selections: settlementSelections({ includeSequence: false }),
      },
      {
        reason: 'dispatch_mismatch',
        input: { resume_after_sequence: 0 },
        selections: settlementSelections({ includeSequence: false }),
      },
      {
        reason: 'approval_terminal',
        selections: settlementSelections({
          approval: { status: 'rejected' },
          includeSequence: false,
        }),
      },
      {
        reason: 'conflict',
        selections: settlementSelections({
          steps: stepRows({ target: { status: 'running' } }),
          includeSequence: false,
        }),
      },
    ];

    for (const current of cases) {
      const { store } = settlementStore({ selections: current.selections });
      expect(
        await store.consumeAndStart({
          ...CONSUME_INPUT,
          ...current.input,
          workerId: WORKER_ID,
          now: NOW,
        }),
      ).toEqual({ accepted: false, reason: current.reason });
    }
  });

  test('keeps scope misses opaque and expires only a proven expired Attempt', async () => {
    for (const input of [
      { account_id: '10000000-0000-4000-a000-000000000099' },
      { project_id: '20000000-0000-4000-a000-000000000099' },
    ]) {
      const { store, state } = settlementStore({
        selections: settlementSelections({ includeSequence: false }),
      });
      expect(
        await store.consumeAndStart({
          ...CONSUME_INPUT,
          ...input,
          workerId: WORKER_ID,
          now: NOW,
        }),
      ).toEqual({ accepted: false, reason: 'credential_invalid' });
      expect(state.updates).toHaveLength(0);
    }

    const expiredAt = NOW.toISOString();
    const expired = settlementStore({
      selections: settlementSelections({
        attempt: { expiresAt: expiredAt },
        includeSequence: false,
      }),
    });
    expect(
      await expired.store.consumeAndStart({ ...CONSUME_INPUT, workerId: WORKER_ID, now: NOW }),
    ).toEqual({ accepted: false, reason: 'credential_invalid' });
    expect(expired.state.updates).toEqual([
      expect.objectContaining({ values: { status: 'expired' } }),
    ]);
    expect(expired.observations).toEqual([
      expect.objectContaining({ type: 'browser_resume_expired', attemptId: ATTEMPT_ID }),
    ]);
  });

  test('does not mutate an Attempt for a bad token or a not-yet-expired stale lease', async () => {
    const badToken = settlementStore({
      selections: settlementSelections({ includeSequence: false }),
    });
    expect(
      await badToken.store.consumeAndStart({
        ...CONSUME_INPUT,
        token: `approval-resume.v1.${'B'.repeat(43)}`,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).toEqual({ accepted: false, reason: 'credential_invalid' });
    expect(badToken.state.updates).toHaveLength(0);

    const staleLease = settlementStore({
      selections: settlementSelections({
        job: { killSwitchGeneration: 8 },
        includeSequence: false,
      }),
    });
    expect(
      await staleLease.store.consumeAndStart({
        ...CONSUME_INPUT,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).toEqual({ accepted: false, reason: 'stale_lease' });
    expect(staleLease.state.updates).toHaveLength(0);
  });

  test('uses database-clock validity for the lease and proven Attempt expiry', async () => {
    const staleLease = settlementStore({
      selections: [
        [{ job: jobRow(), leaseCurrent: false, deadlineCurrent: true }],
        [{ approval: approvalRow(), current: true }],
        stepRows(),
        [{ attempt: attemptRow(), current: true }],
      ],
    });
    expect(
      await staleLease.store.consumeAndStart({
        ...CONSUME_INPUT,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).toEqual({ accepted: false, reason: 'stale_lease' });
    expect(staleLease.state.updates).toHaveLength(0);

    const expiredAttempt = settlementStore({
      selections: [
        [{ job: jobRow(), leaseCurrent: true, deadlineCurrent: true }],
        [{ approval: approvalRow(), current: true }],
        stepRows(),
        [{ attempt: attemptRow(), current: false }],
      ],
    });
    expect(
      await expiredAttempt.store.consumeAndStart({
        ...CONSUME_INPUT,
        workerId: WORKER_ID,
        now: NOW,
      }),
    ).toEqual({ accepted: false, reason: 'credential_invalid' });
    expect(expiredAttempt.state.updates).toEqual([
      expect.objectContaining({ values: { status: 'expired' } }),
    ]);
  });
});
