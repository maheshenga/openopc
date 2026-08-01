import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import { zPayCanonicalString, zPaySign } from './zpay';
import { createZPayCallbackRoutes } from './zpay-callback';

const ORDER_NO = 'OPC202608010000000000000000001';
const TRADE_NO = 'trade-001';
const MERCHANT_PID = 'merchant-001';
const MERCHANT_KEY = 'merchant-key';

function callbackFields(overrides: Record<string, string> = {}): Record<string, string> {
  const fields = {
    money: '5.67',
    name: 'OpenOPC module purchase',
    out_trade_no: ORDER_NO,
    pid: MERCHANT_PID,
    trade_no: TRADE_NO,
    trade_status: 'TRADE_SUCCESS',
    type: 'alipay',
    sign_type: 'MD5',
    param: '',
    ...overrides,
  };
  return { ...fields, sign: zPaySign(fields, MERCHANT_KEY) };
}

function routeFixture(
  processCallback: (input: unknown) => Promise<{ kind: 'recorded' | 'duplicate' }> = async () => ({
    kind: 'recorded',
  }),
) {
  const calls: unknown[] = [];
  const app = createZPayCallbackRoutes({
    merchantPid: MERCHANT_PID,
    merchantKey: MERCHANT_KEY,
    now: () => new Date('2026-08-01T00:16:00.000Z'),
    orderService: {
      recordProviderCallback: async (input: unknown) => {
        calls.push(input);
        return processCallback(input);
      },
    },
  });
  return { app, calls };
}

describe('Z-Pay callback boundary', () => {
  test('verifies and forwards a successful callback with a canonical payload digest', async () => {
    const { app, calls } = routeFixture();
    const fields = callbackFields();
    const response = await app.request(`/zpay/callback?${new URLSearchParams(fields)}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('success');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        provider: 'zpay',
        merchantOrderNo: ORDER_NO,
        providerTradeNo: TRADE_NO,
        amountMinor: 567,
        paidAt: '2026-08-01T00:16:00.000Z',
        canonicalPayloadDigest: `sha256:${createHash('sha256')
          .update(zPayCanonicalString(fields))
          .digest('hex')}`,
      }),
    );
  });

  test('returns a stable failure for invalid signature, merchant, status, and amount syntax', async () => {
    for (const fields of [
      { ...callbackFields(), sign: '00000000000000000000000000000000' },
      callbackFields({ pid: 'other-merchant' }),
      callbackFields({ trade_status: 'TRADE_PENDING' }),
      callbackFields({ money: '5.678' }),
    ]) {
      const { app, calls } = routeFixture();
      const response = await app.request(`/zpay/callback?${new URLSearchParams(fields)}`);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('fail');
      expect(calls).toHaveLength(0);
    }
  });

  test('acknowledges a duplicate valid callback without exposing provider credentials', async () => {
    const { app, calls } = routeFixture(async () => ({ kind: 'duplicate' }));
    const response = await app.request(`/zpay/callback?${new URLSearchParams(callbackFields())}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('success');
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain(MERCHANT_KEY);
  });

  test('does not acknowledge an unknown order or an internal provider failure', async () => {
    const unknown = routeFixture(async () => {
      throw Object.assign(new Error('unknown'), {
        code: 'MODULE_PAYMENT_ORDER_NOT_FOUND',
        status: 404,
      });
    });
    const unknownResponse = await unknown.app.request(
      `/zpay/callback?${new URLSearchParams(callbackFields())}`,
    );
    expect(unknownResponse.status).toBe(400);
    expect(await unknownResponse.text()).toBe('fail');

    const unavailable = routeFixture(async () => {
      throw Object.assign(new Error('database down'), {
        code: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
        status: 503,
      });
    });
    const unavailableResponse = await unavailable.app.request(
      `/zpay/callback?${new URLSearchParams(callbackFields())}`,
    );
    expect(unavailableResponse.status).toBe(503);
    expect(await unavailableResponse.text()).toBe('fail');
  });
});
