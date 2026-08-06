import { expect, test } from 'bun:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { parseModuleAppHostConfiguration } from '../module-domains/platform-host-config';
import { createModuleServiceBrowserCors } from './browser-cors';

function createCorsHarness(includeReleaseInGlobal = false) {
  const RELEASE_ORIGIN = 'https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example';
  const configuration = parseModuleAppHostConfiguration('modules.openopc.example');
  const app = new Hono();
  app.use('*', async (context, next) => {
    context.header('Vary', 'Accept-Encoding');
    await next();
  });
  const moduleCors = createModuleServiceBrowserCors(configuration);
  app.use('/v1/module-services', moduleCors);
  app.use('/v1/module-services/*', moduleCors);
  app.use(
    '*',
    cors({
      origin: (origin) =>
        origin === 'https://app.openopc.example' ||
        (includeReleaseInGlobal && origin === RELEASE_ORIGIN)
          ? origin
          : null,
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Authorization', 'Content-Type'],
      credentials: true,
    }),
  );
  app.get('/v1/module-services/ai/models', (context) => context.json({ data: [] }));
  app.get('/v1/accounts', (context) => context.json({ accounts: [] }));
  return { app, RELEASE_ORIGIN };
}

test('allows only a canonical release origin on module-service routes', async () => {
  const { app, RELEASE_ORIGIN } = createCorsHarness();
  const response = await app.request('/v1/module-services/ai/models', {
    method: 'OPTIONS',
    headers: {
      Origin: RELEASE_ORIGIN,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe(RELEASE_ORIGIN);
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
  expect(response.headers.get('access-control-allow-headers')).toBe(
    'Authorization, Content-Type, Idempotency-Key',
  );
  expect(response.headers.get('access-control-max-age')).toBe('600');
  expect(response.headers.get('vary')).toBe('Accept-Encoding, Origin');
});

test('adds noncredentialed CORS to an actual module-service response', async () => {
  const { app, RELEASE_ORIGIN } = createCorsHarness();
  const response = await app.request('/v1/module-services/ai/models', {
    headers: { Origin: RELEASE_ORIGIN, Authorization: 'Bearer scoped' },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe(RELEASE_ORIGIN);
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  expect(response.headers.get('vary')?.split(/,\s*/)).toEqual(['Accept-Encoding', 'Origin']);
});

test('removes global credential CORS when an operator also listed the release origin', async () => {
  const { app, RELEASE_ORIGIN } = createCorsHarness(true);
  const response = await app.request('/v1/module-services/ai/models', {
    headers: { Origin: RELEASE_ORIGIN },
  });
  expect(response.headers.get('access-control-allow-origin')).toBe(RELEASE_ORIGIN);
  expect(response.headers.get('access-control-allow-credentials')).toBeNull();
});

test('does not grant module CORS on unrelated API routes', async () => {
  const { app, RELEASE_ORIGIN } = createCorsHarness();
  const response = await app.request('/v1/accounts', {
    headers: { Origin: RELEASE_ORIGIN },
  });
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
});

test('rejects noncanonical and custom origins', async () => {
  const { app } = createCorsHarness();
  for (const origin of [
    'http://r-40000000-0000-4000-a000-000000000004.modules.openopc.example',
    'https://modules.openopc.example',
    'https://r-40000000-0000-4000-A000-000000000004.modules.openopc.example',
    'https://extra.r-40000000-0000-4000-a000-000000000004.modules.openopc.example',
    'https://r-40000000-0000-4000-a000-000000000004.modules.openopc.example:8443',
    'https://user:pass@r-40000000-0000-4000-a000-000000000004.modules.openopc.example',
    'https://shop.customer.example',
    'https://r-40000000-0000-4000-a000-000000000004.modules.attacker.example',
  ]) {
    const response = await app.request('/v1/module-services/ai/models', {
      headers: { Origin: origin },
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  }
});

test('preserves ordinary Web CORS behavior', async () => {
  const { app } = createCorsHarness();
  const response = await app.request('/v1/accounts', {
    headers: { Origin: 'https://app.openopc.example' },
  });
  expect(response.headers.get('access-control-allow-origin')).toBe('https://app.openopc.example');
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
});
