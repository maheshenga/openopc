import { describe, expect, test } from 'bun:test';
import type { ModuleServiceCapabilityClaimsV1 } from '@kortix/api-contract';

import { PROJECT_ACTIONS } from '../iam/actions';
import {
  ModuleSettingsError,
  type ModuleSettingsRepository,
  ModuleSettingsService,
  createModuleSettingsProjectRoutes,
  createModuleSettingsRoutes,
} from './settings';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const USER_ID = '40000000-0000-4000-a000-000000000001';

function claims(): Extract<ModuleServiceCapabilityClaimsV1, { service: 'settings' }> {
  return {
    schemaVersion: 1,
    iss: 'openopc-control-plane',
    aud: 'openopc:module-service',
    jti: '50000000-0000-4000-8000-000000000001',
    iat: '2026-08-11T00:00:00.000Z',
    exp: '2026-08-11T00:05:00.000Z',
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 3,
    releaseId: '60000000-0000-4000-8000-000000000001',
    moduleId: 'openopc.infinite-canvas',
    moduleVersion: '1.0.0',
    consentId: '70000000-0000-4000-8000-000000000001',
    grantId: '80000000-0000-4000-8000-000000000001',
    service: 'settings',
    operations: ['settings.read'],
  };
}

function repository(overrides: Partial<ModuleSettingsRepository> = {}): ModuleSettingsRepository {
  return {
    async loadDefinition() {
      return {
        fields: [
          { key: 'canvas.autosave', label: 'Autosave', type: 'boolean', default: true },
          { key: 'canvas.snap_size', label: 'Snap size', type: 'number', default: 10 },
          {
            key: 'export.format',
            label: 'Export format',
            type: 'select',
            default: 'png',
            options: [
              { value: 'png', label: 'PNG' },
              { value: 'svg', label: 'SVG' },
            ],
          },
        ],
      };
    },
    async readValues() {
      return { revision: 2, values: { 'canvas.snap_size': 20 } };
    },
    async replaceValues(input) {
      return { revision: input.expectedRevision + 1, values: input.values };
    },
    ...overrides,
  };
}

describe('OpenOPC module settings service', () => {
  test('merges declared defaults with stored values and never projects undeclared keys', async () => {
    const service = new ModuleSettingsService({
      repository: repository({
        async readValues() {
          return {
            revision: 4,
            values: { 'canvas.snap_size': 24, undeclared: 'drop-me' },
          };
        },
      }),
      now: () => new Date('2026-08-11T02:00:00.000Z'),
    });

    await expect(
      service.read({
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
      }),
    ).resolves.toEqual({
      schema_version: 1,
      revision: 4,
      values: {
        'canvas.autosave': true,
        'canvas.snap_size': 24,
        'export.format': 'png',
      },
      loaded_at: '2026-08-11T02:00:00.000Z',
    });
  });

  test('rejects undeclared or type-invalid values before persistence', async () => {
    let writes = 0;
    const service = new ModuleSettingsService({
      repository: repository({
        async replaceValues(input) {
          writes += 1;
          return { revision: input.expectedRevision + 1, values: input.values };
        },
      }),
    });
    const scope = { accountId: ACCOUNT_ID, projectId: PROJECT_ID, installationId: INSTALLATION_ID };

    await expect(
      service.replace({
        ...scope,
        actorUserId: USER_ID,
        expectedRevision: 2,
        values: { 'canvas.snap_size': 'twenty' },
      }),
    ).rejects.toBeInstanceOf(ModuleSettingsError);
    await expect(
      service.replace({
        ...scope,
        actorUserId: USER_ID,
        expectedRevision: 2,
        values: { api_key: 'forbidden' },
      }),
    ).rejects.toMatchObject({ code: 'MODULE_SETTINGS_INVALID' });
    expect(writes).toBe(0);
  });
});

describe('OpenOPC module settings routes', () => {
  test('lets the sandbox read only effective settings with a settings capability', async () => {
    const service = new ModuleSettingsService({
      repository: repository(),
      now: () => new Date('2026-08-11T02:00:00.000Z'),
    });
    const operations: string[] = [];
    const app = createModuleSettingsRoutes({
      service,
      async requireCapability(authorization, operation) {
        expect(authorization).toBe('Bearer scoped');
        operations.push(operation);
        return claims();
      },
    });

    const response = await app.request('/', { headers: { authorization: 'Bearer scoped' } });
    expect(response.status).toBe(200);
    expect((await response.json()).values).toEqual({
      'canvas.autosave': true,
      'canvas.snap_size': 20,
      'export.format': 'png',
    });
    expect(operations).toEqual(['settings.read']);
  });

  test('keeps settings replacement behind the project customize-write gate', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      async read() {
        return {
          schema_version: 1 as const,
          revision: 2,
          values: { 'canvas.autosave': true },
          loaded_at: '2026-08-11T02:00:00.000Z',
        };
      },
      async replace(input: Record<string, unknown>) {
        calls.push(input);
        return {
          schema_version: 1 as const,
          revision: 3,
          values: input.values as Record<string, string | number | boolean | null>,
          loaded_at: '2026-08-11T02:01:00.000Z',
        };
      },
    };
    const capabilityCalls: string[] = [];
    const app = createModuleSettingsProjectRoutes({
      service: service as unknown as Pick<ModuleSettingsService, 'read' | 'replace'>,
      loadProjectForUser: async () => ({
        row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
        userId: USER_ID,
      }),
      assertProjectCapability: async (_context, userId, accountId, projectId, action) => {
        expect({ userId, accountId, projectId }).toEqual({
          userId: USER_ID,
          accountId: ACCOUNT_ID,
          projectId: PROJECT_ID,
        });
        capabilityCalls.push(action);
      },
    });

    const response = await app.request(`/${PROJECT_ID}/modules/${INSTALLATION_ID}/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_revision: 2,
        values: { 'canvas.autosave': false },
      }),
    });

    expect(response.status).toBe(200);
    expect(capabilityCalls).toEqual([PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE]);
    expect(calls).toEqual([
      {
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        installationId: INSTALLATION_ID,
        actorUserId: USER_ID,
        expectedRevision: 2,
        values: { 'canvas.autosave': false },
      },
    ]);
  });
});
