import { describe, expect, test } from 'bun:test';

import {
  DeveloperModuleReleaseError,
  DeveloperModuleReleaseService,
  createMemoryDeveloperModuleReleaseRepository,
} from './releases';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const OTHER_ACCOUNT_ID = '10000000-0000-4000-a000-000000000009';
const USER_ID = '20000000-0000-4000-a000-000000000002';
const NOW = new Date('2026-07-24T12:00:00.000Z');

function validModuleItem() {
  return {
    name: 'recruiting-workbench',
    type: 'registry:module',
    module: {
      schemaVersion: 1,
      id: 'acme.recruiting',
      version: '1.0.0',
      publisher: { id: 'acme', displayName: 'Acme' },
      category: 'industry',
      locales: ['en', 'zh-CN'],
      compatibility: { platform: '^1.0.0' },
      execution: { mode: 'declarative' },
      capabilities: [{ id: 'acme.recruiting.score', kind: 'task' }],
      permissions: {
        secrets: ['RECRUITING_MODEL_API_KEY'],
        network: ['https://api.example.com'],
      },
    },
  };
}

describe('developer module release service', () => {
  test('submits a valid module as immutable validated release metadata', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
    });

    const result = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });

    expect(result.created).toBe(true);
    expect(result.release).toEqual(
      expect.objectContaining({
        account_id: ACCOUNT_ID,
        module_id: 'acme.recruiting',
        module_version: '1.0.0',
        publisher_id: 'acme',
        status: 'validated',
        created_by: USER_ID,
        created_at: NOW.toISOString(),
      }),
    );
    expect(result.release.manifest_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.release.review_requirements).toEqual([
      'manifest_review',
      'source_scan',
      'permission_review',
      'human_review',
    ]);
  });

  test('rejects invalid manifests without persisting or echoing submitted credentials', async () => {
    const repository = createMemoryDeveloperModuleReleaseRepository({ now: () => NOW });
    const service = new DeveloperModuleReleaseService({ repository });
    const item = validModuleItem();
    item.module.permissions.secrets = ['OPENAI_API_KEY=sk-live-super-secret'];

    await expect(
      service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: 'DEVELOPER_MODULE_INVALID',
        status: 400,
        message: 'DEVELOPER_MODULE_INVALID',
      }),
    );
    expect(JSON.stringify(await service.list({ accountId: ACCOUNT_ID }))).not.toContain(
      'sk-live-super-secret',
    );
  });

  test('requires the module id to belong to the declared publisher namespace', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const item = validModuleItem();
    item.module.id = 'other.recruiting';
    item.module.capabilities = [{ id: 'other.recruiting.score', kind: 'task' }];

    await expect(
      service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_MISMATCH', status: 400 }),
    );
  });

  test('returns the original release for an idempotent same-version resubmission', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
    });
    const first = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    const second = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });

    expect(second.created).toBe(false);
    expect(second.release.release_id).toBe(first.release.release_id);
  });

  test('rejects reuse of a module version for different immutable content', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    await service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item: validModuleItem() });
    const changed = validModuleItem();
    changed.module.locales = ['en'];

    await expect(
      service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item: changed }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_MODULE_VERSION_CONFLICT', status: 409 }),
    );
  });

  test('rejects a publisher id already owned by another account', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    await service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item: validModuleItem() });
    const anotherModule = validModuleItem();
    anotherModule.name = 'sales-workbench';
    anotherModule.module.id = 'acme.sales';
    anotherModule.module.version = '2.0.0';
    anotherModule.module.capabilities = [{ id: 'acme.sales.score', kind: 'task' }];

    await expect(
      service.submit({
        accountId: OTHER_ACCOUNT_ID,
        actorUserId: USER_ID,
        item: anotherModule,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'DEVELOPER_PUBLISHER_CONFLICT', status: 409 }),
    );
  });

  test('scopes list and get to the owning account and protects stored content from mutation', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository({ now: () => NOW }),
    });
    const submitted = await service.submit({
      accountId: ACCOUNT_ID,
      actorUserId: USER_ID,
      item: validModuleItem(),
    });
    submitted.release.manifest.publisher.displayName = 'Tampered';

    expect(await service.list({ accountId: OTHER_ACCOUNT_ID })).toEqual([]);
    await expect(
      service.get({ accountId: OTHER_ACCOUNT_ID, releaseId: submitted.release.release_id }),
    ).rejects.toBeInstanceOf(DeveloperModuleReleaseError);
    const stored = await service.get({
      accountId: ACCOUNT_ID,
      releaseId: submitted.release.release_id,
    });
    expect(stored.manifest.publisher.displayName).toBe('Acme');
  });

  test('derives sandbox and desktop review requirements from executable surfaces', async () => {
    const service = new DeveloperModuleReleaseService({
      repository: createMemoryDeveloperModuleReleaseRepository(),
    });
    const item = validModuleItem() as ReturnType<typeof validModuleItem> & {
      module: ReturnType<typeof validModuleItem>['module'] & {
        execution: { mode: string; entry?: string };
        permissions: ReturnType<typeof validModuleItem>['module']['permissions'] & {
          desktop?: string[];
        };
      };
    };
    item.module.execution = { mode: 'desktop-native', entry: 'desktop/main.js' };
    item.module.permissions.desktop = ['filesystem.read'];

    const result = await service.submit({ accountId: ACCOUNT_ID, actorUserId: USER_ID, item });

    expect(result.release.review_requirements).toEqual([
      'manifest_review',
      'source_scan',
      'sandbox_test',
      'permission_review',
      'desktop_security_review',
      'human_review',
    ]);
  });
});
