import { describe, expect, test } from 'bun:test';

import { createElectronSmokeLaunchOptions } from './electron-smoke-launch';

describe('Electron smoke launch options', () => {
  test('uses the app switch and pipe-compatible isolated environment', () => {
    const options = createElectronSmokeLaunchOptions({
      executablePath: 'E:/runtime/electron.exe',
      desktopRoot: 'E:\\repo\\apps\\desktop-electron',
      appDataDir: 'E:/temp/electron-smoke',
      baseUrl: 'http://localhost:3300',
      baseEnv: { EXISTING_FLAG: 'retained' },
    });

    expect(options).toEqual({
      executablePath: 'E:/runtime/electron.exe',
      args: ['--app=E:/repo/apps/desktop-electron'],
      env: {
        EXISTING_FLAG: 'retained',
        APPDATA: 'E:/temp/electron-smoke',
        HOME: 'E:/temp/electron-smoke',
        XDG_CONFIG_HOME: 'E:/temp/electron-smoke',
        KORTIX_DESKTOP_URL: 'http://localhost:3300/robots.txt',
        KORTIX_DESKTOP_DEFAULT_URL: 'http://localhost:3300/robots.txt',
      },
      headless: false,
      timeout: 60_000,
    });
    expect(options.args.every((argument) => argument.startsWith('-'))).toBe(true);
    expect(options.args.join(' ')).not.toContain('remote-debugging-port');
    expect(options.args.join(' ')).not.toContain('inspect');
  });
});
