import { describe, expect, test } from 'bun:test';

import {
  DeveloperVerificationEgressError,
  createDeveloperModuleEgressPolicy,
} from './egress-policy';

describe('developer module egress policy', () => {
  test.each([
    'http://169.254.169.254/latest/meta-data',
    'https://127.0.0.1',
    'https://10.0.0.8',
    'https://[::1]',
    'https://[fe80::1]',
    'https://[ff02::1]',
  ] as const)('denies protected destination %s', async (url) => {
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async () => [],
      allowedMethods: ['GET', 'POST'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
    });
    await expect(
      policy.authorize({
        url,
        method: 'GET',
        requestBytes: 0,
        declaredOrigins: [],
        policyOrigins: [],
      }),
    ).rejects.toBeInstanceOf(DeveloperVerificationEgressError);
  });

  test('allows only the HTTPS intersection and returns a DNS-pinned public address', async () => {
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async (hostname) =>
        hostname === 'allowed.example' ? [{ address: '93.184.216.34', family: 4 }] : [],
      allowedMethods: ['GET'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
    });
    await expect(
      policy.authorize({
        url: 'https://allowed.example/path?q=1',
        method: 'GET',
        requestBytes: 12,
        declaredOrigins: ['https://allowed.example'],
        policyOrigins: ['https://allowed.example', 'https://other.example'],
      }),
    ).resolves.toMatchObject({
      origin: 'https://allowed.example',
      hostname: 'allowed.example',
      address: '93.184.216.34',
      family: 4,
      tlsServername: 'allowed.example',
    });
  });

  test('re-resolves every request and fails closed on DNS rebinding', async () => {
    let resolutions = 0;
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async () => {
        resolutions += 1;
        return [
          resolutions === 1
            ? { address: '93.184.216.34', family: 4 as const }
            : { address: '127.0.0.1', family: 4 as const },
        ];
      },
      allowedMethods: ['GET'],
      maxRequestBytes: 1_024,
      maxResponseBytes: 4_096,
    });
    const request = {
      url: 'https://allowed.example/data',
      method: 'GET',
      requestBytes: 0,
      declaredOrigins: ['https://allowed.example'],
      policyOrigins: ['https://allowed.example'],
    } as const;

    await expect(policy.authorize(request)).resolves.toBeDefined();
    await expect(policy.authorize(request)).rejects.toMatchObject({
      code: 'DEVELOPER_VERIFICATION_EGRESS_DENIED',
    });
  });

  test('denies undeclared origins, methods, credentials, and oversized requests', async () => {
    const policy = createDeveloperModuleEgressPolicy({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      allowedMethods: ['GET'],
      maxRequestBytes: 16,
      maxResponseBytes: 4_096,
    });
    for (const request of [
      { url: 'https://other.example', method: 'GET', requestBytes: 0 },
      { url: 'https://allowed.example', method: 'DELETE', requestBytes: 0 },
      { url: 'https://user:pass@allowed.example', method: 'GET', requestBytes: 0 },
      { url: 'https://allowed.example', method: 'GET', requestBytes: 17 },
    ]) {
      await expect(
        policy.authorize({
          ...request,
          declaredOrigins: ['https://allowed.example'],
          policyOrigins: ['https://allowed.example'],
        }),
      ).rejects.toMatchObject({ code: 'DEVELOPER_VERIFICATION_EGRESS_DENIED' });
    }
  });
});
