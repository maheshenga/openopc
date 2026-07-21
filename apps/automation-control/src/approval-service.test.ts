import { describe, expect, test } from 'bun:test';
import {
  AutomationApprovalServiceError,
  createMemoryApprovalService,
  createMemoryApprovalStore,
} from './approval-service';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000099';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const STEP_ID = '40000000-0000-4000-a000-000000000001';
const USER_ID = '50000000-0000-4000-a000-000000000001';
const OTHER_USER_ID = '50000000-0000-4000-a000-000000000099';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;
const OTHER_ACTION_HASH = `sha256:${'b'.repeat(64)}` as const;

function requestInput(expiresAt = new Date('2026-07-22T03:05:00.000Z')) {
  return {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    jobId: JOB_ID,
    stepId: STEP_ID,
    actionHash: ACTION_HASH,
    requestedByUserId: USER_ID,
    expiresAt,
  };
}

describe('one-time automation approvals', () => {
  test('binds a random token to project, approval, action, expiry, and generation', async () => {
    const store = createMemoryApprovalStore();
    let generation = 3;
    const service = createMemoryApprovalService({
      store,
      now: () => new Date('2026-07-22T03:00:00.000Z'),
      currentGeneration: async () => generation,
    });
    const approval = await service.request(requestInput());
    const issued = await service.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      approvalId: approval.approval_id,
      actionHash: ACTION_HASH,
      actorUserId: USER_ID,
      decision: 'approve',
    });
    if (!issued) throw new Error('Expected an approval token');

    expect(issued.token).toMatch(/^approval\.v1\.[A-Za-z0-9_-]{43}$/);
    expect(issued).toMatchObject({
      approvalId: approval.approval_id,
      projectId: PROJECT_ID,
      actionHash: ACTION_HASH,
    });
    const persisted = JSON.stringify(store.snapshot());
    expect(persisted).not.toContain(issued.token);
    expect(persisted).toContain('sha256:');

    generation = 4;
    expect(
      await service.consume({
        token: issued.token,
        projectId: PROJECT_ID,
        approvalId: approval.approval_id,
        actionHash: ACTION_HASH,
        now: new Date('2026-07-22T03:01:00.000Z'),
      }),
    ).toBeFalse();
  });

  test('rejects the wrong project, action hash, and acting user during resolution', async () => {
    const service = createMemoryApprovalService({
      now: () => new Date('2026-07-22T03:00:00.000Z'),
    });
    const projectApproval = await service.request(requestInput());
    const actionApproval = await service.request(requestInput());
    const actorApproval = await service.request(requestInput());

    await expect(
      service.resolve({
        accountId: ACCOUNT_ID,
        projectId: OTHER_PROJECT_ID,
        approvalId: projectApproval.approval_id,
        actionHash: ACTION_HASH,
        actorUserId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_NOT_FOUND' });
    await expect(
      service.resolve({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        approvalId: actionApproval.approval_id,
        actionHash: OTHER_ACTION_HASH,
        actorUserId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toBeInstanceOf(AutomationApprovalServiceError);
    await expect(
      service.resolve({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        approvalId: actorApproval.approval_id,
        actionHash: ACTION_HASH,
        actorUserId: OTHER_USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_FORBIDDEN' });
  });

  test('rejects resolution after the approval expires', async () => {
    let now = new Date('2026-07-22T03:00:00.000Z');
    const service = createMemoryApprovalService({ now: () => now });
    const approval = await service.request(requestInput(new Date('2026-07-22T03:01:00.000Z')));
    now = new Date('2026-07-22T03:01:00.000Z');

    await expect(
      service.resolve({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        approvalId: approval.approval_id,
        actionHash: ACTION_HASH,
        actorUserId: USER_ID,
        decision: 'approve',
      }),
    ).rejects.toMatchObject({ code: 'AUTOMATION_APPROVAL_EXPIRED' });
  });

  test('consumes a valid token exactly once and rejects every binding mismatch', async () => {
    const service = createMemoryApprovalService({
      now: () => new Date('2026-07-22T03:00:00.000Z'),
    });
    const approval = await service.request(requestInput());
    const issued = await service.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      approvalId: approval.approval_id,
      actionHash: ACTION_HASH,
      actorUserId: USER_ID,
      decision: 'approve',
    });
    if (!issued) throw new Error('Expected an approval token');
    const consume = (overrides = {}) =>
      service.consume({
        token: issued.token,
        projectId: PROJECT_ID,
        approvalId: approval.approval_id,
        actionHash: ACTION_HASH,
        now: new Date('2026-07-22T03:01:00.000Z'),
        ...overrides,
      });

    expect(await consume({ token: 'approval.v1.invalid' })).toBeFalse();
    expect(await consume({ projectId: OTHER_PROJECT_ID })).toBeFalse();
    expect(await consume({ actionHash: OTHER_ACTION_HASH })).toBeFalse();
    expect(await consume()).toBeTrue();
    expect(await consume()).toBeFalse();
  });

  test('returns no token when the user rejects an approval', async () => {
    const service = createMemoryApprovalService({
      now: () => new Date('2026-07-22T03:00:00.000Z'),
    });
    const approval = await service.request(requestInput());

    expect(
      await service.resolve({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        approvalId: approval.approval_id,
        actionHash: ACTION_HASH,
        actorUserId: USER_ID,
        decision: 'reject',
      }),
    ).toBeNull();
  });
});
