import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import worker from './worker.mjs';

const env = {
  OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN: 'https://module-origin.openopc.example',
  OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX: 'openopc.example',
  INTERNAL_SERVICE_KEY: 'internal-test-key',
};
const BINDING_ID = '60000000-0000-4000-a000-000000000006';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('module custom hostname worker', () => {
  test('resolves an active hostname and forwards only to the fixed module origin', async () => {
    const requests = [];
    globalThis.fetch = async (request) => {
      requests.push(request.clone());
      if (requests.length === 1) {
        return Response.json({
          binding_id: BINDING_ID,
          route_path: `/v1/module-host/releases/${RELEASE_ID}`,
        });
      }
      return new Response('module response', { status: 200 });
    };

    const response = await worker.fetch(
      new Request(
        'https://shop.customer.example/assets/app.js?origin=https://evil.example&upstream=evil',
        {
          headers: {
            Authorization: 'Bearer caller-secret',
            Cookie: 'session=caller-secret',
            Host: 'evil.example',
            'X-Forwarded-Host': 'evil.example',
            'X-Kortix-Internal-Key': 'forged-internal-key',
            'X-OpenOPC-Module-Domain-Binding': 'forged-binding',
          },
        },
      ),
      env,
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'module response');
    assert.equal(requests.length, 2);
    assert.equal(
      requests[0].url,
      'https://module-origin.openopc.example/v1/internal/module-domains/resolve?hostname=shop.customer.example',
    );
    assert.equal(requests[0].headers.get('X-Kortix-Internal-Key'), 'internal-test-key');
    assert.equal(
      requests[1].url,
      `https://module-origin.openopc.example/v1/module-host/releases/${RELEASE_ID}/assets/app.js?origin=https://evil.example&upstream=evil`,
    );
    assert.equal(requests[1].headers.get('X-OpenOPC-Module-Domain-Binding'), BINDING_ID);
    assert.equal(requests[1].headers.get('authorization'), null);
    assert.equal(requests[1].headers.get('cookie'), null);
    assert.equal(requests[1].headers.get('host'), null);
    assert.equal(requests[1].headers.get('x-forwarded-host'), null);
    assert.equal(requests[1].headers.get('x-kortix-internal-key'), 'internal-test-key');
  });

  test('returns the same tenant-free 404 for inactive, unknown, or malformed resolutions', async () => {
    for (const resolverResponse of [
      new Response(null, { status: 404 }),
      Response.json({
        binding_id: BINDING_ID,
        route_path: 'https://evil.example/module',
      }),
      Response.json({
        binding_id: BINDING_ID,
        route_path: `/v1/module-host/releases/${RELEASE_ID}`,
        account_id: 'should-not-be-here',
      }),
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        return resolverResponse;
      };
      const response = await worker.fetch(new Request('https://unknown.customer.example/'), env);
      assert.equal(response.status, 404);
      assert.equal(await response.text(), 'Not Found');
      assert.equal(calls, 1);
    }
  });

  test('preserves a POST body while still fixing the upstream origin and binding identity', async () => {
    let upstreamBody = '';
    globalThis.fetch = async (request) => {
      if (request.url.includes('/resolve?')) {
        return Response.json({
          binding_id: BINDING_ID,
          route_path: `/v1/module-host/releases/${RELEASE_ID}`,
        });
      }
      upstreamBody = await request.text();
      assert.equal(
        request.url,
        `https://module-origin.openopc.example/v1/module-host/releases/${RELEASE_ID}/submit`,
      );
      assert.equal(request.headers.get('X-OpenOPC-Module-Domain-Binding'), BINDING_ID);
      return new Response('posted', { status: 200 });
    };

    const response = await worker.fetch(
      new Request('https://shop.customer.example/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"answer":42}',
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(upstreamBody, '{"answer":42}');
  });

  test('fails closed when its fixed origin or internal key is missing or unsafe', async () => {
    for (const invalidEnv of [
      { ...env, INTERNAL_SERVICE_KEY: '' },
      { ...env, OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN: 'http://module-origin.openopc.example' },
      { ...env, OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN: 'https://user:pass@openopc.example' },
      {
        ...env,
        OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN: 'https://module-origin.attacker.example',
      },
    ]) {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return new Response('unexpected');
      };
      const response = await worker.fetch(
        new Request('https://shop.customer.example/'),
        invalidEnv,
      );
      assert.equal(response.status, 500);
      assert.equal(fetched, false);
    }
  });
});
