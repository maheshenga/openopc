import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import { generateKeys } from 'paseto-ts/v4';

import {
  createModuleEgressHttpHandler,
  loadModuleEgressProxyConfig,
  readBoundedResponse,
} from './main';

describe('module egress proxy production config', () => {
  test('fails closed when the private service is not explicitly enabled and fully configured', () => {
    expect(() => loadModuleEgressProxyConfig({})).toThrow('MODULE_EGRESS_CONFIG_INVALID');
    expect(() =>
      loadModuleEgressProxyConfig({
        OPENOPC_MODULE_EGRESS_ENABLED: 'true',
        DATABASE_URL: 'postgres://openopc:secret@postgres.internal/openopc',
      }),
    ).toThrow('MODULE_EGRESS_CONFIG_INVALID');
  });

  test('loads only explicit private-service keys, credentials, and trust configuration', () => {
    const keys = generateKeys('public');
    const config = loadModuleEgressProxyConfig({
      OPENOPC_MODULE_EGRESS_ENABLED: 'true',
      OPENOPC_MODULE_EGRESS_PORT: '4013',
      OPENOPC_MODULE_EGRESS_PUBLIC_KEYS_JSON: JSON.stringify({
        'openopc-capability-staging-2026-01': keys.publicKey,
      }),
      OPENOPC_MODULE_EGRESS_CREDENTIALS_JSON: JSON.stringify({
        'https://api.example.com': {
          name: 'authorization',
          value: 'Bearer provider-secret',
        },
      }),
      OPENOPC_MODULE_EGRESS_MTLS_PROXY_SECRET: 'm'.repeat(32),
      DATABASE_URL: 'postgres://openopc:secret@postgres.internal/openopc',
    });

    expect(config).toMatchObject({
      enabled: true,
      port: 4013,
      databaseUrl: 'postgres://openopc:secret@postgres.internal/openopc',
      mtlsProxySecret: 'm'.repeat(32),
    });
    expect([...config.publicKeys]).toEqual([
      ['openopc-capability-staging-2026-01', keys.publicKey],
    ]);
    expect([...config.credentials]).toEqual([
      ['https://api.example.com', { name: 'authorization', value: 'Bearer provider-secret' }],
    ]);
  });

  test('accepts egress only through the trusted mTLS proxy and strips internal headers', async () => {
    const calls: unknown[] = [];
    const handler = createModuleEgressHttpHandler({
      mtlsProxySecret: 'm'.repeat(32),
      proxy: {
        async handle(input) {
          calls.push(structuredClone(input));
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: new TextEncoder().encode('{"ok":true}'),
          };
        },
      },
    });

    expect((await handler(new Request('http://proxy.internal/healthz'))).status).toBe(200);
    const denied = await handler(
      new Request(
        'http://proxy.internal/v1/egress?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fmessages',
        { method: 'POST' },
      ),
    );
    expect(denied.status).toBe(403);

    const response = await handler(
      new Request(
        'http://proxy.internal/v1/egress?url=https%3A%2F%2Fapi.example.com%2Fv1%2Fmessages',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer capability-token',
            'content-type': 'application/json',
            'x-openopc-egress-proxy-secret': 'm'.repeat(32),
            'x-openopc-mtls-verified': 'SUCCESS',
            'x-openopc-client-cert-sha256': 'b'.repeat(64),
          },
          body: '{"hello":"world"}',
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(calls).toEqual([
      {
        authorization: 'Bearer capability-token',
        certificateThumbprint: 'b'.repeat(64),
        url: 'https://api.example.com/v1/messages',
        method: 'POST',
        headers: {
          authorization: 'Bearer capability-token',
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode('{"hello":"world"}'),
      },
    ]);
  });

  test('bounds the provider response while it is streaming', async () => {
    await expect(
      readBoundedResponse(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), 4),
    ).resolves.toEqual(new TextEncoder().encode('abcd'));
    await expect(
      readBoundedResponse(Readable.from([Buffer.from('abc'), Buffer.from('def')]), 5),
    ).rejects.toThrow('MODULE_EGRESS_UPSTREAM_LIMIT');
  });

  test('rejects provider credentials that target transport-owned headers', () => {
    const keys = generateKeys('public');
    expect(() =>
      loadModuleEgressProxyConfig({
        OPENOPC_MODULE_EGRESS_ENABLED: 'true',
        OPENOPC_MODULE_EGRESS_PUBLIC_KEYS_JSON: JSON.stringify({
          'openopc-capability-staging-2026-01': keys.publicKey,
        }),
        OPENOPC_MODULE_EGRESS_CREDENTIALS_JSON: JSON.stringify({
          'https://api.example.com': { name: 'connection', value: 'keep-alive' },
        }),
        OPENOPC_MODULE_EGRESS_MTLS_PROXY_SECRET: 'm'.repeat(32),
        DATABASE_URL: 'postgres://openopc:secret@postgres.internal/openopc',
      }),
    ).toThrow('MODULE_EGRESS_CONFIG_INVALID');
  });

  test('reports not ready when the atomic capability consumer cannot reach PostgreSQL', async () => {
    const handler = createModuleEgressHttpHandler({
      mtlsProxySecret: 'm'.repeat(32),
      isReady: async () => false,
      proxy: {
        async handle() {
          throw new Error('must not handle readiness as egress');
        },
      },
    });

    const response = await handler(new Request('http://proxy.internal/readyz'));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'not_ready' });
  });
});
