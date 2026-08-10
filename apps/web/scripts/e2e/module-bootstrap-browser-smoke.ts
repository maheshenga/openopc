import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type Server as HttpsServer, createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error node-forge does not publish TypeScript declarations.
import forge from 'node-forge';
import { type Browser, type BrowserContext, type Page, type Route, chromium } from 'playwright';

const PLATFORM_ORIGIN = 'https://app.openopc.localhost';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const MODULE_ORIGIN = `https://r-${RELEASE_ID}.modules.openopc.test`;
const ATTACKER_ORIGIN = 'https://attacker.openopc.test';
const CUSTOM_ORIGIN = 'https://module.customer.example';
const SERVICE_PATH = '/v1/module-services/ai/models';
const STREAM_PATH = '/v1/module-services/ai/chat/completions';
const PREFLIGHT_PROBE_PATH = '/v1/module-services/preflight-probe';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const DRIVER_FLAG = '--node-driver';
const scriptPath = fileURLToPath(import.meta.url);
const driverMode = process.argv[2] === DRIVER_FLAG;

if (!driverMode) {
  const fixturePath = fileURLToPath(
    new URL('./fixtures/module-bootstrap-browser-fixture.ts', import.meta.url),
  );
  const build = await Bun.build({
    entrypoints: [fixturePath],
    target: 'browser',
    format: 'esm',
    minify: false,
  });
  if (!build.success || build.outputs.length !== 1) {
    throw new Error(build.logs.map(String).join('\n') || 'fixture build failed');
  }

  const workdir = mkdtempSync(join(tmpdir(), 'openopc-module-bootstrap-browser-'));
  try {
    const bundlePath = join(workdir, 'fixture.js');
    writeFileSync(bundlePath, await build.outputs[0].text());
    const result = spawnSync(
      'node',
      ['--experimental-strip-types', scriptPath, DRIVER_FLAG, bundlePath],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
        stdio: 'inherit',
        windowsHide: true,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`browser driver exited with status ${result.status ?? 'unknown'}`);
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  process.exit(0);
}

const bundlePath = process.argv[3];
assert(bundlePath, 'browser fixture bundle path missing');
const bundle = readFileSync(bundlePath, 'utf8');

const counts = {
  preflight: 0,
  optionsProbes: 0,
  models: 0,
  streams: 0,
  modelCookies: [] as string[],
  probeCookies: [] as string[],
  unexpected: [] as string[],
};
const corsHeaders = {
  'access-control-allow-origin': MODULE_ORIGIN,
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, Idempotency-Key',
  vary: 'Origin',
};

function createTestCertificate(): { key: string; cert: string; spki: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 60 * 60 * 1000);
  const identity = [{ name: 'commonName', value: 'app.openopc.localhost' }];
  certificate.setSubject(identity);
  certificate.setIssuer(identity);
  certificate.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [{ type: 2, value: 'app.openopc.localhost' }],
    },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate);
  const spki = createHash('sha256')
    .update(createPublicKey(cert).export({ format: 'der', type: 'spki' }))
    .digest('base64');
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert, spki };
}

function createServiceServer(certificate: {
  key: string;
  cert: string;
  spki: string;
}): HttpsServer {
  const server = createServer(certificate, (request, response) => {
    const url = new URL(request.url ?? '/', PLATFORM_ORIGIN);
    if (
      ![SERVICE_PATH, STREAM_PATH, PREFLIGHT_PROBE_PATH].includes(url.pathname) ||
      request.headers.origin !== MODULE_ORIGIN
    ) {
      counts.unexpected.push(`${request.method ?? 'UNKNOWN'} ${url.href}`);
      response.writeHead(404).end('Not Found');
      return;
    }

    if (request.method === 'OPTIONS') {
      if (url.pathname === SERVICE_PATH || url.pathname === STREAM_PATH) {
        counts.preflight += 1;
        const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '')
          .toLowerCase()
          .split(/,\s*/);
        if (
          request.headers['access-control-request-method'] !==
            (url.pathname === SERVICE_PATH ? 'GET' : 'POST') ||
          !requestedHeaders.includes('authorization')
        ) {
          counts.unexpected.push('invalid automatic module-service preflight');
          response.writeHead(400).end('Bad Request');
          return;
        }
      } else {
        counts.optionsProbes += 1;
        counts.probeCookies.push(request.headers.cookie ?? '');
        if (
          request.headers.authorization !== 'Bearer v4.public.browser-smoke' ||
          request.headers['idempotency-key'] !== 'browser-preflight-probe'
        ) {
          counts.unexpected.push('invalid browser OPTIONS probe');
          response.writeHead(400).end('Bad Request');
          return;
        }
      }
      response.writeHead(204, corsHeaders).end();
      return;
    }

    if (request.method === 'GET' && url.pathname === SERVICE_PATH) {
      counts.models += 1;
      counts.modelCookies.push(request.headers.cookie ?? '');
      if (request.headers.authorization !== 'Bearer v4.public.browser-smoke') {
        counts.unexpected.push('invalid scoped authorization');
        response.writeHead(401).end('Unauthorized');
        return;
      }
      response.writeHead(200, { ...corsHeaders, 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [{ id: 'approved-model', object: 'model', owned_by: 'openopc' }],
        }),
      );
      return;
    }

    if (request.method === 'POST' && url.pathname === STREAM_PATH) {
      counts.streams += 1;
      if (request.headers.authorization !== 'Bearer v4.public.browser-smoke') {
        counts.unexpected.push('invalid stream authorization');
        response.writeHead(401).end('Unauthorized');
        return;
      }
      response.writeHead(200, { ...corsHeaders, 'content-type': 'text/event-stream' });
      response.write('data: {"id":"browser-stream-1","choices":[{"delta":{"content":"ok"}}]}\n\n');
      const timer = setTimeout(() => {
        response.write('data: [DONE]\n\n');
        response.end();
      }, 5_000);
      request.on('aborted', () => clearTimeout(timer));
      response.on('close', () => clearTimeout(timer));
      return;
    }

    counts.unexpected.push(`${request.method ?? 'UNKNOWN'} ${url.href}`);
    response.writeHead(405).end('Method Not Allowed');
  });
  server.on('tlsClientError', (error) => {
    counts.unexpected.push(`tlsClientError: ${error.message}`);
  });
  server.on('clientError', (error) => {
    counts.unexpected.push(`clientError: ${error.message}`);
  });
  return server;
}

function listen(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(443, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function installRoute(route: Route) {
  const request = route.request();
  const url = new URL(request.url());
  const isFixtureOrigin = [PLATFORM_ORIGIN, MODULE_ORIGIN, ATTACKER_ORIGIN, CUSTOM_ORIGIN].includes(
    url.origin,
  );
  if (url.pathname === '/favicon.ico' && isFixtureOrigin) {
    await route.fulfill({ status: 204, body: '' });
    return;
  }
  if (url.pathname === '/fixture.js' && isFixtureOrigin) {
    await route.fulfill({ status: 200, contentType: 'text/javascript', body: bundle });
    return;
  }
  if (url.pathname === '/fixture.html' && isFixtureOrigin) {
    const role = url.searchParams.get('role');
    const headers: Record<string, string> = {};
    if (url.origin === MODULE_ORIGIN) {
      headers['content-security-policy'] = [
        "default-src 'self'",
        "base-uri 'none'",
        "object-src 'none'",
        "script-src 'self'",
        `connect-src 'self' ${PLATFORM_ORIGIN}`,
        `frame-ancestors ${PLATFORM_ORIGIN}`,
      ].join('; ');
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers,
      body: `<body><script type="module" src="/fixture.js?role=${role}"></script></body>`,
    });
    return;
  }
  counts.unexpected.push(`${request.method()} ${request.url()}`);
  await route.fulfill({ status: 404, body: 'Not Found' });
}

const certificate = createTestCertificate();
const serviceServer = createServiceServer(certificate);
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const pages: Page[] = [];
const browserMessages: string[] = [];
let outcomeError: unknown;
try {
  await listen(serviceServer);
  browser = await chromium.launch({
    args: [
      '--no-proxy-server',
      `--ignore-certificate-errors-spki-list=${certificate.spki}`,
      '--disable-features=LocalNetworkAccessChecks',
    ],
  });
  context = await browser.newContext({
    serviceWorkers: 'block',
  });
  await context.grantPermissions(['local-network-access'], { origin: PLATFORM_ORIGIN });
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.pathname !== '/fixture.html' &&
      url.pathname !== '/fixture.js' &&
      url.pathname !== '/favicon.ico' &&
      !(
        url.origin === PLATFORM_ORIGIN &&
        [SERVICE_PATH, STREAM_PATH, PREFLIGHT_PROBE_PATH].includes(url.pathname)
      )
    ) {
      counts.unexpected.push(`${request.method()} ${request.url()}`);
    }
  });
  await context.route('**/fixture.html*', installRoute);
  await context.route('**/fixture.js*', installRoute);
  await context.route('**/favicon.ico', installRoute);
  await context.addCookies([{ name: 'openopc_session', value: 'fixture', url: PLATFORM_ORIGIN }]);

  const page = await context.newPage();
  pages.push(page);
  page.on('console', (message) => browserMessages.push(`console: ${message.text()}`));
  page.on('pageerror', (error) => browserMessages.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) =>
    browserMessages.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
    ),
  );
  await page.goto(`${PLATFORM_ORIGIN}/fixture.html?role=host`, {
    waitUntil: 'domcontentloaded',
  });
  const moduleFrame = page.frameLocator(`iframe[src="${MODULE_ORIGIN}/fixture.html?role=module"]`);
  await moduleFrame.locator('body[data-result="ok"]').waitFor({ timeout: 10_000 });
  const bootstrapRequests = await page.evaluate(() =>
    (
      window as unknown as {
        __openOpcFixtureBootstrapRequests: () => number;
      }
    ).__openOpcFixtureBootstrapRequests(),
  );
  const tokenRequests = await page.evaluate(() =>
    (
      window as unknown as {
        __openOpcFixtureTokenRequests: () => number;
      }
    ).__openOpcFixtureTokenRequests(),
  );
  assert(bootstrapRequests === 1, `expected one bootstrap request, got ${bootstrapRequests}`);
  assert(tokenRequests === 2, `expected two token requests, got ${tokenRequests}`);
  assert(counts.preflight === 0, `unexpected automatic preflight count ${counts.preflight}`);
  assert(counts.models === 1, `expected one model request, got ${counts.models}`);
  assert(counts.streams === 1, `expected one stream request, got ${counts.streams}`);
  assert(counts.modelCookies[0] === '', 'module-service request sent a cookie');
  assert(counts.optionsProbes === 1, `expected one OPTIONS probe, got ${counts.optionsProbes}`);
  assert(counts.probeCookies[0] === '', 'OPTIONS probe sent a cookie');
  await page.evaluate(() =>
    (
      window as unknown as {
        __openOpcFixtureCleanup: () => void;
      }
    ).__openOpcFixtureCleanup(),
  );
  await page.locator('body[data-cleanup="ok"]').waitFor();
  console.log(
    'allowed flow: bootstrap=1 token=2 models=1 streams=1 OPTIONS=1 cookies=0 abort=ok cleanup=ok',
  );

  const beforeDenied = {
    preflight: counts.preflight,
    optionsProbes: counts.optionsProbes,
    models: counts.models,
  };
  const attackerPage = await context.newPage();
  pages.push(attackerPage);
  const cspMessages: string[] = [];
  attackerPage.on('console', (message) => cspMessages.push(message.text()));
  await attackerPage.goto(`${ATTACKER_ORIGIN}/fixture.html?role=host`, {
    waitUntil: 'domcontentloaded',
  });
  await attackerPage.locator('body[data-frame-settled="yes"]').waitFor({ timeout: 10_000 });
  const attackerBridgeCounts = await attackerPage.evaluate(() => ({
    bootstrap: (
      window as unknown as {
        __openOpcFixtureBootstrapRequests: () => number;
      }
    ).__openOpcFixtureBootstrapRequests(),
    token: (
      window as unknown as {
        __openOpcFixtureTokenRequests: () => number;
      }
    ).__openOpcFixtureTokenRequests(),
  }));
  assert(attackerBridgeCounts.bootstrap === 0, 'attacker received bootstrap traffic');
  assert(attackerBridgeCounts.token === 0, 'attacker parent obtained a token');
  assert(counts.preflight === beforeDenied.preflight, 'attacker sent a preflight');
  assert(counts.optionsProbes === beforeDenied.optionsProbes, 'attacker sent an OPTIONS probe');
  assert(counts.models === beforeDenied.models, 'attacker sent a model request');
  assert(
    cspMessages.some((message) => /frame-ancestors/i.test(message)),
    'attacker frame was not rejected by CSP',
  );
  await attackerPage.evaluate(() =>
    (
      window as unknown as {
        __openOpcFixtureCleanup: () => void;
      }
    ).__openOpcFixtureCleanup(),
  );
  await attackerPage.locator('body[data-cleanup="ok"]').waitFor();
  console.log('attacker parent: bootstrap=0 token=0 network=0 CSP=blocked cleanup=ok');

  const directPage = await context.newPage();
  pages.push(directPage);
  await directPage.goto(`${CUSTOM_ORIGIN}/fixture.html?role=direct`, {
    waitUntil: 'domcontentloaded',
  });
  await directPage.locator('body[data-result="bootstrap-rejected"]').waitFor({ timeout: 10_000 });
  assert(counts.preflight === beforeDenied.preflight, 'direct page sent a preflight');
  assert(counts.optionsProbes === beforeDenied.optionsProbes, 'direct page sent an OPTIONS probe');
  assert(counts.models === beforeDenied.models, 'direct page sent a model request');
  assert(counts.unexpected.length === 0, counts.unexpected.join('\n'));
  console.log('direct custom domain: bootstrap rejected, network=0');
} catch (error) {
  outcomeError = error;
  const states = await Promise.all(
    pages.map(async (page) => ({
      url: page.url(),
      body: await page
        .evaluate(() => ({ ...document.body.dataset }))
        .catch((stateError) => ({ evaluationError: String(stateError) })),
      frames: await Promise.all(
        page.frames().map(async (frame) => ({
          url: frame.url(),
          body: await frame
            .evaluate(() => ({ ...document.body.dataset }))
            .catch((stateError) => ({ evaluationError: String(stateError) })),
        })),
      ),
    })),
  );
  console.error(JSON.stringify({ counts, states, browserMessages }, null, 2));
} finally {
  const pageResults = await Promise.allSettled(pages.map((page) => page.close()));
  const pageError = pageResults.find((result) => result.status === 'rejected');
  if (!outcomeError && pageError?.status === 'rejected') outcomeError = pageError.reason;
  if (context) {
    try {
      await context.close();
    } catch (error) {
      outcomeError ??= error;
    }
  }
  try {
    await browser?.close();
  } catch (error) {
    outcomeError ??= error;
  }
  try {
    await close(serviceServer);
  } catch (error) {
    outcomeError ??= error;
  }
}

if (outcomeError) throw outcomeError;
console.log('OpenOPC module bootstrap browser smoke passed');
