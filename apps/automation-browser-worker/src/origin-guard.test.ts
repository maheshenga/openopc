import { describe, expect, test } from 'bun:test';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';
import { createBrowserOriginGuard } from './origin-guard';

const policy = (overrides: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  allowed_origins: ['https://console.example.test'],
  network_mode: 'allowlist',
  open_network_expires_at: null,
  context: { mode: 'temporary', profile_id: null },
  ...overrides,
});

describe('browser origin guard', () => {
  test('allows only an exact allowlisted public origin', async () => {
    const guard = createBrowserOriginGuard({ resolveHostname: async () => ['93.184.216.34'] });

    await expect(
      guard.isAllowed('https://console.example.test/workflows', policy()),
    ).resolves.toBeTrue();
    await expect(
      guard.isAllowed('http://console.example.test/workflows', policy()),
    ).resolves.toBeFalse();
    await expect(
      guard.isAllowed('https://console.example.test:8443/workflows', policy()),
    ).resolves.toBeFalse();
    await expect(
      guard.isAllowed('https://other.example.test/redirect', policy()),
    ).resolves.toBeFalse();
  });

  test('denies private addresses, non-public DNS answers, malformed URLs, and DNS failures', async () => {
    const guard = createBrowserOriginGuard({
      resolveHostname: async (hostname) => {
        if (hostname === 'fails.example.test') throw new Error('dns unavailable');
        return ['10.0.0.8'];
      },
    });
    const allowed = policy({
      allowed_origins: [
        'http://127.0.0.1',
        'http://[::1]',
        'http://169.254.169.254',
        'http://168.63.129.16',
        'https://private.example.test',
        'https://fails.example.test',
      ],
    });

    for (const url of [
      'http://127.0.0.1',
      'http://10.0.0.2',
      'http://[::1]',
      'http://169.254.169.254/latest/meta-data',
      'http://168.63.129.16/machine?comp=goalstate',
      'http://[::ffff:7f00:1]',
      'http://[::ffff:ac10:1]',
      'https://private.example.test',
      'https://fails.example.test',
      'not a url',
    ]) {
      await expect(guard.isAllowed(url, allowed)).resolves.toBeFalse();
    }
  });

  test('requires a still-valid explicit expiry for open network and re-checks redirect targets', async () => {
    const guard = createBrowserOriginGuard({
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      resolveHostname: async () => ['93.184.216.34'],
    });
    const open = policy({
      network_mode: 'open',
      open_network_expires_at: '2026-07-22T00:05:00.000Z',
    });

    await expect(guard.isAllowed('https://redirect.example.test/next', open)).resolves.toBeTrue();
    await expect(
      guard.isAllowed(
        'https://redirect.example.test/next',
        policy({ network_mode: 'open', open_network_expires_at: '2026-07-21T23:59:59.000Z' }),
      ),
    ).resolves.toBeFalse();
    await expect(
      guard.isAllowed('https://outside.example.test/final', policy()),
    ).resolves.toBeFalse();
  });

  test('returns the validated public address so the network connector can pin it', async () => {
    let resolutions = 0;
    const guard = createBrowserOriginGuard({
      resolveHostname: async () => {
        resolutions += 1;
        return resolutions === 1 ? ['93.184.216.34'] : ['127.0.0.1'];
      },
    });

    const target = await guard.resolve('https://console.example.test/workflows', policy());

    expect(target).toEqual({
      address: '93.184.216.34',
      hostname: 'console.example.test',
      port: 443,
      protocol: 'https:',
      url: 'https://console.example.test/workflows',
    });
    expect(resolutions).toBe(1);
  });
});
