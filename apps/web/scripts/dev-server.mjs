import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_HTTP_HEADER_SIZE = '--max-http-header-size=32768';

/** Build the Next dev arguments without relying on shell-specific expansion. */
export function buildNextDevArgs(port) {
  const normalizedPort = String(port ?? '').trim() || '3000';
  return ['dev', '--turbopack', '--port', normalizedPort];
}

/** Keep the header-size guard while preserving any caller-provided Node flags. */
export function withMaxHttpHeaderSize(existing) {
  const options = String(existing ?? '').trim();
  if (options.split(/\s+/).includes(MAX_HTTP_HEADER_SIZE)) return options;
  return [options, MAX_HTTP_HEADER_SIZE].filter(Boolean).join(' ');
}

/** Forward termination to Next and release parent listeners when it finishes. */
export function wireChildLifecycle(child, processLike = process, logger = console) {
  let finished = false;

  const cleanup = () => {
    processLike.removeListener('SIGINT', onSigint);
    processLike.removeListener('SIGTERM', onSigterm);
    child.removeListener('error', onError);
    child.removeListener('exit', onExit);
  };
  const finish = (code, error) => {
    if (finished) return;
    finished = true;
    cleanup();
    if (error) logger.error(`[web] failed to launch Next: ${error.message}`);
    processLike.exitCode = code ?? 1;
  };
  const forward = (signal) => {
    if (child.killed) return;
    try {
      child.kill(signal);
    } catch (error) {
      finish(1, error);
    }
  };
  const onSigint = () => forward('SIGINT');
  const onSigterm = () => forward('SIGTERM');
  const onError = (error) => finish(1, error);
  const onExit = (code) => finish(code);

  processLike.once('SIGINT', onSigint);
  processLike.once('SIGTERM', onSigterm);
  child.once('error', onError);
  child.once('exit', onExit);
}

function isMainModule() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(resolve(entry)).href === import.meta.url;
}

function run() {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const nextBin = resolve(webDir, 'node_modules/next/dist/bin/next');
  const child = spawn(process.execPath, [nextBin, ...buildNextDevArgs(process.env.WEB_PORT)], {
    cwd: webDir,
    env: {
      ...process.env,
      NODE_OPTIONS: withMaxHttpHeaderSize(process.env.NODE_OPTIONS),
    },
    stdio: 'inherit',
  });
  wireChildLifecycle(child);
}

if (isMainModule()) run();
