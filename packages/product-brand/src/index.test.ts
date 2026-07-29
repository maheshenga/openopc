import { describe, expect, test } from 'bun:test';

import { PRODUCT_BRAND, openOpcEnv } from './index';

describe('OpenOPC product brand', () => {
  test('exposes one public name for Web, Desktop, and local execution', () => {
    expect(PRODUCT_BRAND).toEqual({
      displayName: 'OpenOPC',
      desktopName: 'OpenOPC Desktop',
      localNodeName: 'OpenOPC Local Execution',
    });
  });

  test('prefers the OpenOPC setting over its legacy Kortix fallback', () => {
    expect(
      openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', {
        OPENOPC_DESKTOP_URL: 'https://app.openopc.example/projects',
        KORTIX_DESKTOP_URL: 'https://kortix.example/projects',
      }),
    ).toBe('https://app.openopc.example/projects');
  });

  test('falls back to the legacy setting when the OpenOPC setting is absent or empty', () => {
    const legacy = { KORTIX_DESKTOP_URL: 'https://kortix.example/projects' };

    expect(openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', legacy)).toBe(
      'https://kortix.example/projects',
    );
    expect(
      openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', {
        ...legacy,
        OPENOPC_DESKTOP_URL: '',
      }),
    ).toBe('https://kortix.example/projects');
  });

  test('returns undefined when neither setting is configured', () => {
    expect(openOpcEnv('OPENOPC_DESKTOP_URL', 'KORTIX_DESKTOP_URL', {})).toBeUndefined();
  });
});
