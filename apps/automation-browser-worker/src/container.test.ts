import { expect, test } from 'bun:test';

test('container pins matching Playwright and Bun runtimes and applies rootless process limits', async () => {
  const packageJson = await Bun.file(new URL('../package.json', import.meta.url)).json();
  const dockerfile = await Bun.file(new URL('../Dockerfile', import.meta.url)).text();
  const playwrightVersion = packageJson.dependencies.playwright;

  expect(playwrightVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(dockerfile).toContain(`mcr.microsoft.com/playwright:v${playwrightVersion}-noble`);
  expect(dockerfile).toMatch(/^FROM oven\/bun:\d+\.\d+\.\d+ AS bun-runtime$/m);
  expect(dockerfile).toContain('COPY --from=bun-runtime /usr/local/bin/bun');
  expect(dockerfile).toContain('USER pwuser');
  expect(dockerfile).toContain('ulimit -t');
  expect(dockerfile).toContain('ulimit -v');
  expect(dockerfile).not.toMatch(/^VOLUME/m);
});
