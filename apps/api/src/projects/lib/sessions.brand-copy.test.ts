import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

test('concurrent-session support copy names the OpenOPC team', () => {
  const sessionsUrl = pathToFileURL(resolve(import.meta.dir, 'sessions.ts')).href;
  const apiRoot = resolve(import.meta.dir, '../../..');
  const expected =
    "You've reached your plan's concurrent-session limit (12). Upgrade your plan for a higher limit, or contact the OpenOPC team to raise it for your account.";
  const script = `const { getConcurrentSessionLimitMessage } = await import(${JSON.stringify(
    sessionsUrl,
  )}); process.stdout.write(getConcurrentSessionLimitMessage(12));`;

  const result = Bun.spawnSync([process.execPath, '-e', script], {
    cwd: apiRoot,
    env: {
      ...process.env,
      SUPABASE_URL: 'http://localhost:54321',
      INTERNAL_KORTIX_ENV: 'dev',
      RECALL_BASE_URL: 'http://localhost:8787',
      FRONTEND_URL: 'http://localhost:3000',
      ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    },
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(expected);
});
