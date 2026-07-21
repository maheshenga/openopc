import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';
import { openPinnedUpstream } from './network-proxy';
import type { BrowserOriginGuard } from './origin-guard';

const policy: BrowserPolicy = {
  allowed_origins: ['https://console.example.test'],
  network_mode: 'allowlist',
  open_network_expires_at: null,
  context: { mode: 'temporary', profile_id: null },
};

test('opens the upstream socket to the single validated IP without a second DNS lookup', async () => {
  let resolutions = 0;
  const guard: BrowserOriginGuard = {
    isAllowed: async () => true,
    resolve: async (url) => {
      resolutions += 1;
      return resolutions === 1
        ? {
            address: '93.184.216.34',
            hostname: 'console.example.test',
            port: 443,
            protocol: 'https:',
            url,
          }
        : null;
    },
  };
  const connections: Array<{ host: string; port: number }> = [];

  const upstream = await openPinnedUpstream(
    'https://console.example.test/workflows',
    policy,
    guard,
    ({ host, port }) => {
      connections.push({ host, port });
      return new PassThrough();
    },
  );

  expect(upstream).toBeInstanceOf(PassThrough);
  expect(resolutions).toBe(1);
  expect(connections).toEqual([{ host: '93.184.216.34', port: 443 }]);
});
