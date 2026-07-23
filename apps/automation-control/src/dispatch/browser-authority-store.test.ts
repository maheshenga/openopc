import type { AutomationBrowserAuthorityCheckInput } from '@kortix/intelligence-contracts';
import { describe, expect, test } from 'bun:test';
import { createBrowserAuthorityStore } from './browser-authority-store';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const LEASE_ID = '80000000-0000-4000-a000-000000000001';
const OWNER = `browser-worker-1:${LEASE_ID}`;
const REQUEST_HASH = `sha256:${'a'.repeat(64)}` as const;
const ACTION_HASH = `sha256:${'b'.repeat(64)}` as const;
const NOW = new Date('2099-07-23T10:00:00.000Z');

function authorityInput(
  check: AutomationBrowserAuthorityCheckInput['check'],
): AutomationBrowserAuthorityCheckInput {
  return {
    account_id: ACCOUNT_ID,
    project_id: PROJECT_ID,
    job_id: JOB_ID,
    lease_id: LEASE_ID,
    lease_owner: OWNER,
    request_hash: REQUEST_HASH,
    kill_switch_generation: 7,
    requested_at: NOW.toISOString(),
    check,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    job: {
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
      executionDomain: 'browser',
      requestHash: REQUEST_HASH,
      status: 'running',
      leaseOwner: OWNER,
      leaseExpiresAt: '2099-07-23T10:30:00.000Z',
      deadlineAt: '2099-07-23T11:00:00.000Z',
      killSwitchGeneration: 7,
      cancelRequestedAt: null,
      approvalPolicy: 'full-access',
    },
    step: { stepId: STEP_ID, sequence: 3, actionHash: ACTION_HASH, status: 'running' },
    maxCompletedSequence: 2,
    fullAccessAllowed: true,
    ...overrides,
  };
}

function storeFor(current = snapshot()) {
  return createBrowserAuthorityStore(async () => current);
}

describe('Browser authority store', () => {
  test('accepts a current action authority snapshot', async () => {
    const result = await storeFor().check(
      authorityInput({ kind: 'action', step_id: STEP_ID, action_hash: ACTION_HASH }),
      NOW,
    );

    expect(result).toEqual({
      accepted: true,
      checkedAt: NOW.toISOString(),
      currentGeneration: 7,
      fullAccessGrantCurrent: true,
    });
  });

  test('fails closed when the authority snapshot reader throws', async () => {
    const store = createBrowserAuthorityStore(async () => {
      throw new Error('PostgreSQL failed: database_password=do-not-disclose');
    });

    await expect(
      store.check(authorityInput({ kind: 'lease' }), NOW),
    ).resolves.toEqual({ accepted: false, reason: 'dispatch_mismatch' });
  });

  test.each([
    ['stale lease owner', { lease_owner: `browser-worker-2:${LEASE_ID}` }, snapshot(), 'stale_lease'],
    [
      'lease identifier not bound to the owner',
      { lease_id: '80000000-0000-4000-a000-000000000099' },
      snapshot(),
      'stale_lease',
    ],
    [
      'expired lease',
      {},
      snapshot({ job: { ...snapshot().job, leaseExpiresAt: NOW.toISOString() } }),
      'stale_lease',
    ],
    [
      'expired deadline',
      {},
      snapshot({ job: { ...snapshot().job, deadlineAt: NOW.toISOString() } }),
      'stale_lease',
    ],
    [
      'cancellation request',
      {},
      snapshot({ job: { ...snapshot().job, cancelRequestedAt: NOW.toISOString() } }),
      'dispatch_mismatch',
    ],
    ['wrong account', { account_id: '10000000-0000-4000-a000-000000000099' }, snapshot(), 'dispatch_mismatch'],
    ['wrong project', { project_id: '20000000-0000-4000-a000-000000000099' }, snapshot(), 'dispatch_mismatch'],
    [
      'wrong request hash',
      { request_hash: `sha256:${'c'.repeat(64)}` },
      snapshot(),
      'dispatch_mismatch',
    ],
    ['stale generation', { kill_switch_generation: 6 }, snapshot(), 'stale_lease'],
    [
      'changed action hash',
      {},
      snapshot({ step: { ...snapshot().step, actionHash: `sha256:${'d'.repeat(64)}` } }),
      'dispatch_mismatch',
    ],
    [
      'terminal step',
      {},
      snapshot({ step: { ...snapshot().step, status: 'succeeded' } }),
      'dispatch_mismatch',
    ],
  ] as const)(
    'rejects %s',
    async (_caseName, inputOverrides, current, reason) => {
      const result = await storeFor(current).check(
        { ...authorityInput({ kind: 'action', step_id: STEP_ID, action_hash: ACTION_HASH }), ...inputOverrides },
        NOW,
      );

      expect(result).toEqual({ accepted: false, reason });
    },
  );

  test('rejects an action with a mismatched current step id', async () => {
    const result = await storeFor().check(
      authorityInput({
        kind: 'action',
        step_id: '50000000-0000-4000-a000-000000000099',
        action_hash: ACTION_HASH,
      }),
      NOW,
    );

    expect(result).toEqual({ accepted: false, reason: 'dispatch_mismatch' });
  });

  test('rejects a cursor that no longer matches completed steps', async () => {
    const result = await storeFor(snapshot({ maxCompletedSequence: 3 })).check(
      authorityInput({ kind: 'cursor', resume_after_sequence: 2 }),
      NOW,
    );

    expect(result).toEqual({ accepted: false, reason: 'dispatch_mismatch' });
  });

  test('returns an accepted full-access check with a revoked current grant', async () => {
    const result = await storeFor(snapshot({ fullAccessAllowed: false })).check(
      authorityInput({ kind: 'full_access' }),
      NOW,
    );

    expect(result).toEqual({
      accepted: true,
      checkedAt: NOW.toISOString(),
      currentGeneration: 7,
      fullAccessGrantCurrent: false,
    });
  });
});
