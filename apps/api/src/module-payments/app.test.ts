import { describe, expect, test } from 'bun:test';

import { createModulePaymentsApp } from './app';
import { zPaySign } from './zpay';

const MERCHANT_PID = 'merchant-001';
const MERCHANT_KEY = 'merchant-key';

function signedCallback(): URLSearchParams {
  const fields = {
    money: '5.67',
    name: 'OpenOPC module purchase',
    out_trade_no: 'OPC202608010000000000000000001',
    pid: MERCHANT_PID,
    trade_no: 'trade-001',
    trade_status: 'TRADE_SUCCESS',
    type: 'alipay',
    sign_type: 'MD5',
  };
  return new URLSearchParams({ ...fields, sign: zPaySign(fields, MERCHANT_KEY) });
}

describe('public module payment app', () => {
  test('exposes only the verified GET callback route', async () => {
    const calls: unknown[] = [];
    const app = createModulePaymentsApp({
      merchantPid: MERCHANT_PID,
      merchantKey: MERCHANT_KEY,
      now: () => new Date('2026-08-01T00:16:00.000Z'),
      orderService: {
        async recordProviderCallback(input) {
          calls.push(input);
          return { kind: 'recorded' as const };
        },
      },
    });

    const callback = await app.request(`/zpay/callback?${signedCallback()}`);
    expect(callback.status).toBe(200);
    expect(await callback.text()).toBe('success');
    expect(calls).toHaveLength(1);

    expect((await app.request('/zpay/callback', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/orders')).status).toBe(404);
    expect((await app.request('/refunds')).status).toBe(404);
  });
});
