import { expect, mock, test } from 'bun:test';

import * as maintenanceModule from './use-maintenance-admin';

const CONFIG = {
  level: 'none' as const,
  title: '',
  message: '',
  updatedAt: '1970-01-01T00:00:00.000Z',
};

test('fetchMaintenanceAdminConfig reads maintenance through the Admin proxy', async () => {
  expect(maintenanceModule.fetchMaintenanceAdminConfig).toBeFunction();
  const get = mock(async (path: string) => {
    expect(path).toBe('/system/maintenance');
    return { success: true, data: CONFIG };
  });

  try {
    await expect(
      maintenanceModule.fetchMaintenanceAdminConfig({ get, put: async () => ({ success: true, data: CONFIG }) } as never),
    ).resolves.toEqual(CONFIG);
  } finally {
    get.mockRestore();
  }
});

test('updateMaintenanceAdminConfig writes maintenance through the Admin proxy', async () => {
  expect(maintenanceModule.updateMaintenanceAdminConfig).toBeFunction();
  const put = mock(async (path: string, data: unknown) => {
    expect(path).toBe('/system/maintenance');
    expect(data).toEqual({ level: 'none' });
    return { success: true, data: CONFIG };
  });

  try {
    await expect(
      maintenanceModule.updateMaintenanceAdminConfig(
        { level: 'none' },
        { get: async () => ({ success: true, data: CONFIG }), put } as never,
      ),
    ).resolves.toEqual(CONFIG);
  } finally {
    put.mockRestore();
  }
});
