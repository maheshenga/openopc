import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import * as workerModule from './worker.mjs';

const worker = workerModule.default;

const env = {
  OPENOPC_MODULE_CUSTOM_HOSTNAME_ORIGIN: 'https://module-origin.openopc.example',
  OPENOPC_MODULE_CUSTOM_HOSTNAME_SUFFIX: 'openopc.example',
  INTERNAL_SERVICE_KEY: 'internal-test-key',
};
const BINDING_ID = '60000000-0000-4000-a000-000000000006';
const RELEASE_ID = '40000000-0000-4000-a000-000000000004';
const OTHER_RELEASE_ID = '50000000-0000-4000-a000-000000000005';
const platformEnv = {
  OPENOPC_MODULE_APP_BASE_DOMAIN: 'modules.openopc.example',
  OPENOPC_MODULE_HOST_ORIGIN: 'https://module-origin.openopc.example',
  INTERNAL_SERVICE_KEY: 'internal-test-key',
};
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('module custom hostname worker', () => {
  test('routes a canonical platform release hostname directly to its immutable release', async () => {
    const requests = [];
    globalThis.fetch = async (request) => {
      requests.push(request.clone());
      return new Response('module response', { status: 200 });
    };

    const response = await worker.fetch(
      new Request(
        `https://r-${RELEASE_ID}.modules.openopc.example/assets/app.js`,
        {
          headers: {
            Authorization: 'Bearer forged',
            'X-OpenOPC-Module-Release': OTHER_RELEASE_ID,
            'X-OpenOPC-Module-Domain-Binding': BINDING_ID,
            'X-Kortix-Internal-Key': 'forged',
          },
        },
      ),
      platformEnv,
    );

    assert.equal(response.status, 200);
    assert.equal(requests.length, 1);
    assert.equal(
      requests[0].url,
      `https://module-origin.openopc.example/v1/module-host/platform/releases/${RELEASE_ID}/assets/app.js`,
    );
    assert.equal(requests[0].headers.get('X-OpenOPC-Module-Release'), RELEASE_ID);
    assert.equal(requests[0].headers.get('X-OpenOPC-Module-Domain-Binding'), null);
    assert.equal(requests[0].headers.get('authorization'), null);
  });

  test('accepts only a lower-case canonical release UUID in the exact platform label', () => {
    assert.equal(typeof workerModule.platformReleaseId, 'function');
    const { platformReleaseId } = workerModule;
    assert.equal(
      platformReleaseId(
        `r-${RELEASE_ID}.modules.openopc.example`,
        'modules.openopc.example',
      ),
      RELEASE_ID,
    );
    for (const hostname of [
      `r-${RELEASE_ID.toUpperCase()}.modules.openopc.example`,
      'r-40000000-0000-6000-a000-000000000004.modules.openopc.example',
      'r-40000000-0000-4000-7000-000000000004.modules.openopc.example',
      `r-${RELEASE_ID}.extra.modules.openopc.example`,
      `r-${RELEASE_ID}.modules.openopc.example.attacker.example`,
      'modules.openopc.example',
    ]) {
      assert.equal(platformReleaseId(hostname, 'modules.openopc.example'), null);
    }
  });

  test('rejects base domains outside the API canonical hostname contract', () => {
    const overlongBaseDomain = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(23)}`;
    for (const baseDomain of ['127.0.0.1', overlongBaseDomain]) {
      assert.equal(
        workerModule.platformReleaseId(`r-${RELEASE_ID}.${baseDomain}`, baseDomain),
        null,
      );
    }
  });

  test('fails closed for platform-looking hosts that are not exact canonical release hosts', async () => {
    for (const url of [
      'https://r-40000000-0000-6000-a000-000000000004.modules.openopc.example/',
      `https://r-${RELEASE_ID}.extra.modules.openopc.example/`,
      `https://r-${RELEASE_ID}.modules.openopc.example.attacker.example/`,
      'https://modules.openopc.example/',
    ]) {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return new Response('unexpected');
      };
      const response = await worker.fetch(new Request(url), platformEnv);
      assert.equal(response.status, 500);
      assert.equal(fetched, false);
    }
  });

  test('fails closed when platform origin, base-domain, or internal-key configuration is unsafe', async () => {
    for (const invalidEnv of [
      { ...platformEnv, INTERNAL_SERVICE_KEY: '' },
      { ...platformEnv, OPENOPC_MODULE_HOST_ORIGIN: 'http://module-origin.openopc.example' },
      { ...platformEnv, OPENOPC_MODULE_HOST_ORIGIN: 'https://module-origin.openopc.example/path' },
      { ...platformEnv, OPENOPC_MODULE_APP_BASE_DOMAIN: 'https://modules.openopc.example' },
      { ...platformEnv, OPENOPC_MODULE_APP_BASE_DOMAIN: 'modules.openopc.example:443' },
      { ...platformEnv, OPENOPC_MODULE_APP_BASE_DOMAIN: '*.modules.openopc.example' },
      { ...platformEnv, OPENOPC_MODULE_APP_BASE_DOMAIN: 'Modules.openopc.example' },
    ]) {
      let fetched = false;
      globalThis.fetch = async () => {
        fetched = true;
        return new Response('unexpected');
      };
      const response = await worker.fetch(
        new Request(`https://r-${RELEASE_ID}.modules.openopc.example/`),
        invalidEnv,
      );
      assert.equal(response.status, 500);
      assert.equal(fetched, false);
    }
  });

  test('does not fall through to the custom resolver when platform configuration is present but invalid', async () => {
    const requests = [];
    globalThis.fetch = async (request) => {
      requests.push(request.clone());
      return Response.json({
        binding_id: BINDING_ID,
        route_path: `/v1/module-host/releases/${RELEASE_ID}`,
      });
    };

    const response = await worker.fetch(
      new Request(`https://r-${RELEASE_ID}.modules.openopc.example/`),
      {
        ...env,
        OPENOPC_MODULE_APP_BASE_DOMAIN: 'Modules.openopc.example',
        OPENOPC_MODULE_HOST_ORIGIN: 'https://module-origin.openopc.example',
      },
    );

    assert.equal(response.status, 500);
    assert.equal(requests.length, 0);
  });

  test('preserves a platform POST body and query while replacing forged identities', async () => {
    let upstreamBody = '';
    globalThis.fetch = async (request) => {
      upstreamBody = await request.text();
      assert.equal(
        request.url,
        `https://module-origin.openopc.example/v1/module-host/platform/releases/${RELEASE_ID}/submit?mode=full`,
      );
      assert.equal(request.headers.get('X-OpenOPC-Module-Release'), RELEASE_ID);
      assert.equal(request.headers.get('X-OpenOPC-Module-Domain-Binding'), null);
      assert.equal(request.headers.get('X-Kortix-Internal-Key'), 'internal-test-key');
      return new Response('posted', { status: 200 });
    };

    const response = await worker.fetch(
      new Request(`https://r-${RELEASE_ID}.modules.openopc.example/submit?mode=full`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-OpenOPC-Module-Release': OTHER_RELEASE_ID,
          'X-OpenOPC-Module-Domain-Binding': BINDING_ID,
        },
        body: '{"answer":42}',
      }),
      platformEnv,
    );

    assert.equal(response.status, 200);
    assert.equal(upstreamBody, '{"answer":42}');
  });

  test('returns a generic 502 when the platform release upstream is unavailable', async () => {
    globalThis.fetch = async () => {
      throw new Error('origin unavailable');
    };

    const response = await worker.fetch(
      new Request(`https://r-${RELEASE_ID}.modules.openopc.example/`),
      platformEnv,
    );

    assert.equal(response.status, 502);
    assert.equal(await response.text(), 'Module upstream unavailable');
  });

  test('redirects a platform release request to HTTPS without contacting an upstream', async () => {
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response('unexpected');
    };

    const response = await worker.fetch(
      new Request(`http://r-${RELEASE_ID}.modules.openopc.example/assets/app.js?mode=full`),
      platformEnv,
    );

    assert.equal(response.status, 308);
    assert.equal(
      response.headers.get('location'),
      `https://r-${RELEASE_ID}.modules.openopc.example/assets/app.js?mode=full`,
    );
    assert.equal(fetched, false);
  });

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
            'X-OpenOPC-Module-Release': OTHER_RELEASE_ID,
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
    assert.equal(requests[1].headers.get('X-OpenOPC-Module-Release'), null);
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
