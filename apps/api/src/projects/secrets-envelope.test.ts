import { expect, test } from 'bun:test';

test('project secret wrappers delegate envelope crypto to studio-runtime', async () => {
  const source = await Bun.file(new URL('./secrets.ts', import.meta.url)).text();

  expect(source).toContain("from '@kortix/studio-runtime/secret-envelope'");
  expect(source).not.toContain('hkdfSync');
  expect(source).not.toContain('createCipheriv');
  expect(source).not.toContain('createDecipheriv');
  expect(source).not.toContain("const ENVELOPE_VERSION");
});
