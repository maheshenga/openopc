const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createTunnelPairing } = require('./tunnel-pairing');

const TEST_NOW = Date.parse('2026-07-29T12:00:00.000Z');

describe('Tunnel device pairing', () => {
  test('requires an explicit selected account for desktop pairing', () => {
    assert.throws(
      () => createTunnelPairing({ origin: 'https://app.example.test', fetch: async () => undefined }),
      { code: 'TUNNEL_PAIRING_ACCOUNT_REQUIRED' },
    );
  });

  test('sends the selected account id and preserves it in approved metadata', async () => {
    const calls = [];
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      machineHostname: 'workstation-1',
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (calls.length === 1) {
          return new Response(
            JSON.stringify({
              deviceCode: 'ABC123',
              deviceSecret: 'device-secret-123456',
              verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
              expiresAt: '2026-07-29T12:05:00.000Z',
              pollIntervalMs: 2000,
            }),
            { status: 201 },
          );
        }
        return new Response(
          JSON.stringify({
            status: 'approved',
            accountId: 'account-1',
            tunnelId: 'tunnel-1',
            token: 'setup-token-1234567890',
          }),
          { status: 200 },
        );
      },
    });

    await pairing.begin();
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      account_id: 'account-1',
      machineHostname: 'workstation-1',
    });
    assert.deepEqual(await pairing.pollOnce(), {
      status: 'approved',
      accountId: 'account-1',
      tunnelId: 'tunnel-1',
      setupToken: 'setup-token-1234567890',
    });
  });

  test('creates a device-auth request and exposes only safe pending metadata', async () => {
    const calls = [];
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test/projects',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({
            deviceCode: 'ABC123',
            deviceSecret: 'device-secret-never-exposed',
            verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
            expiresAt: '2026-07-29T12:05:00.000Z',
            pollIntervalMs: 2000,
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const pending = await pairing.begin();

    assert.deepEqual(pending, {
      code: 'ABC123',
      verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
      expiresAt: '2026-07-29T12:05:00.000Z',
    });
    assert.equal(calls[0].url, 'https://app.example.test/v1/tunnel/device-auth');
    assert.equal(JSON.stringify(pending).includes('device-secret-never-exposed'), false);
  });

  test('polls with Bearer secret and returns an approved setup token only after full validation', async () => {
    const calls = [];
    const responses = [
      {
        status: 201,
        body: {
          deviceCode: 'ABC123',
          deviceSecret: 'device-secret-123456',
          verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
          expiresAt: '2026-07-29T12:05:00.000Z',
          pollIntervalMs: 2000,
        },
      },
      { status: 200, body: { status: 'pending' } },
      {
        status: 200,
        body: {
          status: 'approved',
          accountId: 'account-1',
          tunnelId: 'tunnel-1',
          token: 'setup-token-1234567890',
        },
      },
    ];
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => Date.parse('2026-07-29T12:00:00.000Z'),
      fetch: async (url, init) => {
        calls.push({ url, init });
        const next = responses.shift();
        return new Response(JSON.stringify(next.body), { status: next.status });
      },
    });

    await pairing.begin();
    assert.deepEqual(await pairing.pollOnce(), { status: 'pending' });
    assert.deepEqual(await pairing.pollOnce(), {
      status: 'approved',
      accountId: 'account-1',
      tunnelId: 'tunnel-1',
      setupToken: 'setup-token-1234567890',
    });
    assert.equal(calls[1].init.headers.Authorization, 'Bearer device-secret-123456');
    assert.equal(pairing.status().pending, null);
    assert.equal(JSON.stringify(pairing.status()).includes('device-secret-123456'), false);
  });

  test('handles denial and expiry as terminal safe states', async () => {
    for (const terminal of ['denied', 'expired']) {
      const responses = [
        {
          status: 201,
          body: {
            deviceCode: 'ABC123',
            deviceSecret: 'device-secret-123456',
            verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
            expiresAt: '2026-07-29T12:05:00.000Z',
            pollIntervalMs: 2000,
          },
        },
        { status: 200, body: { status: terminal } },
      ];
      const pairing = createTunnelPairing({
        origin: 'https://app.example.test',
        accountId: 'account-1',
        now: () => Date.parse('2026-07-29T12:00:00.000Z'),
        fetch: async () => {
          const next = responses.shift();
          return new Response(JSON.stringify(next.body), { status: next.status });
        },
      });
      await pairing.begin();
      assert.deepEqual(await pairing.pollOnce(), { status: terminal });
      assert.equal(pairing.status().pending, null);
    }
  });

  test('fails closed for rejected secrets, incomplete approval, and API errors', async () => {
    const make = (pollResponse) => {
      const responses = [
        {
          status: 201,
          body: {
            deviceCode: 'ABC123',
            deviceSecret: 'device-secret-123456',
            verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
            expiresAt: '2026-07-29T12:05:00.000Z',
            pollIntervalMs: 2000,
          },
        },
        pollResponse,
      ];
      return createTunnelPairing({
        origin: 'https://app.example.test',
        accountId: 'account-1',
        now: () => Date.parse('2026-07-29T12:00:00.000Z'),
        fetch: async () => {
          const next = responses.shift();
          return new Response(JSON.stringify(next.body), { status: next.status });
        },
      });
    };

    const rejected = make({ status: 403, body: { error: 'Invalid secret' } });
    await rejected.begin();
    await assert.rejects(rejected.pollOnce(), { code: 'TUNNEL_PAIRING_SECRET_REJECTED' });

    const incomplete = make({ status: 200, body: { status: 'approved', tunnelId: 'tunnel-1' } });
    await incomplete.begin();
    await assert.rejects(incomplete.pollOnce(), { code: 'TUNNEL_PAIRING_APPROVAL_INCOMPLETE' });

    const wrongAccount = make({
      status: 200,
      body: {
        status: 'approved',
        accountId: 'account-2',
        tunnelId: 'tunnel-1',
        token: 'setup-token-1234567890',
      },
    });
    await wrongAccount.begin();
    await assert.rejects(wrongAccount.pollOnce(), {
      code: 'TUNNEL_PAIRING_ACCOUNT_MISMATCH',
    });

    const limited = make({ status: 429, body: { error: 'Too many requests' } });
    await limited.begin();
    await assert.rejects(limited.pollOnce(), { code: 'TUNNEL_PAIRING_API_ERROR' });
  });

  test('keeps cancelled state when cancel aborts the initial pairing request', async () => {
    let requestStarted;
    const started = new Promise((resolve) => {
      requestStarted = resolve;
    });
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          requestStarted();
          init.signal.addEventListener(
            'abort',
            () => {
              const error = new Error('Pairing request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    });

    const beginning = pairing.begin();
    await started;
    pairing.cancel();

    await assert.rejects(beginning, { code: 'TUNNEL_PAIRING_CANCELLED' });
    assert.equal(pairing.status().state, 'cancelled');
    assert.equal(pairing.status().error, null);
  });

  test('keeps cancelled state when the initial response body aborts', async () => {
    let bodyStarted;
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      fetch: async (_url, init) => ({
        status: 201,
        json: () =>
          new Promise((_resolve, reject) => {
            bodyStarted();
            init.signal.addEventListener(
              'abort',
              () => {
                const error = new Error('Pairing response body aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      }),
    });

    const beginning = pairing.begin();
    await started;
    pairing.cancel();

    await assert.rejects(beginning, { code: 'TUNNEL_PAIRING_CANCELLED' });
    assert.equal(pairing.status().state, 'cancelled');
    assert.equal(pairing.status().pending, null);
    assert.equal(pairing.status().error, null);
  });

  test('ignores a successful initial response body that arrives after cancellation', async () => {
    let bodyStarted;
    let resolveBody;
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async () => ({
        status: 201,
        json: () =>
          new Promise((resolve) => {
            resolveBody = resolve;
            bodyStarted();
          }),
      }),
    });

    const beginning = pairing.begin();
    await started;
    pairing.cancel();
    resolveBody({
      deviceCode: 'ABC123',
      deviceSecret: 'device-secret-123456',
      verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
      expiresAt: '2026-07-29T12:05:00.000Z',
      pollIntervalMs: 2000,
    });

    await assert.rejects(beginning, { code: 'TUNNEL_PAIRING_CANCELLED' });
    assert.equal(pairing.status().state, 'cancelled');
    assert.equal(pairing.status().pending, null);
    assert.equal(pairing.status().error, null);
  });

  test('keeps cancelled state when a poll response body aborts', async () => {
    let callCount = 0;
    let bodyStarted;
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async (_url, init) => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              deviceCode: 'ABC123',
              deviceSecret: 'device-secret-123456',
              verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
              expiresAt: '2026-07-29T12:05:00.000Z',
              pollIntervalMs: 2000,
            }),
            { status: 201 },
          );
        }
        return {
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              bodyStarted();
              init.signal.addEventListener(
                'abort',
                () => {
                  const error = new Error('Poll response body aborted');
                  error.name = 'AbortError';
                  reject(error);
                },
                { once: true },
              );
            }),
        };
      },
    });

    await pairing.begin();
    const polling = pairing.pollOnce();
    await started;
    pairing.cancel();

    await assert.rejects(polling, { code: 'TUNNEL_PAIRING_CANCELLED' });
    assert.equal(pairing.status().state, 'cancelled');
    assert.equal(pairing.status().pending, null);
    assert.equal(pairing.status().error, null);
  });

  test('does not let a stale poll completion clear a newer pairing request', async () => {
    let callCount = 0;
    let bodyStarted;
    let resolveOldBody;
    const started = new Promise((resolve) => {
      bodyStarted = resolve;
    });
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async (_url, init) => {
        callCount += 1;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              deviceCode: 'ABC123',
              deviceSecret: 'device-secret-123456',
              verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
              expiresAt: '2026-07-29T12:05:00.000Z',
              pollIntervalMs: 2000,
            }),
            { status: 201 },
          );
        }
        if (callCount === 2) {
          return {
            status: 200,
            json: () =>
              new Promise((resolve) => {
                resolveOldBody = resolve;
                bodyStarted();
              }),
          };
        }
        return new Response(
          JSON.stringify({
            deviceCode: 'XYZ789',
            deviceSecret: 'device-secret-654321',
            verificationUrl: 'https://app.example.test/tunnel/authorize/XYZ789',
            expiresAt: '2026-07-29T12:06:00.000Z',
            pollIntervalMs: 2000,
          }),
          { status: 201 },
        );
      },
    });

    await pairing.begin();
    const stalePoll = pairing.pollOnce();
    await started;
    pairing.cancel();
    await pairing.begin();
    resolveOldBody({
      status: 'approved',
      accountId: 'account-1',
      tunnelId: 'tunnel-old',
      token: 'setup-token-old-1234567890',
    });

    await assert.rejects(stalePoll, { code: 'TUNNEL_PAIRING_CANCELLED' });
    assert.equal(pairing.status().state, 'pairing_pending');
    assert.equal(pairing.status().pending.code, 'XYZ789');
  });

  test('aborts a superseded initial pairing request before starting the replacement', async () => {
    let callCount = 0;
    let firstStarted;
    let secondStarted;
    let resolveFirst;
    let abortCount = 0;
    const firstReady = new Promise((resolve) => {
      firstStarted = resolve;
    });
    const secondReady = new Promise((resolve) => {
      secondStarted = resolve;
    });
    const validResponse = (code, secret) =>
      new Response(
        JSON.stringify({
          deviceCode: code,
          deviceSecret: secret,
          verificationUrl: `https://app.example.test/tunnel/authorize/${code}`,
          expiresAt: '2026-07-29T12:05:00.000Z',
          pollIntervalMs: 2000,
        }),
        { status: 201 },
      );
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async (_url, init) => {
        callCount += 1;
        const current = callCount;
        if (current === 1) {
          return new Promise((resolve, reject) => {
            resolveFirst = () => resolve(validResponse('ABC123', 'device-secret-123456'));
            firstStarted();
            init.signal.addEventListener(
              'abort',
              () => {
                abortCount += 1;
                const error = new Error('First pairing request aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
        }
        return new Promise((_resolve, reject) => {
          secondStarted();
          init.signal.addEventListener(
            'abort',
            () => {
              abortCount += 1;
              const error = new Error('Second pairing request aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      },
    });

    const first = pairing.begin();
    await firstReady;
    const second = pairing.begin();
    await secondReady;
    pairing.cancel();

    try {
      assert.equal(abortCount, 2);
    } finally {
      resolveFirst?.();
    }
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
    assert.equal(pairing.status().state, 'cancelled');
  });

  test('cancels an active pairing and never leaves the device secret in status', async () => {
    const pairing = createTunnelPairing({
      origin: 'https://app.example.test',
      accountId: 'account-1',
      now: () => TEST_NOW,
      fetch: async () =>
        new Response(
          JSON.stringify({
            deviceCode: 'ABC123',
            deviceSecret: 'device-secret-123456',
            verificationUrl: 'https://app.example.test/tunnel/authorize/ABC123',
            expiresAt: '2026-07-29T12:05:00.000Z',
            pollIntervalMs: 2000,
          }),
          { status: 201 },
        ),
    });
    await pairing.begin();
    pairing.cancel();
    assert.equal(pairing.status().state, 'cancelled');
    assert.equal(pairing.status().pending, null);
    assert.equal(JSON.stringify(pairing.status()).includes('device-secret-123456'), false);
  });
});
