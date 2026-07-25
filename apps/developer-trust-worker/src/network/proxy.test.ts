import { describe, expect, test } from 'bun:test';

import { createDeveloperModuleEgressPolicy } from './egress-policy';
import { DeveloperVerificationProxyError, createDeveloperModuleEgressProxy } from './proxy';

describe('developer module egress proxy', () => {
  test('pins DNS/TLS, strips credentials, bounds bytes, and records origin-only evidence', async () => {
    const requests: unknown[] = [];
    const evidence: unknown[] = [];
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      allowedMethods: ['POST'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 16,
    });
    const proxy = createDeveloperModuleEgressProxy({
      policy,
      transport: async (request) => {
        requests.push(request);
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from('{}'),
        };
      },
      recordEvidence: async (entry) => {
        evidence.push(entry);
      },
    });

    await expect(
      proxy.forward({
        url: 'https://allowed.example/v1/items?secret=query',
        method: 'POST',
        headers: {
          Authorization: 'Bearer must-strip',
          Cookie: 'session=must-strip',
          'Proxy-Authorization': 'must-strip',
          'Content-Type': 'application/json',
        },
        body: Buffer.from('{}'),
        declaredOrigins: ['https://allowed.example'],
        policyOrigins: ['https://allowed.example'],
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(requests).toEqual([
      expect.objectContaining({
        address: '93.184.216.34',
        tlsServername: 'allowed.example',
        rejectUnauthorized: true,
        headers: { 'content-type': 'application/json' },
      }),
    ]);
    expect(evidence).toEqual([
      { origin: 'https://allowed.example', method: 'POST', outcome: 'allowed' },
    ]);
    expect(JSON.stringify(evidence)).not.toContain('/v1/items');
    expect(JSON.stringify(evidence)).not.toContain('secret=query');
  });

  test('re-authorizes redirects and denies protected redirect targets', async () => {
    const evidence: unknown[] = [];
    let dispatched = 0;
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async (hostname) => [
        hostname === 'allowed.example'
          ? { address: '93.184.216.34', family: 4 as const }
          : { address: '127.0.0.1', family: 4 as const },
      ],
      allowedMethods: ['GET'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 16,
    });
    const proxy = createDeveloperModuleEgressProxy({
      policy,
      transport: async () => {
        dispatched += 1;
        return {
          status: 302,
          headers: { location: 'https://redirect.example/private' },
          body: new Uint8Array(),
        };
      },
      recordEvidence: async (entry) => {
        evidence.push(entry);
      },
    });

    await expect(
      proxy.forward({
        url: 'https://allowed.example/start',
        method: 'GET',
        headers: {},
        body: null,
        declaredOrigins: ['https://allowed.example', 'https://redirect.example'],
        policyOrigins: ['https://allowed.example', 'https://redirect.example'],
      }),
    ).rejects.toBeInstanceOf(DeveloperVerificationProxyError);
    expect(dispatched).toBe(1);
    expect(evidence.at(-1)).toEqual({
      origin: 'https://redirect.example',
      method: 'GET',
      outcome: 'denied',
    });
  });

  test('denies oversized responses without returning partial bytes', async () => {
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      allowedMethods: ['GET'],
      maxRequestBytes: 16,
      maxResponseBytes: 4,
    });
    const proxy = createDeveloperModuleEgressProxy({
      policy,
      transport: async () => ({ status: 200, headers: {}, body: Buffer.from('oversized') }),
      recordEvidence: async () => undefined,
    });

    await expect(
      proxy.forward({
        url: 'https://allowed.example',
        method: 'GET',
        headers: {},
        body: null,
        declaredOrigins: ['https://allowed.example'],
        policyOrigins: ['https://allowed.example'],
      }),
    ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_PROXY_DENIED' });
  });
});
