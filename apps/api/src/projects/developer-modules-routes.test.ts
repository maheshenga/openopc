import { describe, expect, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

import { DeveloperModuleDistributionError } from '../developer/distribution';
import {
  ProjectModuleInstallationError,
  type ProjectModuleInstallationTransition,
} from '../developer/installations';
import { PROJECT_ACTIONS } from '../iam/actions';
import {
  type ProjectModuleLaunchDescriptor,
  ProjectModuleLaunchError,
} from '../module-domains/launch';
import {
  COMPLETE_RUNTIME_TEST_PROFILE,
  NON_READY_RUNTIME_TEST_PROFILE,
} from '../release-profile/test-fixtures';
import { createProjectDeveloperModuleRoutes } from './routes/developer-modules';

const PROJECT_ID = '10000000-0000-4000-a000-000000000001';
const ACCOUNT_ID = '20000000-0000-4000-a000-000000000002';
const OTHER_ACCOUNT_ID = '20000000-0000-4000-a000-000000000009';
const USER_ID = '30000000-0000-4000-a000-000000000003';
const RELEASE_V1 = '40000000-0000-4000-a000-000000000004';
const RELEASE_V2 = '40000000-0000-4000-a000-000000000005';
const INSTALLATION_ID = '50000000-0000-4000-a000-000000000006';

const LAUNCH_DESCRIPTOR: ProjectModuleLaunchDescriptor = {
  installation_id: INSTALLATION_ID,
  release_id: RELEASE_V1,
  install_revision: 1,
  module_id: 'acme.recruiting',
  module_version: '1.0.0',
  execution_mode: 'sandboxed-web',
  url: `https://r-${RELEASE_V1}.modules.openopc.example/`,
  origin: `https://r-${RELEASE_V1}.modules.openopc.example`,
};

const transition = (releaseId = RELEASE_V1): ProjectModuleInstallationTransition => ({
  installation: {
    installation_id: INSTALLATION_ID,
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    module_id: 'acme.recruiting',
    active_release_id: releaseId,
    active_version: releaseId === RELEASE_V1 ? '1.0.0' : '2.0.0',
    install_revision: releaseId === RELEASE_V1 ? 1 : 2,
    status: 'active',
    installed_by: USER_ID,
    created_at: '2026-07-24T00:00:00.000Z',
    updated_at: '2026-07-24T00:00:00.000Z',
  },
  event: {
    installation_event_id: '60000000-0000-4000-a000-000000000007',
    installation_id: INSTALLATION_ID,
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    sequence: releaseId === RELEASE_V1 ? 1 : 2,
    action: releaseId === RELEASE_V1 ? 'install' : 'update',
    from_release_id: releaseId === RELEASE_V1 ? null : RELEASE_V1,
    to_release_id: releaseId,
    expected_revision: releaseId === RELEASE_V1 ? 0 : 1,
    resulting_revision: releaseId === RELEASE_V1 ? 1 : 2,
    idempotency_key: 'module-op-1',
    actor_user_id: USER_ID,
    created_at: '2026-07-24T00:00:00.000Z',
  },
});

function appWith(overrides: Record<string, unknown> = {}) {
  const calls: {
    loads: Array<{ projectId: string; action: string }>;
    capabilities: Array<{ action: string; accountId: string; projectId: string }>;
    commands: Array<Record<string, unknown>>;
    launches: Array<{ accountId: string; projectId: string; installationId: string }>;
  } = { loads: [], capabilities: [], commands: [], launches: [] };

  const app = createProjectDeveloperModuleRoutes({
    loadProjectForUser: async (_context, projectId, action) => {
      calls.loads.push({ projectId, action });
      return { row: { projectId, accountId: ACCOUNT_ID }, userId: USER_ID };
    },
    assertProjectCapability: async (_context, userId, accountId, projectId, action) => {
      calls.capabilities.push({ action, accountId, projectId });
      expect(userId).toBe(USER_ID);
    },
    installationService: {
      list: async () => [],
      history: async () => [],
      install: async (command) => {
        calls.commands.push(command as unknown as Record<string, unknown>);
        return transition();
      },
      update: async (command) => {
        calls.commands.push(command as unknown as Record<string, unknown>);
        return transition(RELEASE_V2);
      },
      rollback: async (command) => {
        calls.commands.push(command as unknown as Record<string, unknown>);
        return transition(RELEASE_V1);
      },
    },
    launchService: {
      resolve: async (input: {
        accountId: string;
        projectId: string;
        installationId: string;
      }) => {
        calls.launches.push(input);
        return LAUNCH_DESCRIPTOR;
      },
    },
    runtime: COMPLETE_RUNTIME_TEST_PROFILE,
    ...overrides,
  });

  return { app, calls };
}

describe('project developer module routes', () => {
  test('returns the server-authoritative launch descriptor through project read gates', async () => {
    const { app, calls } = appWith();

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(LAUNCH_DESCRIPTOR);
    expect(calls.loads).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(calls.capabilities).toContainEqual({
      action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
    });
    expect(calls.launches).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
      },
    ]);
  });

  test('maps a missing launch candidate to an opaque project module error', async () => {
    const { app } = appWith({
      launchService: {
        resolve: async () => {
          throw new ProjectModuleLaunchError('PROJECT_MODULE_NOT_FOUND', 404);
        },
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'PROJECT_MODULE_NOT_FOUND' });
  });

  test.each([
    [409, 'PROJECT_MODULE_INACTIVE'],
    [409, 'PROJECT_MODULE_NOT_LAUNCHABLE'],
    [409, 'PROJECT_MODULE_LAUNCH_STALE'],
    [503, 'PROJECT_MODULE_HOST_UNAVAILABLE'],
  ] as const)('maps launch service errors to %i %s', async (status, code) => {
    const { app } = appWith({
      launchService: {
        resolve: async () => {
          throw new ProjectModuleLaunchError(code, status);
        },
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
  });

  test('rejects a malformed launch installation id before resolution', async () => {
    const { app, calls } = appWith();

    const response = await app.request(`/${PROJECT_ID}/modules/not-a-uuid/launch`);

    expect(response.status).toBe(400);
    expect(calls.launches).toEqual([]);
  });

  test('keeps a missing project opaque before launch resolution', async () => {
    const { app, calls } = appWith({
      loadProjectForUser: async () => null,
    });

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(calls.launches).toEqual([]);
  });

  test('fails closed when module app rendering is unavailable for the runtime profile', async () => {
    const { app, calls } = appWith({ runtime: NON_READY_RUNTIME_TEST_PROFILE });

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/launch`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
      capability: 'module.app.render',
    });
    expect(calls.launches).toEqual([]);
  });

  test('lists modules through project read and customize-read gates', async () => {
    const { app, calls } = appWith({
      installationService: {
        list: async () => [transition().installation],
        history: async () => [],
        install: async () => transition(),
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ modules: [transition().installation] });
    expect(calls.loads).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(calls.capabilities).toEqual([
      {
        action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
      },
    ]);
  });

  test('lists immutable installation history through project read and customize-read gates', async () => {
    const expectedHistory = [transition().event, transition(RELEASE_V2).event];
    const { app, calls } = appWith({
      installationService: {
        list: async () => [],
        history: async (input: { accountId: string; projectId: string; moduleId: string }) => {
          expect(input).toEqual({
            accountId: ACCOUNT_ID,
            projectId: PROJECT_ID,
            moduleId: 'acme.recruiting',
          });
          return expectedHistory;
        },
        install: async () => transition(),
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules/acme.recruiting/history`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ history: expectedHistory });
    expect(calls.loads).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(calls.capabilities).toEqual([
      {
        action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
      },
    ]);
  });

  test('maps missing installation history to a project module not found response', async () => {
    const { app } = appWith({
      installationService: {
        list: async () => [],
        history: async () => {
          throw new ProjectModuleInstallationError('PROJECT_MODULE_NOT_FOUND', 404);
        },
        install: async () => transition(),
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules/acme.recruiting/history`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'PROJECT_MODULE_NOT_FOUND' });
  });

  test('derives account from the loaded project and forwards idempotency on install', async () => {
    const { app, calls } = appWith();

    const response = await app.request(`/${PROJECT_ID}/modules/install`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'module-op-1',
      },
      body: JSON.stringify({
        account_id: OTHER_ACCOUNT_ID,
        release_id: RELEASE_V1,
        expected_install_revision: 0,
      }),
    });

    expect(response.status).toBe(201);
    expect(calls.capabilities[0]).toEqual({
      action: PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
    });
    expect(calls.commands[0]).toEqual({
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      actorUserId: USER_ID,
      releaseId: RELEASE_V1,
      expectedInstallRevision: 0,
      idempotencyKey: 'module-op-1',
    });
  });

  test('supports exact update and rollback commands with stale revision protection', async () => {
    const { app, calls } = appWith();

    const update = await app.request(`/${PROJECT_ID}/modules/acme.recruiting/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'module-op-2' },
      body: JSON.stringify({ release_id: RELEASE_V2, expected_install_revision: 1 }),
    });
    const rollback = await app.request(`/${PROJECT_ID}/modules/acme.recruiting/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'module-op-3' },
      body: JSON.stringify({ release_id: RELEASE_V1, expected_install_revision: 2 }),
    });

    expect(update.status).toBe(200);
    expect(rollback.status).toBe(200);
    expect(calls.commands).toEqual([
      expect.objectContaining({
        moduleId: 'acme.recruiting',
        releaseId: RELEASE_V2,
        expectedInstallRevision: 1,
        idempotencyKey: 'module-op-2',
      }),
      expect.objectContaining({
        moduleId: 'acme.recruiting',
        releaseId: RELEASE_V1,
        expectedInstallRevision: 2,
        idempotencyKey: 'module-op-3',
      }),
    ]);
    expect(calls.capabilities).toHaveLength(2);
    expect(
      calls.capabilities.every((call) => call.action === PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE),
    ).toBe(true);
  });

  test('maps stale, revoked, and unknown release errors without leaking payloads', async () => {
    const stale = appWith({
      installationService: {
        list: async () => [],
        history: async () => [],
        install: async () => {
          throw new ProjectModuleInstallationError('PROJECT_MODULE_INSTALL_CONFLICT', 409);
        },
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });
    const staleResponse = await stale.app.request(`/${PROJECT_ID}/modules/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ release_id: RELEASE_V1, expected_install_revision: 0 }),
    });
    expect(staleResponse.status).toBe(409);
    expect(await staleResponse.json()).toEqual({ error: 'PROJECT_MODULE_INSTALL_CONFLICT' });

    const revoked = appWith({
      installationService: {
        list: async () => [],
        history: async () => [],
        install: async () => {
          throw new DeveloperModuleDistributionError('DEVELOPER_MODULE_REVOKED', 409);
        },
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });
    const revokedResponse = await revoked.app.request(`/${PROJECT_ID}/modules/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ release_id: RELEASE_V1, expected_install_revision: 0 }),
    });
    expect(revokedResponse.status).toBe(409);
    expect(await revokedResponse.json()).toEqual({ error: 'DEVELOPER_MODULE_REVOKED' });

    const unknown = appWith({
      installationService: {
        list: async () => [],
        history: async () => [],
        install: async () => {
          throw new DeveloperModuleDistributionError('DEVELOPER_RELEASE_NOT_FOUND', 404);
        },
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
    });
    const unknownResponse = await unknown.app.request(`/${PROJECT_ID}/modules/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ release_id: RELEASE_V1, expected_install_revision: 0 }),
    });
    expect(unknownResponse.status).toBe(404);
    expect(await unknownResponse.json()).toEqual({ error: 'DEVELOPER_RELEASE_NOT_FOUND' });
  });

  test('preserves token/project authorization failures and strict input validation', async () => {
    const denied = createProjectDeveloperModuleRoutes({
      loadProjectForUser: async () => {
        throw new HTTPException(403, { message: 'Requested project is outside token scope' });
      },
      assertProjectCapability: async () => undefined,
      installationService: {
        list: async () => [],
        history: async () => [],
        install: async () => transition(),
        update: async () => transition(RELEASE_V2),
        rollback: async () => transition(RELEASE_V1),
      },
      launchService: { resolve: async () => LAUNCH_DESCRIPTOR },
      runtime: COMPLETE_RUNTIME_TEST_PROFILE,
    });
    const deniedResponse = await denied.request(`/${PROJECT_ID}/modules`);
    expect(deniedResponse.status).toBe(403);

    const { app } = appWith();
    const malformed = await app.request(`/${PROJECT_ID}/modules/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        release_id: 'not-a-uuid',
        expected_install_revision: -1,
        extra: true,
      }),
    });
    expect(malformed.status).toBe(400);
  });
});
