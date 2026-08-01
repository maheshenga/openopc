import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  type ZPayCreateInput,
  createZPayClient,
  createZPayDeveloperModulePaymentProvider,
  formatZPayMoney,
  zPayCanonicalString,
  zPaySign,
} from './zpay';

const MERCHANT_PID = 'merchant-001';
const MERCHANT_KEY = 'merchant-key';
const ORDER_NO = 'OPC202608010000000000000000001';

const createInput: ZPayCreateInput = {
  orderId: '90000000-0000-4000-8000-000000000001',
  merchantOrderNo: ORDER_NO,
  amountMinor: 567,
  currency: 'CNY',
  productName: 'OpenOPC module purchase',
  expiresAt: '2026-08-01T00:15:00.000Z',
};

describe('Z-Pay protocol adapter', () => {
  test('canonicalizes and signs only non-empty fields in ASCII order', () => {
    const fields = {
      money: '5.67',
      name: 'OpenOPC module purchase',
      out_trade_no: ORDER_NO,
      pid: MERCHANT_PID,
      type: 'alipay',
      sign: 'ignored',
      sign_type: 'MD5',
      param: '',
    };
    const canonical = zPayCanonicalString(fields);
    expect(canonical).toBe(
      `money=5.67&name=OpenOPC module purchase&out_trade_no=${ORDER_NO}&pid=merchant-001&type=alipay`,
    );
    expect(zPaySign(fields, MERCHANT_KEY)).toBe(
      createHash('md5').update(`${canonical}${MERCHANT_KEY}`).digest('hex'),
    );
    expect(formatZPayMoney(567)).toBe('5.67');
  });

  test('creates a provider-neutral checkout without exposing merchant credentials', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createZPayClient({
      baseUrl: 'https://zpay.example.com/',
      merchantPid: MERCHANT_PID,
      merchantKey: MERCHANT_KEY,
      callbackBaseUrl: 'https://platform.example.com',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            code: 1,
            trade_no: 'trade-001',
            out_trade_no: ORDER_NO,
            payurl: 'https://pay.example.com/checkout/one',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const result = await client.create(createInput);
    expect(result).toEqual({
      providerOrderId: 'trade-001',
      checkout: {
        kind: 'redirect',
        url: 'https://pay.example.com/checkout/one',
        mobileUrl: null,
      },
    });
    expect(requests[0]?.url).toBe('https://zpay.example.com/mapi.php');
    const form = new URLSearchParams(String(requests[0]?.init?.body));
    expect(form.get('money')).toBe('5.67');
    expect(form.get('out_trade_no')).toBe(ORDER_NO);
    expect(form.get('notify_url')).toBe(
      'https://platform.example.com/v1/module-services/payments/zpay/callback',
    );
    expect(form.get('return_url')).toBe(
      'https://platform.example.com/v1/module-services/payments/zpay/callback',
    );
    expect(form.get('sign_type')).toBe('MD5');
    expect(form.has('key')).toBe(false);
    expect(String(requests[0]?.init?.body)).not.toContain(MERCHANT_KEY);
  });

  test('uses the documented query and refund endpoints and retains unknown refund outcomes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let refundAttempts = 0;
    const client = createZPayClient({
      baseUrl: 'https://zpay.example.com',
      merchantPid: MERCHANT_PID,
      merchantKey: MERCHANT_KEY,
      callbackBaseUrl: 'https://platform.example.com',
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes('act=order')) {
          return new Response(
            JSON.stringify({
              code: 1,
              trade_no: 'trade-001',
              out_trade_no: ORDER_NO,
              money: '5.67',
              trade_status: 'TRADE_SUCCESS',
            }),
            { status: 200 },
          );
        }
        refundAttempts += 1;
        throw new Error('network detail must not escape');
      },
    });

    const lookup = await client.lookup({ outTradeNo: ORDER_NO });
    expect(lookup).toMatchObject({
      tradeNo: 'trade-001',
      outTradeNo: ORDER_NO,
      amountMinor: 567,
      tradeStatus: 'TRADE_SUCCESS',
    });
    await expect(client.refund({ outTradeNo: ORDER_NO, amountMinor: 567 })).resolves.toEqual({
      status: 'unknown',
      providerResult: null,
    });
    expect(refundAttempts).toBe(1);
    expect(requests[0]?.url).toContain('/api.php?act=order');
    expect(requests[0]?.url).toContain('key=merchant-key');
    expect(JSON.stringify(lookup)).not.toContain(MERCHANT_KEY);
    const refundForm = new URLSearchParams(String(requests[1]?.init?.body));
    expect(refundForm.get('out_trade_no')).toBe(ORDER_NO);
    expect(refundForm.get('trade_no')).toBeNull();
    expect(refundForm.get('money')).toBe('5.67');
    expect(refundForm.get('key')).toBe(MERCHANT_KEY);
  });

  test('fails closed when provider configuration is missing or not HTTPS', async () => {
    const client = createZPayClient({
      baseUrl: 'http://zpay.example.com',
      merchantPid: '',
      merchantKey: '',
      callbackBaseUrl: 'http://platform.example.com',
      fetch: async () => new Response('{}'),
    });

    await expect(client.create(createInput)).rejects.toMatchObject({
      code: 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE',
      status: 503,
    });
  });

  test('adapts the platform provider port without exposing Z-Pay identifiers to modules', async () => {
    const calls: unknown[] = [];
    const provider = createZPayDeveloperModulePaymentProvider({
      async create(input) {
        calls.push({ operation: 'create', input });
        return {
          providerOrderId: 'trade-001',
          checkout: { kind: 'redirect', url: 'https://pay.example.com/one', mobileUrl: null },
        };
      },
      async lookup(input) {
        calls.push({ operation: 'lookup', input });
        throw new Error('lookup is not part of the provider port');
      },
      async refund(input) {
        calls.push({ operation: 'refund', input });
        return { status: 'refunded', providerResult: { code: 1 } };
      },
    });

    await provider.create(createInput);
    await expect(
      provider.refund({ providerOrderId: 'trade-001', amountMinor: 567 }),
    ).resolves.toEqual({ status: 'refunded', providerResult: { code: 1 } });
    expect(calls).toEqual([
      { operation: 'create', input: createInput },
      { operation: 'refund', input: { tradeNo: 'trade-001', amountMinor: 567 } },
    ]);
  });
});
