const { expect, mock, test } = require('bun:test');
const path = require('node:path');

test('starts the development channel with its isolated legacy user data directory', async () => {
  let configuredUserData = null;
  const app = {
    isPackaged: false,
    getName: () => 'OpenOPC Dev',
    getPath: () => 'C:/Users/test/AppData/Roaming',
    quit: () => {},
    requestSingleInstanceLock: () => false,
    setPath: (name, value) => {
      if (name === 'userData') configuredUserData = value;
    },
  };

  mock.module('electron', () => ({
    app,
    BrowserWindow: {},
    dialog: {},
    ipcMain: {},
    Menu: {},
    nativeTheme: {},
    safeStorage: {},
    shell: {},
  }));
  mock.module('electron-updater', () => ({ autoUpdater: {} }));

  await import(`./main.js?startup-test=${Date.now()}`);

  expect(configuredUserData).toBe(path.join('C:/Users/test/AppData/Roaming', 'Kortix Dev Desktop'));
});

test('fails packaged startup before creating a window when OpenOPC metadata is absent', async () => {
  let windowsCreated = 0;
  const app = {
    isPackaged: true,
    getName: () => 'OpenOPC',
    getPath: () => 'C:/Users/test/AppData/Roaming',
    quit: () => {},
    requestSingleInstanceLock: () => false,
    setPath: () => {},
  };

  mock.module('electron', () => ({
    app,
    BrowserWindow: function BrowserWindow() {
      windowsCreated += 1;
    },
    dialog: {},
    ipcMain: {},
    Menu: {},
    nativeTheme: {},
    safeStorage: {},
    shell: {},
  }));
  mock.module('electron-updater', () => ({ autoUpdater: {} }));

  await expect(import(`./main.js?packaged-missing-url=${Date.now()}`)).rejects.toThrow(
    'OPENOPC_DESKTOP_URL_REQUIRED',
  );
  expect(windowsCreated).toBe(0);
});
