import { describe, expect, mock, test } from 'bun:test';

const realFs = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const realOpenSync = realFs.openSync;
let openCalls = 0;

mock.module('node:fs', () => ({
  ...realFs,
  openSync: (...args: Parameters<typeof realOpenSync>) => {
    openCalls += 1;
    return realOpenSync(...args);
  },
}));

const { readPublicBetaBoundedBytes }: typeof import('./public-beta-safe-files') = await import(
  // @ts-expect-error Bun resolves query-string module specifiers as isolated modules.
  './public-beta-safe-files?open-guard'
);

describe('public beta safe file open guard', () => {
  test('does not open a directory presented as a candidate file', () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-safe-'));
    const directory = join(root, 'directory');
    realFs.mkdirSync(directory);
    try {
      expect(
        readPublicBetaBoundedBytes({
          root,
          path: 'directory',
          maxBytes: 1024,
        }),
      ).toBe(false);
      expect(openCalls).toBe(0);
    } finally {
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
