import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dir, '..');
const output = resolve(root, 'dist');
const bundledDirector = resolve(root, 'vendor', 'director');
const staging = await mkdtemp(join(tmpdir(), 'openopc-infinite-canvas-build-'));

async function clearDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    await rm(resolve(directory, entry.name), { recursive: true, force: true });
  }
}

async function copyDirectoryContents(source: string, destination: string): Promise<void> {
  await clearDirectory(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    await cp(resolve(source, entry.name), resolve(destination, entry.name), { recursive: true });
  }
}

try {
  const build = await Bun.build({
    entrypoints: [resolve(root, 'src/main.tsx')],
    outdir: staging,
    target: 'browser',
    format: 'esm',
    minify: true,
    sourcemap: 'none',
    naming: 'main.[ext]',
  });

  if (!build.success) {
    for (const log of build.logs) console.error(log);
    process.exitCode = 1;
  } else {
    await Promise.all([
      cp(resolve(root, 'index.html'), resolve(staging, 'index.html')),
      cp(resolve(root, 'LICENSE'), resolve(staging, 'LICENSE')),
      cp(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(staging, 'THIRD_PARTY_NOTICES.md')),
      cp(resolve(root, 'UPSTREAM.md'), resolve(staging, 'UPSTREAM.md')),
      cp(bundledDirector, resolve(staging, 'director'), { recursive: true }),
    ]);
    // Build in a disposable directory first, then replace only its contents.
    // This keeps a host/browser that still has the dist directory open from
    // making the whole build fail with Windows EBUSY directory locking.
    await copyDirectoryContents(staging, output);
    console.log(`Built Infinite Canvas module at ${output}`);
  }
} finally {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
}
