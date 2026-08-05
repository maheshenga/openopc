#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageDir = process.cwd();
const stageScript = join(packageDir, '..', '..', 'scripts', 'stage-npm-publish.mjs');
const pnpm = process.env.PNPM_BIN || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const npm = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const workdir = mkdtempSync(join(tmpdir(), 'openopc-developer-sdk-smoke-'));
const stagedDir = join(workdir, 'package');
const consumerDir = join(workdir, 'consumer');

const run = (command, args, cwd, env = process.env) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
  });

function assertNoPrivateContractImports(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertNoPrivateContractImports(path);
    } else if (/\.(?:js|d\.ts)$/.test(entry.name)) {
      if (readFileSync(path, 'utf8').includes('@kortix/api-contract')) {
        throw new Error(`Published artifact imports a private contract: ${entry.name}`);
      }
    }
  }
}

let outcomeError;
try {
  console.log('Building dist/');
  run(pnpm, ['run', 'build'], packageDir);

  mkdirSync(stagedDir, { recursive: true });
  copyFileSync(join(packageDir, 'package.json'), join(stagedDir, 'package.json'));
  copyFileSync(join(packageDir, 'README.md'), join(stagedDir, 'README.md'));
  cpSync(join(packageDir, 'dist'), join(stagedDir, 'dist'), { recursive: true });
  cpSync(join(packageDir, 'examples'), join(stagedDir, 'examples'), { recursive: true });
  assertNoPrivateContractImports(join(stagedDir, 'dist'));

  console.log('Staging and packing the published manifest');
  run('node', [stageScript], stagedDir, { ...process.env, VERSION: '0.0.0-smoke' });
  const stagedManifest = JSON.parse(readFileSync(join(stagedDir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(stagedManifest[field] ?? {})) {
      if (name.startsWith('@kortix/') || String(range).startsWith('workspace:')) {
        throw new Error(`Published runtime dependency is private: ${name}@${range}`);
      }
    }
  }
  const tarball = run(npm, ['pack', '--silent'], stagedDir).trim().split(/\r?\n/).pop();
  const tarballPath = join(stagedDir, tarball);

  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2)}\n`,
  );
  console.log(`Installing ${tarballPath}`);
  run(npm, ['install', '--no-audit', '--no-fund', tarballPath], consumerDir);
  writeFileSync(
    join(consumerDir, 'smoke.mjs'),
    [
      "import { OPENOPC_SERVICE_NAMES, OpenOpcBrowserModuleBootstrapProtocolError, OpenOpcModuleRequestError, createOpenOpcBrowserCapabilityTokenAdapter, createOpenOpcBrowserModuleClient, createOpenOpcModuleClient } from '@openopc/developer-sdk';",
      "if (OPENOPC_SERVICE_NAMES.join(',') !== 'ai,payment') throw new Error('contracts missing');",
      "if (typeof createOpenOpcBrowserCapabilityTokenAdapter !== 'function') throw new Error('browser adapter missing');",
      "if (typeof createOpenOpcBrowserModuleClient !== 'function') throw new Error('browser module bootstrap missing');",
      "if (new OpenOpcBrowserModuleBootstrapProtocolError('test').name !== 'OpenOpcBrowserModuleBootstrapProtocolError') throw new Error('browser bootstrap error missing');",
      "if (new OpenOpcModuleRequestError('OPENOPC_MODULE_REQUEST_ABORTED').code !== 'OPENOPC_MODULE_REQUEST_ABORTED') throw new Error('request error missing');",
      "const client = createOpenOpcModuleClient({ baseUrl: 'https://platform.example.com', getCapabilityToken: async () => 'v4.public.smoke-token', fetch: async () => new Response('{}') });",
      "if (typeof client.ai.models.list !== 'function') throw new Error('AI facade missing');",
      "if (typeof client.payments.orders.create !== 'function') throw new Error('payment facade missing');",
      "console.log('OK: @openopc/developer-sdk imports and constructs from the packed tarball');",
    ].join('\n'),
  );
  process.stdout.write(run('node', ['smoke.mjs'], consumerDir));
  console.log('Install smoke test passed');
} catch (error) {
  outcomeError = error;
} finally {
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch (cleanupError) {
    outcomeError ??= cleanupError;
  }
}

if (outcomeError) throw outcomeError;
