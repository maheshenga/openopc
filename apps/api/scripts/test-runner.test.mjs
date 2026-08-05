import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildBunTestArgs,
  createToolEnvironment,
  createUnitTestEnvironment,
  emptyEnvFile,
  isDefaultTestFile,
  shouldLoadEncryptedEnvironment,
} from './test-runner.mjs';

test('default API test discovery excludes only dedicated integration and live files', () => {
  assert.equal(isDefaultTestFile('src/example.test.ts'), true);
  assert.equal(isDefaultTestFile('src/developer/artifact-retention.integration.test.ts'), true);
  assert.equal(isDefaultTestFile('src/__tests__/integration-projects.test.ts'), false);
  assert.equal(isDefaultTestFile('src/llm-gateway/__tests__/gateway.live.test.ts'), false);
  assert.equal(isDefaultTestFile('src/example.ts'), false);
});

test('unit test invocation disables automatic dotenv loading and preserves coverage options', () => {
  assert.equal(emptyEnvFile('win32'), 'NUL');
  assert.equal(emptyEnvFile('linux'), '/dev/null');
  assert.deepEqual(
    buildBunTestArgs({
      platform: 'win32',
      coverage: true,
      files: ['src/a.test.ts', 'src/b.test.ts'],
    }),
    [
      '--env-file=NUL',
      'test',
      '--isolate',
      '--max-concurrency=1',
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-reporter=text',
      '--coverage-dir=coverage',
      'src/a.test.ts',
      'src/b.test.ts',
    ],
  );
});

test('unit test environment replaces encrypted deployment values with safe local placeholders', () => {
  const environment = createUnitTestEnvironment({
    DATABASE_URL: 'encrypted:database',
    SUPABASE_URL: 'encrypted:supabase',
    SUPABASE_SERVICE_ROLE_KEY: 'encrypted:service-role',
    API_KEY_SECRET: 'encrypted:api-key',
    KEEP_ME: 'unchanged',
  });

  assert.equal(environment.NODE_ENV, 'test');
  assert.equal(environment.INTERNAL_KORTIX_ENV, 'dev');
  assert.match(environment.DATABASE_URL, /^postgresql:\/\//);
  assert.equal(environment.SUPABASE_URL, 'http://127.0.0.1:54321');
  assert.equal(environment.SUPABASE_SERVICE_ROLE_KEY, 'test-service-role-key');
  assert.equal(environment.API_KEY_SECRET, 'test-api-key-secret-at-least-32-bytes');
  assert.equal(environment.ALLOWED_SANDBOX_PROVIDERS, 'daytona');
  assert.equal(environment.DAYTONA_API_KEY, 'test-daytona-api-key');
  assert.equal(environment.DAYTONA_SERVER_URL, 'http://127.0.0.1:3001');
  assert.equal(environment.DAYTONA_TARGET, 'local');
  assert.equal(environment.PIPEDREAM_CLIENT_ID, 'test-pipedream-client-id');
  assert.equal(environment.PIPEDREAM_CLIENT_SECRET, 'test-pipedream-client-secret');
  assert.equal(environment.PIPEDREAM_PROJECT_ID, 'test-pipedream-project-id');
  assert.equal(environment.KEEP_ME, 'unchanged');
});

test('unit test environment exposes standard Windows Git and Bun installations', () => {
  const environment = createUnitTestEnvironment(
    {
      Path: 'C:\\Windows\\System32',
      ProgramFiles: 'C:\\Program Files',
      LocalAppData: 'C:\\Users\\test\\AppData\\Local',
    },
    {
      platform: 'win32',
      pathExists: (path) =>
        [
          'C:\\Program Files\\Git\\cmd\\git.exe',
          'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe',
        ].includes(path),
    },
  );

  assert.equal(
    environment.Path,
    'C:\\Program Files\\Git\\cmd;C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Windows\\System32',
  );
});

test('encrypted modes can add Windows tools without replacing deployment values', () => {
  const environment = createToolEnvironment(
    {
      Path: 'C:\\Windows\\System32',
      LocalAppData: 'C:\\Users\\test\\AppData\\Local',
      DATABASE_URL: 'encrypted:database',
    },
    {
      platform: 'win32',
      pathExists: (path) =>
        path === 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links\\bun.exe',
    },
  );

  assert.equal(
    environment.Path,
    'C:\\Users\\test\\AppData\\Local\\Microsoft\\WinGet\\Links;C:\\Windows\\System32',
  );
  assert.equal(environment.DATABASE_URL, 'encrypted:database');
});

test('only integration and live modes load the encrypted environment', () => {
  assert.equal(shouldLoadEncryptedEnvironment('default'), false);
  assert.equal(shouldLoadEncryptedEnvironment('integration'), true);
  assert.equal(shouldLoadEncryptedEnvironment('live'), true);
});

test('package scripts use the cross-platform runner instead of Bash syntax', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(packageJson.scripts.test, 'node scripts/test-runner.mjs');
  assert.equal(packageJson.scripts['test:coverage'], 'node scripts/test-runner.mjs --coverage');
  assert.equal(packageJson.scripts['test:integration'], 'node scripts/test-runner.mjs integration');
  assert.equal(packageJson.scripts['test:live'], 'node scripts/test-runner.mjs live');
  assert.equal(packageJson.scripts['test:all'], 'node scripts/test-runner.mjs all');
});
