import { describe, expect, test } from 'bun:test';
import { createMemoryApprovalService, createMemoryApprovalStore } from './approval-service';
import {
  type KillSwitchNotification,
  createMemoryKillSwitchService,
  createMemoryKillSwitchStore,
  createRedisKillSwitchPublisher,
} from './kill-switch-service';
import type { AutomationActor } from './repository';

const ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_A_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT_B_ID = '00000000-0000-4000-8000-000000000003';
const DEVICE_A_ID = '00000000-0000-4000-8000-000000000004';
const DEVICE_B_ID = '00000000-0000-4000-8000-000000000005';
const USER_ID = '00000000-0000-4000-8000-000000000006';
const JOB_ID = '00000000-0000-4000-8000-000000000007';
const STEP_ID = '00000000-0000-4000-8000-000000000008';
const ACTION_HASH = `sha256:${'a'.repeat(64)}` as const;

const PROJECT_ADMIN: AutomationActor = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_A_ID,
  userId: USER_ID,
  roles: ['project_admin'],
  deviceId: null,
};

describe('automation kill switch', () => {
  test('allocates account-wide generations while invalidating only jobs in scope', async () => {
    const store = createMemoryKillSwitchStore({
      jobs: [
        {
          jobId: JOB_ID,
          accountId: ACCOUNT_ID,
          projectId: PROJECT_A_ID,
          deviceId: DEVICE_A_ID,
          killSwitchGeneration: 0,
          leaseOwner: 'worker-a',
          leaseExpiresAt: '2026-07-22T11:00:00.000Z',
        },
        {
          jobId: '00000000-0000-4000-8000-000000000009',
          accountId: ACCOUNT_ID,
          projectId: PROJECT_B_ID,
          deviceId: DEVICE_B_ID,
          killSwitchGeneration: 0,
          leaseOwner: 'worker-b',
          leaseExpiresAt: '2026-07-22T11:00:00.000Z',
        },
      ],
    });
    const service = createMemoryKillSwitchService({ store });

    const first = await service.activate(
      { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_A_ID },
      PROJECT_ADMIN,
    );
    const second = await service.activate(
      { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_B_ID },
      { ...PROJECT_ADMIN, projectId: PROJECT_B_ID },
    );

    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(
      await service.current({
        kind: 'project',
        accountId: ACCOUNT_ID,
        projectId: PROJECT_A_ID,
      }),
    ).toBe(1);
    expect(
      await service.current({
        kind: 'project',
        accountId: ACCOUNT_ID,
        projectId: PROJECT_B_ID,
      }),
    ).toBe(2);
    expect(store.snapshotJobs()).toEqual([
      expect.objectContaining({
        jobId: JOB_ID,
        killSwitchGeneration: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
      expect.objectContaining({
        projectId: PROJECT_B_ID,
        killSwitchGeneration: 2,
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    ]);
  });

  test('rejects actors without authority or outside the requested scope', async () => {
    const service = createMemoryKillSwitchService();

    await expect(
      service.activate(
        { kind: 'account', accountId: ACCOUNT_ID },
        { ...PROJECT_ADMIN, roles: ['project_admin'] },
      ),
    ).rejects.toMatchObject({ code: 'AUTOMATION_FORBIDDEN' });
    await expect(
      service.activate(
        { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_B_ID },
        PROJECT_ADMIN,
      ),
    ).rejects.toMatchObject({ code: 'AUTOMATION_FORBIDDEN' });
    await expect(
      service.activate(
        {
          kind: 'device',
          accountId: ACCOUNT_ID,
          projectId: PROJECT_A_ID,
          deviceId: DEVICE_B_ID,
        },
        { ...PROJECT_ADMIN, roles: ['device_owner'], deviceId: DEVICE_A_ID },
      ),
    ).rejects.toMatchObject({ code: 'AUTOMATION_FORBIDDEN' });
  });

  test('restores generation from a durable store after service restart', async () => {
    const store = createMemoryKillSwitchStore();
    const firstService = createMemoryKillSwitchService({ store });
    await firstService.activate(
      { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_A_ID },
      PROJECT_ADMIN,
    );

    const restartedService = createMemoryKillSwitchService({ store });
    expect(
      await restartedService.current({
        kind: 'project',
        accountId: ACCOUNT_ID,
        projectId: PROJECT_A_ID,
      }),
    ).toBe(1);
    expect(
      (
        await restartedService.activate(
          {
            kind: 'device',
            accountId: ACCOUNT_ID,
            projectId: PROJECT_A_ID,
            deviceId: DEVICE_A_ID,
          },
          { ...PROJECT_ADMIN, roles: ['device_owner'], deviceId: DEVICE_A_ID },
        )
      ).generation,
    ).toBe(2);
  });

  test('invalidates an approval token minted before activation', async () => {
    const killSwitch = createMemoryKillSwitchService();
    const approvals = createMemoryApprovalService({
      store: createMemoryApprovalStore(),
      now: () => new Date('2026-07-22T10:00:00.000Z'),
      currentGeneration: ({ accountId, projectId }) =>
        killSwitch.current({ kind: 'project', accountId, projectId }),
    });
    const approval = await approvals.request({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_A_ID,
      jobId: JOB_ID,
      stepId: STEP_ID,
      actionHash: ACTION_HASH,
      requestedByUserId: USER_ID,
      expiresAt: new Date('2026-07-22T10:05:00.000Z'),
    });
    const issued = await approvals.resolve({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_A_ID,
      approvalId: approval.approval_id,
      actionHash: ACTION_HASH,
      actorUserId: USER_ID,
      decision: 'approve',
    });
    if (!issued) throw new Error('Expected approval token');

    await killSwitch.activate(
      { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_A_ID },
      PROJECT_ADMIN,
    );

    expect(
      await approvals.consume({
        token: issued.token,
        projectId: PROJECT_A_ID,
        approvalId: issued.approvalId,
        actionHash: ACTION_HASH,
        now: new Date('2026-07-22T10:01:00.000Z'),
      }),
    ).toBe(false);
  });

  test('publishes the committed generation to every notification boundary', async () => {
    const eventStream: KillSwitchNotification[] = [];
    const tunnel: KillSwitchNotification[] = [];
    const redisCalls: Array<{ command: string; args: string[] }> = [];
    const redis = createRedisKillSwitchPublisher({
      async send(command, args) {
        redisCalls.push({ command, args });
        return command === 'PUBLISH' ? 1 : 'OK';
      },
    });
    const service = createMemoryKillSwitchService({
      publishers: [
        redis,
        { publish: async (notification) => void eventStream.push(notification) },
        { publish: async (notification) => void tunnel.push(notification) },
      ],
      now: () => new Date('2026-07-22T10:00:00.000Z'),
    });

    const activated = await service.activate(
      { kind: 'project', accountId: ACCOUNT_ID, projectId: PROJECT_A_ID },
      PROJECT_ADMIN,
    );

    expect(eventStream).toEqual([expect.objectContaining({ generation: 1 })]);
    expect(tunnel).toEqual(eventStream);
    expect(redisCalls.map(({ command }) => command)).toEqual(['SET', 'PUBLISH']);
    expect(redisCalls[0]?.args).toContain('1');
    expect(redisCalls[1]?.args[1]).toContain(activated.auditEventId);
  });
});
