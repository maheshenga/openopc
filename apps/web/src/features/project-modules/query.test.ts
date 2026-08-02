import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = '20000000-0000-4000-8000-000000000002';
const RELEASE_ID = '30000000-0000-4000-8000-000000000003';

const launchDescriptor = {
  installation_id: INSTALLATION_ID,
  release_id: RELEASE_ID,
  install_revision: 7,
  module_id: 'openopc.recruiting',
  module_version: '2.0.0',
  execution_mode: 'sandboxed-web' as const,
  url: 'https://modules.openopc.example/releases/release-v2/index.html',
  origin: 'https://modules.openopc.example',
};
const releaseDetail = {
  id: `openopc-module:${RELEASE_ID}`,
  release_id: RELEASE_ID,
  module_id: launchDescriptor.module_id,
  module_version: launchDescriptor.module_version,
  name: 'Recruiting workflow',
  publisher_id: 'openopc',
  signature_key_id: 'openopc-2026',
  signed_at: '2026-08-01T00:00:00.000Z',
  published_at: '2026-08-01T00:01:00.000Z',
  manifest: {
    schemaVersion: 3,
    execution: { mode: 'sandboxed-web', entry: 'web/index.html' },
  },
};

const getProjectModuleLaunch = mock(async () => launchDescriptor);
const getMarketplaceCatalogItem = mock(async (): Promise<Record<string, unknown>> => releaseDetail);
const listMarketplaceCatalogItems = mock(async () => ({ items: [] }));
const sdkNoop = mock(async () => ({}));

mock.module('@kortix/sdk', () => ({
  backendApi: {
    delete: sdkNoop,
    get: sdkNoop,
    post: sdkNoop,
    put: sdkNoop,
  },
  getMarketplaceCatalogItem,
  getProjectModuleLaunch,
  installProjectModule: sdkNoop,
  listMarketplaceCatalogItems,
  listProjectModuleInstallationHistory: sdkNoop,
  listProjectModules: sdkNoop,
  rollbackProjectModule: sdkNoop,
  updateProjectModule: sdkNoop,
}));

const { projectModuleErrorCode, projectModuleLaunchQuery, projectModuleReleaseQuery } =
  await import('./query');

beforeEach(() => {
  getProjectModuleLaunch.mockClear();
  getMarketplaceCatalogItem.mockClear();
  listMarketplaceCatalogItems.mockClear();
  getProjectModuleLaunch.mockImplementation(async () => launchDescriptor);
  getMarketplaceCatalogItem.mockImplementation(async () => releaseDetail);
});

describe('Project Modules queries', () => {
  test('loads the server-authoritative launch descriptor through the SDK', async () => {
    await expect(projectModuleLaunchQuery(PROJECT_ID, INSTALLATION_ID).queryFn()).resolves.toEqual(
      launchDescriptor,
    );
    expect(getProjectModuleLaunch).toHaveBeenCalledWith(PROJECT_ID, INSTALLATION_ID);
  });

  test('loads one exact published release detail instead of scanning the catalog', async () => {
    await expect(projectModuleReleaseQuery(RELEASE_ID).queryFn()).resolves.toMatchObject({
      release_id: RELEASE_ID,
      module_id: launchDescriptor.module_id,
      module_version: launchDescriptor.module_version,
    });
    expect(getMarketplaceCatalogItem).toHaveBeenCalledWith(`openopc-module:${RELEASE_ID}`);
    expect(listMarketplaceCatalogItems).not.toHaveBeenCalled();
  });

  test('fails closed when exact published release detail is missing or mismatched', async () => {
    getMarketplaceCatalogItem.mockResolvedValueOnce({ id: `openopc-module:${RELEASE_ID}` });
    await expect(projectModuleReleaseQuery(RELEASE_ID).queryFn()).rejects.toThrow(
      'Published project module release is unavailable',
    );

    getMarketplaceCatalogItem.mockResolvedValueOnce({
      ...releaseDetail,
      release_id: '40000000-0000-4000-8000-000000000004',
    });
    await expect(projectModuleReleaseQuery(RELEASE_ID).queryFn()).rejects.toThrow(
      'Published project module release is unavailable',
    );
  });

  test('maps API error payloads carried in the SDK data field', () => {
    expect(
      projectModuleErrorCode({
        status: 409,
        data: { error: 'PROJECT_MODULE_INSTALL_CONFLICT' },
      }),
    ).toBe('PROJECT_MODULE_INSTALL_CONFLICT');
  });

  test('maps every bounded launch and capability error code', () => {
    for (const code of [
      'PROJECT_MODULE_INACTIVE',
      'PROJECT_MODULE_NOT_LAUNCHABLE',
      'PROJECT_MODULE_LAUNCH_STALE',
      'PROJECT_MODULE_HOST_UNAVAILABLE',
      'OPENOPC_CAPABILITY_UNAVAILABLE_FOR_RELEASE_PROFILE',
    ] as const) {
      expect(projectModuleErrorCode({ code })).toBe(code);
    }
  });
});
