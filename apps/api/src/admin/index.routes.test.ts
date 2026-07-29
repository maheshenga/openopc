import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('the production admin app exposes revision-fenced developer application decisions', () => {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      '-e',
      "const { adminApp } = await import('./src/admin/index.ts'); console.log(JSON.stringify(adminApp.routes.map(({ method, path }) => `${method} ${path}`)));",
    ],
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      ALLOWED_SANDBOX_PROVIDERS: '',
      API_KEY_SECRET: 'admin-route-test-secret',
      DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:65432/kortix',
      FRONTEND_URL: 'http://localhost:3000',
      INTERNAL_KORTIX_ENV: 'dev',
      RECALL_BASE_URL: 'http://localhost:3001',
      SUPABASE_SERVICE_ROLE_KEY: 'admin-route-test-service-role',
      SUPABASE_URL: 'http://localhost:54321',
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  const output = result.stdout.toString().trim().split(/\r?\n/).at(-1);
  const routes = JSON.parse(output ?? '[]') as string[];

  expect(routes).toContain('POST /developer/applications/:applicationId/decision');
  expect(routes).toContain('POST /developer/applications/:applicationId/suspend');
}, 30_000);
