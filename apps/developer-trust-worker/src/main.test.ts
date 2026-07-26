import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readDeveloperTrustBinarySecret } from './main';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('acceptance HMAC keys are read as exact bounded binary bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'openopc-acceptance-key-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'acceptance-hmac');
  const key = new Uint8Array(32).fill(7);
  key[key.byteLength - 1] = 0x0a;
  await writeFile(path, key);

  expect(readDeveloperTrustBinarySecret(path, 32, 128)).toEqual(key);

  for (const size of [31, 129]) {
    await writeFile(path, new Uint8Array(size).fill(1));
    expect(() => readDeveloperTrustBinarySecret(path, 32, 128)).toThrow(
      'DEVELOPER_TRUST_SECRET_INVALID',
    );
  }
});
