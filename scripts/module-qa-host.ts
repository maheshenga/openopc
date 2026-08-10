import { existsSync, readFileSync } from 'node:fs';

const QA_PORT = 443;
const QA_HOST_SUFFIX = '.openopc.test';

export type ModuleQaHostOptions = {
  hostname: string;
  upstream: URL;
  certPath: string;
  keyPath: string;
  listenHost: string;
};

function usage(): string {
  return [
    'Usage: bun scripts/module-qa-host.ts --hostname module.openopc.test --upstream http://127.0.0.1:4173 --cert .local/module-qa-certs/module.openopc.test.pem --key .local/module-qa-certs/module.openopc.test-key.pem',
    '',
    'The public QA origin is always https://<hostname> on port 443.',
  ].join('\n');
}

function argumentMap(args: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument: ${key ?? ''}`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    result.set(key.slice(2), value);
    index += 1;
  }
  return result;
}

export function canonicalModuleQaOrigin(hostname: string): string {
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
      hostname,
    ) ||
    !hostname.endsWith(QA_HOST_SUFFIX) ||
    hostname === QA_HOST_SUFFIX.slice(1) ||
    hostname.includes('localhost') ||
    /^[0-9.]+$/.test(hostname)
  ) {
    throw new Error(`hostname must be a named ${QA_HOST_SUFFIX} host without a port`);
  }
  return `https://${hostname}`;
}

function localUpstream(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('upstream must be an explicit loopback http URL');
  }
  if (
    url.protocol !== 'http:' ||
    !url.port ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('upstream must be an explicit loopback http URL');
  }
  return url;
}

export function parseModuleQaHostOptions(args: readonly string[]): ModuleQaHostOptions {
  const values = argumentMap(args);
  const hostname = values.get('hostname');
  const upstream = values.get('upstream');
  const certPath = values.get('cert');
  const keyPath = values.get('key');
  const listenHost = values.get('listen-host') ?? '0.0.0.0';
  if (!hostname || !upstream || !certPath || !keyPath) throw new Error(usage());
  canonicalModuleQaOrigin(hostname);
  if (listenHost !== '0.0.0.0' && listenHost !== '127.0.0.1') {
    throw new Error('listen-host must be 0.0.0.0 or 127.0.0.1');
  }
  return { hostname, upstream: localUpstream(upstream), certPath, keyPath, listenHost };
}

export function startModuleQaHost(options: ModuleQaHostOptions) {
  const origin = canonicalModuleQaOrigin(options.hostname);
  if (!existsSync(options.certPath) || !existsSync(options.keyPath)) {
    throw new Error(
      'QA certificate and key files must exist; run scripts/module-qa-cert.ps1 first',
    );
  }
  const cert = readFileSync(options.certPath);
  const key = readFileSync(options.keyPath);
  const upstream = options.upstream;
  const server = Bun.serve({
    hostname: options.listenHost,
    port: QA_PORT,
    tls: { cert, key },
    async fetch(request) {
      const incoming = new URL(request.url);
      if (incoming.pathname === '/.well-known/openopc-module-qa') {
        return Response.json({
          origin,
          upstream: `${upstream.protocol}//${upstream.host}`,
          ready: true,
        });
      }
      const target = new URL(incoming.pathname + incoming.search, upstream);
      const headers = new Headers(request.headers);
      headers.set('host', upstream.host);
      try {
        return await fetch(target, {
          method: request.method,
          headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          redirect: 'manual',
        });
      } catch {
        return new Response('QA upstream unavailable', { status: 502 });
      }
    },
  });
  console.log(`OpenOPC module QA host ready: ${origin}`);
  console.log(`Readiness: ${origin}/.well-known/openopc-module-qa`);
  return server;
}

if (import.meta.main) {
  try {
    startModuleQaHost(parseModuleQaHostOptions(Bun.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exitCode = 1;
  }
}
