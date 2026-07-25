#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(scriptDir, '../..');
const baseUrl = process.env.WEB_BASE_URL || process.env.E2E_BASE_URL || 'http://127.0.0.1:3312';
const target = new URL(baseUrl);
const nextBin = path.join(webRoot, 'node_modules/next/dist/bin/next');
const smokeScript = path.join(scriptDir, 'developer-center-review-smoke.ts');
const serverReadyTimeoutMs = Number(process.env.E2E_SERVER_READY_TIMEOUT_MS || 240_000);
if (!Number.isFinite(serverReadyTimeoutMs) || serverReadyTimeoutMs <= 0) {
  throw new Error('E2E_SERVER_READY_TIMEOUT_MS must be a positive number');
}
const testRuntimeEnvironment = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_ANON_KEY: 'openopc-developer-center-e2e-anon-key',
  BACKEND_URL: 'http://127.0.0.1:8008/v1',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'openopc-developer-center-e2e-anon-key',
  NEXT_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8008/v1',
};

async function reachable() {
  try {
    const response = await fetch(`${baseUrl}/debug/developer-center`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

async function waitForServer(child) {
  const deadline = Date.now() + serverReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Developer Center web server exited with code ${child.exitCode}`);
    }
    if (await reachable()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Developer Center web server did not become ready at ${baseUrl}`);
}

function stopServer(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
}

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', smokeScript], {
      cwd: webRoot,
      env: { ...process.env, WEB_BASE_URL: baseUrl },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Developer Center smoke terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

let server = null;
try {
  if (!(await reachable())) {
    if (!['127.0.0.1', 'localhost', '::1'].includes(target.hostname)) {
      throw new Error(`Refusing to start a local web server for non-local target ${baseUrl}`);
    }
    server = spawn(
      process.execPath,
      [nextBin, 'dev', '--turbopack', '--port', target.port || '3312'],
      {
        cwd: webRoot,
        env: {
          ...process.env,
          ...testRuntimeEnvironment,
          WEB_PORT: target.port || '3312',
        },
        stdio: 'inherit',
      },
    );
    await waitForServer(server);
  }
  process.exitCode = await runSmoke();
} finally {
  stopServer(server);
}
