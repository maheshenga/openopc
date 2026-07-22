import { describe, expect, test } from 'bun:test';
import {
  createMemoryWorkerNonceStore,
  createRedisWorkerNonceStore,
  createWorkerServiceAuthenticator,
} from './worker-auth';

describe('Redis Worker nonce store', () => {
  test('atomically advances a hashed service nonce with bounded expiry', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const replies: unknown[] = [1, 0, 0];
    const store = createRedisWorkerNonceStore(
      {
        async send(command, args) {
          calls.push({ command, args });
          return replies.shift();
        },
      },
      { ttlMs: 120_000 },
    );

    await expect(store.consume('browser-worker-sensitive-name', 41)).resolves.toBeTrue();
    await expect(store.consume('browser-worker-sensitive-name', 41)).resolves.toBeFalse();
    await expect(store.consume('browser-worker-sensitive-name', 40)).resolves.toBeFalse();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.command).toBe('EVAL');
    expect(calls[0]?.args[1]).toBe('1');
    expect(calls[0]?.args[2]).toMatch(/^automation:worker-proof:nonce:v1:[a-f0-9]{64}$/);
    expect(calls[0]?.args.slice(3)).toEqual(['41', '120000']);
    expect(calls[0]?.args.join(' ')).not.toContain('browser-worker-sensitive-name');
    expect(calls[1]?.args.slice(2)).toEqual(calls[0]?.args.slice(2));
    expect(calls[2]?.args.slice(3)).toEqual(['40', '120000']);
  });

  test('does not treat inherited record properties as trusted Worker identities', () => {
    const authenticator = createWorkerServiceAuthenticator({
      trustedPeers: {},
      nonceStore: createMemoryWorkerNonceStore(),
      now: () => new Date('2026-07-23T02:00:00.000Z'),
    });

    expect(() =>
      authenticator.bindTlsPeer({
        authorized: true,
        serviceId: 'toString',
        fingerprint256: 'AA:BB:CC:DD',
        validTo: '2026-07-24T02:00:00.000Z',
      }),
    ).toThrow(/not trusted/i);
  });
});
