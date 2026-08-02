const { afterAll, beforeEach, expect, mock, test } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openopc-main-ipc-'));
let userData = path.join(directory, 'user-data');
let invokeHandler = null;
const stopAfterIpcRegistration = new Error('TEST_STOP_AFTER_IPC_REGISTRATION');

const app = {
  isPackaged: false,
  getName: () => 'OpenOPC Dev',
  getPath: (name) => (name === 'userData' ? userData : directory),
  on: () => {},
  quit: () => {},
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient: () => {},
  setPath: (name, value) => {
    if (name === 'userData') userData = value;
  },
  userAgentFallback: 'Mozilla/5.0 Electron/39.8.1 OpenOPC Dev/0.1.0',
  whenReady: () => ({
    // biome-ignore lint/suspicious/noThenProperty: stop startup immediately after IPC registration
    then(callback) {
      callback();
    },
  }),
};

mock.module('electron', () => ({
  app,
  BrowserWindow: { fromWebContents: () => null },
  dialog: {},
  ipcMain: {
    handle(channel, handler) {
      if (channel === 'kortix:invoke') {
        invokeHandler = handler;
        throw stopAfterIpcRegistration;
      }
    },
  },
  Menu: {},
  nativeTheme: {},
  safeStorage: {},
  shell: {},
}));
mock.module('electron-updater', () => ({ autoUpdater: {} }));

await import(`./main.js?ipc-test=${Date.now()}`).catch((error) => {
  expect(error).toBe(stopAfterIpcRegistration);
});

const event = {
  sender: {},
  senderFrame: { url: 'http://localhost:3000/projects' },
};

beforeEach(() => {
  fs.rmSync(path.join(userData, 'frontend_url'), { force: true });
});

afterAll(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

test('rejects a custom frontend URL without an explicit scheme', () => {
  expect(invokeHandler).toBeFunction();
  expect(() =>
    invokeHandler(event, 'set_frontend_url', { url: 'app.openopc.example/projects' }),
  ).toThrow('Invalid OpenOPC Web URL');
  expect(fs.existsSync(path.join(userData, 'frontend_url'))).toBe(false);
});

test.each([' https://app.openopc.example/projects', 'https://app.openopc.example/projects '])(
  'rejects surrounding whitespace in a custom frontend URL: %s',
  (url) => {
    expect(invokeHandler).toBeFunction();
    expect(() => invokeHandler(event, 'set_frontend_url', { url })).toThrow(
      'Invalid OpenOPC Web URL',
    );
    expect(fs.existsSync(path.join(userData, 'frontend_url'))).toBe(false);
  },
);
