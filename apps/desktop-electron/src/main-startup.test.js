const { expect, mock, test } = require('bun:test');
const path = require('node:path');

test('starts the development channel with its isolated legacy user data directory', async () => {
  let configuredUserData = null;
  const app = {
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
