import { describe, expect, test } from 'bun:test';
import { generateKeys } from 'paseto-ts/v4';

import { ModuleCapabilityBroker } from '../../api/src/module-runtime/capabilities';
import type { ModuleCapabilityGrant } from '../../api/src/module-runtime/executions';
import { createEgressPolicy } from './policy';
import {
  type ModuleEgressTransportRequest,
  type ModuleEgressTransportResponse,
  createModuleEgressProxy,
  createPasetoCapabilityVerifier,
} from './proxy';

const NOW = '2099-07-27T08:00:00.000Z';
const KEY_ID = 'openopc-capability-staging-2026-01';
const CERTIFICATE = 'b'.repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function issueInput(overrides: Record<string, unknown> = {}) {
  return {
    accountId: '10000000-0000-4000-a000-000000000001',
    projectId: '20000000-0000-4000-a000-000000000001',
    installationId: '30000000-0000-4000-a000-000000000001',
    executionId: '80000000-0000-4000-a000-000000000001',
    releaseDigest: `sha256:${'a'.repeat(64)}` as const,
    actor: {
      type: 'runner' as const,
      id: '70000000-0000-4000-a000-000000000001',
    },
    action: 'http.request',
    audience: 'egress' as const,
    runtimeKind: 'wasi-component' as const,
    lease: {
      id: '90000000-0000-4000-a000-000000000001',
      generation: 3,
      deadline: '2099-07-27T08:00:30.000Z',
    },
    killSwitchGeneration: 4,
    certificateThumbprint: CERTIFICATE,
    expiresAt: '2099-07-27T08:00:20.000Z',
    ceilings: {
      maxCalls: 1,
      maxRequestBytes: 16,
      maxResponseBytes: 32,
      cpuMillis: 2_000,
      wallTimeMs: 5_000,
      costMicro: 50_000,
    },
    egress: { origins: ['https://api.example.com'], methods: ['POST'] },
    ...overrides,
  };
}

async function capability() {
  const keys = generateKeys('public');
  const broker = new ModuleCapabilityBroker({
    persistence: {
      async store(input): Promise<ModuleCapabilityGrant> {
        return {
          ...input,
          revokedAt: null,
          createdAt: NOW,
        };
      },
      async revokeByExecution() {
        return 0;
      },
    },
    secretKey: keys.secretKey,
    keyId: KEY_ID,
    now: () => new Date(NOW),
    createGrantId: () => crypto.randomUUID(),
    createNonce: () => crypto.randomUUID(),
  });
  return { keys, issued: await broker.issue(issueInput()) };
}

function request(token: string, overrides: Record<string, unknown> = {}) {
  return {
    authorization: `Bearer ${token}`,
    certificateThumbprint: CERTIFICATE,
    url: 'https://api.example.com/v1/messages',
    method: 'POST',
    headers: {
      authorization: 'Bearer runner-must-not-forward',
      cookie: 'session=must-not-forward',
      'content-type': 'application/json',
    },
    body: encoder.encode('{"ok":true}'),
    ...overrides,
  };
}

async function proxyFixture(input: {
  publicKey: string;
  resolve?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  transport?: (request: ModuleEgressTransportRequest) => Promise<ModuleEgressTransportResponse>;
  monotonicNow?: () => number;
}) {
  const operations: string[] = [];
  const transported: ModuleEgressTransportRequest[] = [];
  const calls = new Map<string, number>();
  const proxy = createModuleEgressProxy({
    verifier: createPasetoCapabilityVerifier({
      keys: new Map([[KEY_ID, input.publicKey]]),
      now: () => new Date(NOW),
    }),
    policy: createEgressPolicy({
      resolve: input.resolve ?? (async () => [{ address: '93.184.216.34', family: 4 as const }]),
    }),
    async consume(use) {
      operations.push('consume');
      const count = calls.get(use.tokenHash) ?? 0;
      if (count >= use.claims.ceilings.maxCalls) return false;
      calls.set(use.tokenHash, count + 1);
      return true;
    },
    async credentialFor() {
      return { name: 'authorization', value: 'Bearer provider-secret' };
    },
    async transport(transportRequest) {
      operations.push('transport');
      transported.push(structuredClone(transportRequest));
      return input.transport
        ? input.transport(transportRequest)
        : {
            status: 200,
            headers: { 'content-type': 'application/json', 'set-cookie': 'upstream=secret' },
            body: encoder.encode('{"result":"ok"}'),
          };
    },
    now: () => new Date(NOW),
    monotonicNow: input.monotonicNow ?? (() => 0),
  });
  return { proxy, operations, transported };
}

describe('module egress proxy', () => {
  test('pins public DNS, consumes before transport, and never forwards caller credentials', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({ publicKey: keys.publicKey });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(200);
    expect(decoder.decode(response.body)).toBe('{"result":"ok"}');
    expect(response.headers).toEqual({ 'content-type': 'application/json' });
    expect(fixture.operations).toEqual(['consume', 'transport']);
    expect(fixture.transported).toHaveLength(1);
    expect(fixture.transported[0]).toMatchObject({
      address: '93.184.216.34',
      family: 4,
      tlsServername: 'api.example.com',
      rejectUnauthorized: true,
      maxResponseBytes: 32,
      timeoutMs: 5_000,
      headers: {
        authorization: 'Bearer provider-secret',
        'content-type': 'application/json',
      },
    });
    expect(JSON.stringify(fixture.transported[0])).not.toContain('runner-must-not-forward');
    expect(JSON.stringify(fixture.transported[0])).not.toContain('session=must-not-forward');
  });

  test('rejects a private DNS answer before transport', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      resolve: async () => [{ address: '10.0.0.7', family: 4 }],
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(403);
    expect(fixture.operations).toEqual([]);
  });

  test('rejects an IPv6 address outside the allocated global-unicast range', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      resolve: async () => [{ address: '4000::1', family: 6 }],
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(403);
    expect(fixture.operations).toEqual([]);
  });

  test('revalidates redirects and denies an undeclared origin without leaking its body', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      transport: async () => ({
        status: 302,
        headers: { location: 'https://metadata.example/latest' },
        body: encoder.encode('provider-secret-body'),
      }),
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(403);
    expect(decoder.decode(response.body)).toBe('{"error":"MODULE_EGRESS_DENIED"}');
    expect(decoder.decode(response.body)).not.toContain('provider-secret-body');
    expect(fixture.operations).toEqual(['consume', 'transport']);
  });

  test('rejects replay, wrong certificate proof, and oversized request bodies', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({ publicKey: keys.publicKey });

    expect((await fixture.proxy.handle(request(issued.token))).status).toBe(200);
    expect((await fixture.proxy.handle(request(issued.token))).status).toBe(403);

    const wrongProof = await capability();
    expect(
      (
        await fixture.proxy.handle(
          request(wrongProof.issued.token, { certificateThumbprint: 'c'.repeat(64) }),
        )
      ).status,
    ).toBe(403);

    const oversized = await capability();
    expect(
      (await fixture.proxy.handle(request(oversized.issued.token, { body: new Uint8Array(17) })))
        .status,
    ).toBe(403);
  });

  test('rejects an oversized upstream response and returns a redacted denial', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      transport: async () => ({
        status: 502,
        headers: {},
        body: encoder.encode('provider-secret-body-that-exceeds-limit'),
      }),
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(403);
    expect(decoder.decode(response.body)).toBe('{"error":"MODULE_EGRESS_DENIED"}');
  });

  test('redacts a bounded provider error body instead of forwarding it to the caller', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      transport: async () => ({
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: encoder.encode('{"provider_api_key":"secret"}'),
      }),
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(403);
    expect(decoder.decode(response.body)).toBe('{"error":"MODULE_EGRESS_DENIED"}');
    expect(decoder.decode(response.body)).not.toContain('provider_api_key');
  });

  test('rejects caller header smuggling before consuming the capability', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({ publicKey: keys.publicKey });

    const response = await fixture.proxy.handle(
      request(issued.token, { headers: { 'x-module-value': 'ok\r\nx-injected: secret' } }),
    );

    expect(response.status).toBe(403);
    expect(fixture.operations).toEqual([]);
  });

  test('shares one wall-time budget across every allowed redirect hop', async () => {
    const { keys, issued } = await capability();
    const times = [100, 100, 1_100];
    let call = 0;
    const fixture = await proxyFixture({
      publicKey: keys.publicKey,
      monotonicNow: () => times.shift() ?? 1_100,
      transport: async (): Promise<ModuleEgressTransportResponse> => {
        call += 1;
        return call === 1
          ? { status: 307, headers: { location: '/v2/messages' }, body: new Uint8Array() }
          : { status: 200, headers: {}, body: encoder.encode('{"ok":true}') };
      },
    });

    const response = await fixture.proxy.handle(request(issued.token));

    expect(response.status).toBe(200);
    expect(fixture.transported.map((transport) => transport.timeoutMs)).toEqual([5_000, 4_000]);
  });

  test('strips headers named by the caller Connection field', async () => {
    const { keys, issued } = await capability();
    const fixture = await proxyFixture({ publicKey: keys.publicKey });

    const response = await fixture.proxy.handle(
      request(issued.token, {
        headers: {
          connection: 'x-module-private',
          'x-module-private': 'must-not-forward',
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(fixture.transported[0]?.headers).toEqual({
      authorization: 'Bearer provider-secret',
      'content-type': 'application/json',
    });
  });
});
