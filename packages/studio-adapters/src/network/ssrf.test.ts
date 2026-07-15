import { describe, expect, test } from 'bun:test';
import { validateStudioOrigin } from './ssrf';

type Address = { address: string; family: 4 | 6 };

function validate(
  rawUrl: string,
  addresses: readonly Address[],
  options: {
    privateOrigins?: readonly string[];
    allowInsecure?: boolean;
  } = {},
) {
  return validateStudioOrigin({
    url: new URL(rawUrl),
    resolve: async () => addresses,
    allowPrivateOrigins: new Set(options.privateOrigins ?? []),
    allowInsecureLocalEndpoints: options.allowInsecure ?? false,
  });
}

describe('validateStudioOrigin', () => {
  test('returns every validated public IPv4 and IPv6 answer', async () => {
    const addresses: readonly Address[] = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];

    await expect(validate('https://provider.example/v1/images', addresses)).resolves.toEqual(
      addresses,
    );
  });

  test.each([
    ['IPv4 loopback', '127.0.0.1', 4],
    ['IPv6 loopback', '::1', 6],
    ['IPv4 unspecified', '0.0.0.0', 4],
    ['IPv6 unspecified', '::', 6],
    ['RFC1918 10/8', '10.1.2.3', 4],
    ['RFC1918 172.16/12', '172.20.1.2', 4],
    ['RFC1918 192.168/16', '192.168.1.2', 4],
    ['IPv6 unique-local', 'fd00::1', 6],
    ['carrier-grade NAT', '100.64.0.1', 4],
    ['IPv4 link-local metadata', '169.254.169.254', 4],
    ['IPv6 link-local', 'fe80::1', 6],
    ['IPv4 multicast', '224.0.0.1', 4],
    ['IPv6 multicast', 'ff02::1', 6],
    ['IPv4 documentation', '192.0.2.1', 4],
    ['IPv4 documentation 2', '198.51.100.2', 4],
    ['IPv4 documentation 3', '203.0.113.3', 4],
    ['IPv6 documentation', '2001:db8::1', 6],
    ['IPv4-mapped IPv6 loopback', '::ffff:127.0.0.1', 6],
  ] as const)('rejects %s destinations', async (_name, address, family) => {
    await expect(
      validate('https://provider.example/v1', [{ address, family }]),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
  });

  test('permits only RFC1918 or unique-local addresses through an exact origin allowlist', async () => {
    await expect(
      validate('https://provider.internal.example:8443/v1', [{ address: '10.1.2.3', family: 4 }], {
        privateOrigins: ['https://provider.internal.example:8443'],
      }),
    ).resolves.toEqual([{ address: '10.1.2.3', family: 4 }]);
    await expect(
      validate('https://provider.internal.example:8443/v1', [{ address: 'fd00::1', family: 6 }], {
        privateOrigins: ['https://provider.internal.example:8443'],
      }),
    ).resolves.toEqual([{ address: 'fd00::1', family: 6 }]);
    await expect(
      validate('https://provider.internal.example:8444/v1', [{ address: '10.1.2.3', family: 4 }], {
        privateOrigins: ['https://provider.internal.example:8443'],
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
    await expect(
      validate(
        'https://provider.internal.example:8443/v1',
        [{ address: '169.254.169.254', family: 4 }],
        {
          privateOrigins: ['https://provider.internal.example:8443'],
        },
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
  });

  test('rejects localhost names before DNS resolution', async () => {
    let resolveCalls = 0;
    await expect(
      validateStudioOrigin({
        url: new URL('https://localhost./v1'),
        resolve: async () => {
          resolveCalls += 1;
          return [{ address: '8.8.8.8', family: 4 }];
        },
        allowPrivateOrigins: new Set(),
        allowInsecureLocalEndpoints: false,
      }),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
    expect(resolveCalls).toBe(0);
  });

  test('permits loopback only in explicitly authorized local-test mode', async () => {
    await expect(
      validate('http://127.0.0.1:9000/v1', [{ address: '127.0.0.1', family: 4 }], {
        allowInsecure: true,
      }),
    ).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
    await expect(
      validate('http://localhost:9000/v1', [{ address: '::1', family: 6 }], {
        allowInsecure: true,
      }),
    ).resolves.toEqual([{ address: '::1', family: 6 }]);
    await expect(
      validate(
        'http://169.254.169.254/latest/meta-data',
        [{ address: '169.254.169.254', family: 4 }],
        {
          allowInsecure: true,
        },
      ),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
  });

  test('rejects userinfo, base URL query strings, fragments, and HTTP downgrade', async () => {
    for (const rawUrl of [
      'https://user:password@provider.example/v1',
      'https://provider.example/v1?token=value',
      'https://provider.example/v1#fragment',
      'http://provider.example/v1',
    ]) {
      await expect(validate(rawUrl, [{ address: '8.8.8.8', family: 4 }])).rejects.toMatchObject({
        code: 'STUDIO_NETWORK_POLICY',
      });
    }
    await expect(
      validate('http://provider.example/v1', [{ address: '8.8.8.8', family: 4 }], {
        allowInsecure: true,
      }),
    ).resolves.toHaveLength(1);
  });

  test('rejects the full origin if any DNS answer is blocked or the resolver returns none', async () => {
    await expect(
      validate('https://provider.example/v1', [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ]),
    ).rejects.toMatchObject({ code: 'STUDIO_NETWORK_POLICY' });
    await expect(validate('https://provider.example/v1', [])).rejects.toMatchObject({
      code: 'STUDIO_NETWORK_POLICY',
    });
  });

  test('rejects malformed or mismatched resolver answers', async () => {
    for (const answer of [
      { address: 'not-an-ip', family: 4 as const },
      { address: '8.8.8.8', family: 6 as const },
    ]) {
      await expect(validate('https://provider.example/v1', [answer])).rejects.toMatchObject({
        code: 'STUDIO_NETWORK_POLICY',
      });
    }
  });
});
