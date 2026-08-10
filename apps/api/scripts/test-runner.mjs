import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, relative, resolve, sep, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC_ROOT = resolve(API_ROOT, 'src');
const MODES = new Set(['default', 'integration', 'live', 'all']);

export function emptyEnvFile(platform = process.platform) {
  return platform === 'win32' ? 'NUL' : '/dev/null';
}

export function isDefaultTestFile(file) {
  const normalized = file.split('\\').join('/');
  const name = basename(normalized);
  return (
    normalized.startsWith('src/') &&
    name.endsWith('.test.ts') &&
    !name.startsWith('integration-') &&
    !name.endsWith('.live.test.ts')
  );
}

export function shouldLoadEncryptedEnvironment(mode) {
  return mode === 'integration' || mode === 'live';
}

function environmentValue(environment, name) {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

function addWindowsToolsToPath(environment, pathExists) {
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const currentPath = environment[pathKey] ?? '';
  const programFiles = environmentValue(environment, 'ProgramFiles');
  const programFilesX86 = environmentValue(environment, 'ProgramFiles(x86)');
  const localAppData = environmentValue(environment, 'LocalAppData');
  const userProfile = environmentValue(environment, 'UserProfile');
  const candidates = [
    [programFiles && win32.join(programFiles, 'Git', 'cmd'), 'git.exe'],
    [programFilesX86 && win32.join(programFilesX86, 'Git', 'cmd'), 'git.exe'],
    [localAppData && win32.join(localAppData, 'Programs', 'Git', 'cmd'), 'git.exe'],
    [userProfile && win32.join(userProfile, '.bun', 'bin'), 'bun.exe'],
    [localAppData && win32.join(localAppData, 'Microsoft', 'WinGet', 'Links'), 'bun.exe'],
    [
      localAppData &&
        win32.join(
          localAppData,
          'Microsoft',
          'WinGet',
          'Packages',
          'Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe',
          'bun-windows-x64',
        ),
      'bun.exe',
    ],
  ]
    .filter(([directory, executable]) =>
      directory ? pathExists(win32.join(directory, executable)) : false,
    )
    .map(([directory]) => directory);
  const entries = [...candidates, ...currentPath.split(';').filter(Boolean)];
  environment[pathKey] = entries
    .filter(
      (entry, index) =>
        entries.findIndex((candidate) => candidate.toLowerCase() === entry.toLowerCase()) === index,
    )
    .join(';');
}

export function createToolEnvironment(
  baseEnvironment = process.env,
  { platform = process.platform, pathExists = existsSync } = {},
) {
  const environment = { ...baseEnvironment };
  if (platform === 'win32') addWindowsToolsToPath(environment, pathExists);
  return environment;
}

export function createUnitTestEnvironment(baseEnvironment = process.env, options = {}) {
  const environment = {
    ...createToolEnvironment(baseEnvironment, options),
    NODE_ENV: 'test',
    PORT: '8008',
    DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    API_KEY_SECRET: 'test-api-key-secret-at-least-32-bytes',
    INTERNAL_KORTIX_ENV: 'dev',
    KORTIX_BILLING_INTERNAL_ENABLED: 'false',
    LLM_GATEWAY_ENABLED: 'false',
    KORTIX_URL: 'http://127.0.0.1:8008',
    FRONTEND_URL: 'http://localhost:3000',
    RECALL_BASE_URL: 'http://127.0.0.1:9000',
    INTERNAL_SERVICE_KEY: 'test-internal-service-key-at-least-32-bytes',
    TUNNEL_SIGNING_SECRET: 'test-test-test-test-test-test-test-test',
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    DAYTONA_API_KEY: 'test-daytona-api-key',
    DAYTONA_SERVER_URL: 'http://127.0.0.1:3001',
    DAYTONA_TARGET: 'local',
    PIPEDREAM_CLIENT_ID: 'test-pipedream-client-id',
    PIPEDREAM_CLIENT_SECRET: 'test-pipedream-client-secret',
    PIPEDREAM_PROJECT_ID: 'test-pipedream-project-id',
    PIPEDREAM_ENVIRONMENT: 'test',
    PIPEDREAM_WEBHOOK_SECRET: 'test-pipedream-webhook-secret',
  };
  return environment;
}

export function buildBunTestArgs({ platform = process.platform, coverage = false, files }) {
  const args = [`--env-file=${emptyEnvFile(platform)}`, 'test', '--isolate', '--max-concurrency=1'];
  if (coverage) {
    args.push(
      '--coverage',
      '--coverage-reporter=lcov',
      '--coverage-reporter=text',
      '--coverage-dir=coverage',
    );
  }
  return [...args, ...files];
}

async function walkFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function relativeTestPath(file) {
  return relative(API_ROOT, file).split(sep).join('/');
}

async function discoverTestFiles(mode) {
  const files = (await walkFiles(SRC_ROOT)).map(relativeTestPath).sort();
  if (mode === 'default') return files.filter(isDefaultTestFile);
  if (mode === 'integration') {
    return files.filter((file) => /^src\/__tests__\/integration-.*\.test\.ts$/.test(file));
  }
  if (mode === 'live') {
    return files.filter((file) => file === 'src/llm-gateway/__tests__/gateway.live.test.ts');
  }
  throw new Error(`Unsupported API test mode: ${mode}`);
}

function runProcess(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: API_ROOT,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function runMode(mode, coverage) {
  const files = await discoverTestFiles(mode);
  if (files.length === 0) throw new Error(`No API ${mode} test files were found`);

  const bunArgs = buildBunTestArgs({ coverage, files });
  if (!shouldLoadEncryptedEnvironment(mode)) {
    return runProcess('bun', bunArgs, createUnitTestEnvironment());
  }

  const dotenvx = process.platform === 'win32' ? 'dotenvx.cmd' : 'dotenvx';
  const environment = {
    ...createToolEnvironment(),
    ...(mode === 'live' ? { RUN_LIVE_LLM_TESTS: '1' } : {}),
  };
  return runProcess(dotenvx, ['run', '--', 'bun', ...bunArgs], environment);
}

function parseArguments(args) {
  const coverage = args.includes('--coverage') || process.env.COVERAGE === '1';
  const positional = args.filter((argument) => argument !== '--coverage');
  const mode = positional[0] ?? 'default';
  if (positional.length > 1 || !MODES.has(mode)) {
    throw new Error('usage: test-runner.mjs [default|integration|live|all] [--coverage]');
  }
  if (coverage && mode !== 'default') {
    throw new Error('coverage is supported only for the default API test suite');
  }
  return { mode, coverage };
}

async function main() {
  const { mode, coverage } = parseArguments(process.argv.slice(2));
  const modes = mode === 'all' ? ['default', 'integration'] : [mode];
  for (const currentMode of modes) {
    const status = await runMode(currentMode, coverage);
    if (status !== 0) return status;
  }
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
