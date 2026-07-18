#!/usr/bin/env node
/**
 * Packs @kortix/sdk exactly as npm publish would, installs the tarballs into a
 * throwaway project, and imports them in Node ESM.
 *
 * This is the only check that exercises the published artifact's module
 * resolution. npm pack --dry-run lists tarball contents; stage-npm-publish.mjs
 * asserts publishConfig paths exist in dist/. Neither proves the thing imports.
 *
 * @kortix/llm-catalog and @kortix/intelligence-contracts are workspace:*
 * dependencies that stage-npm-publish.mjs pins to the release version. The
 * smoke run mirrors that lockstep: it packs both siblings at the same synthetic
 * version and installs all three tarballs together, so the pinned dependencies
 * resolve hermetically instead of hitting the registry for versions that only
 * exist during this run.
 *
 * Run from packages/sdk: node scripts/smoke-install.mjs
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG_DIR = process.cwd();
const CATALOG_DIR = join(PKG_DIR, '..', 'llm-catalog');
const CONTRACT_DIR = join(PKG_DIR, '..', 'intelligence-contracts');
const STAGE_SCRIPT = join(PKG_DIR, '..', '..', 'scripts', 'stage-npm-publish.mjs');
const PNPM = process.env.PNPM_BIN || (process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
const NPM = process.env.NPM_BIN || (process.platform === 'win32' ? 'npm.cmd' : 'npm');

/** execFileSync takes an options object: cwd and env both live there. */
const run = (cmd, args, cwd, env) =>
  execFileSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd),
  });

const stage = (dir) =>
  run('node', [STAGE_SCRIPT], dir, {
    ...process.env,
    VERSION: '0.0.0-smoke',
  });

const workdir = mkdtempSync(join(tmpdir(), 'kortix-sdk-smoke-'));

/**
 * Stage and pack a throwaway copy of one published package. Never mutate the
 * source workspace manifest: a SIGINT/SIGTERM can stop the process before a
 * finally block runs, while an abandoned temporary directory is safe.
 */
function packStagedPackage(sourceDir, name) {
  const packageDir = join(workdir, 'packages', name);
  mkdirSync(packageDir, { recursive: true });
  copyFileSync(join(sourceDir, 'package.json'), join(packageDir, 'package.json'));
  const readme = join(sourceDir, 'README.md');
  if (!existsSync(readme)) throw new Error(`Missing required publish file: ${readme}`);
  copyFileSync(readme, join(packageDir, 'README.md'));
  cpSync(join(sourceDir, 'dist'), join(packageDir, 'dist'), { recursive: true });

  console.log(`Staging ${name}`);
  stage(packageDir);
  console.log(`Packing ${name}`);
  const tarball = run(NPM, ['pack', '--silent'], packageDir).trim().split('\n').pop();
  return join(packageDir, tarball);
}

let outcomeError;
try {
  console.log('Building dist/');
  // build:bundles also emits the tsup browser bundles (dist/kortix.esm.min.js,
  // dist/kortix.global.js) that publishConfig.browser/unpkg/jsdelivr point at.
  // stage() below promotes those fields and verifies they exist in dist/, so
  // they must be built before staging; plain build only runs tsc.
  run(PNPM, ['run', 'build:bundles'], PKG_DIR);
  run(PNPM, ['run', 'build'], CATALOG_DIR);
  run(PNPM, ['run', 'build'], CONTRACT_DIR);

  console.log('Staging and packing temporary published manifests');
  const contractTarballPath = packStagedPackage(CONTRACT_DIR, 'intelligence-contracts');
  const catalogTarballPath = packStagedPackage(CATALOG_DIR, 'llm-catalog');
  const tarballPath = packStagedPackage(PKG_DIR, 'sdk');

  console.log(
    `Installing ${contractTarballPath} + ${catalogTarballPath} + ${tarballPath} into ${workdir}`,
  );
  writeFileSync(
    join(workdir, 'package.json'),
    JSON.stringify({ name: 'smoke', private: true, type: 'module' }, null, 2),
  );
  run(
    NPM,
    ['install', '--no-audit', '--no-fund', contractTarballPath, catalogTarballPath, tarballPath],
    workdir,
  );

  console.log('Importing in Node ESM');
  writeFileSync(
    join(workdir, 'smoke.mjs'),
    [
      "import { createKortix, ApiError, classifyTurn } from '@kortix/sdk';",
      "import { createScopedKortix } from '@kortix/sdk/server';",
      "import { INTELLIGENCE_PROTOCOL_VERSION } from '@kortix/intelligence-contracts';",
      "if (typeof createKortix !== 'function') throw new Error('createKortix is not a function');",
      "if (typeof classifyTurn !== 'function') throw new Error('classifyTurn is not a function');",
      "if (typeof createScopedKortix !== 'function') throw new Error('createScopedKortix missing');",
      "if (INTELLIGENCE_PROTOCOL_VERSION !== 'intelligence.v1') throw new Error('intelligence contract missing');",
      "if (!(new ApiError('x') instanceof Error)) throw new Error('ApiError is not an Error');",
      "const k = createKortix({ backendUrl: 'http://smoke.test/v1', getToken: async () => null });",
      "if (typeof k.projects.list !== 'function') throw new Error('facade is not wired');",
      "if (typeof k.project('project-1').intelligence.capabilities.discover !== 'function') throw new Error('intelligence facade is not wired');",
      "console.log('OK: @kortix/sdk imports and constructs from packed tarballs');",
    ].join('\n'),
  );
  process.stdout.write(run('node', ['smoke.mjs'], workdir));

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
