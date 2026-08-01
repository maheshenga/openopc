import { createHash } from 'node:crypto';

import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import type { DeveloperModulePaymentProviderCallbackInput } from './orders';
import { parseZPayMoney, verifyZPaySignature, zPayCanonicalString } from './zpay';

const MAX_CALLBACK_FIELDS = 32;
const MAX_CALLBACK_KEY_BYTES = 128;
const MAX_CALLBACK_VALUE_BYTES = 4096;

export type ZPayProviderCallbackInput = DeveloperModulePaymentProviderCallbackInput;

export interface ZPayCallbackOrderService {
  recordProviderCallback(
    input: ZPayProviderCallbackInput,
  ): Promise<{ kind: 'recorded' | 'duplicate' }>;
}

export interface ZPayCallbackRouteDependencies {
  merchantPid: string;
  merchantKey: string;
  orderService: ZPayCallbackOrderService;
  now?: () => Date;
}

export function createZPayCallbackRoutes(dependencies: ZPayCallbackRouteDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  const now = dependencies.now ?? (() => new Date());

  app.get('/zpay/callback', async (context) => {
    if (!validMerchantConfiguration(dependencies.merchantPid, dependencies.merchantKey)) {
      return context.text('fail', 503);
    }

    const fields = callbackFields(new URL(context.req.url).searchParams);
    if (
      !fields ||
      !validProtocolFields(fields, dependencies.merchantPid, dependencies.merchantKey)
    ) {
      return context.text('fail', 400);
    }

    let amountMinor: number;
    let paidAt: string;
    try {
      amountMinor = parseZPayMoney(fields.money);
      const current = now();
      if (!Number.isFinite(current.getTime())) throw new TypeError('invalid callback clock');
      paidAt = current.toISOString();
    } catch {
      return context.text('fail', 400);
    }

    try {
      const result = await dependencies.orderService.recordProviderCallback({
        provider: 'zpay',
        merchantOrderNo: fields.out_trade_no,
        providerTradeNo: fields.trade_no,
        amountMinor,
        paidAt,
        canonicalPayloadDigest: `sha256:${createHash('sha256')
          .update(zPayCanonicalString(fields))
          .digest('hex')}`,
      });
      if (result.kind !== 'recorded' && result.kind !== 'duplicate') {
        return context.text('fail', 503);
      }
      return context.text('success', 200);
    } catch (error) {
      return context.text('fail', providerFailureStatus(error));
    }
  });

  return app;
}

function callbackFields(search: URLSearchParams): Record<string, string> | null {
  const fields: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of search) {
    count += 1;
    if (
      count > MAX_CALLBACK_FIELDS ||
      Object.hasOwn(fields, key) ||
      Buffer.byteLength(key, 'utf8') < 1 ||
      Buffer.byteLength(key, 'utf8') > MAX_CALLBACK_KEY_BYTES ||
      Buffer.byteLength(value, 'utf8') > MAX_CALLBACK_VALUE_BYTES ||
      hasAsciiControlCharacter(key) ||
      hasAsciiControlCharacter(value)
    ) {
      return null;
    }
    fields[key] = value;
  }
  return fields;
}

function validProtocolFields(
  fields: Record<string, string>,
  merchantPid: string,
  merchantKey: string,
): boolean {
  const productName = fields.name;
  return Boolean(
    fields.pid === merchantPid &&
      fields.trade_status === 'TRADE_SUCCESS' &&
      fields.sign_type === 'MD5' &&
      (fields.type === 'alipay' || fields.type === 'wxpay') &&
      /^[A-Za-z0-9]{1,32}$/.test(fields.out_trade_no ?? '') &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(fields.trade_no ?? '') &&
      typeof productName === 'string' &&
      [...productName].length >= 1 &&
      [...productName].length <= 100 &&
      verifyZPaySignature(fields, fields.sign ?? '', merchantKey),
  );
}

function validMerchantConfiguration(merchantPid: string, merchantKey: string): boolean {
  const valid =
    /^[A-Za-z0-9._:-]{1,128}$/.test(merchantPid) &&
    merchantKey.length >= 1 &&
    merchantKey.length <= 4096 &&
    !hasAsciiControlCharacter(merchantKey);
  return valid;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function providerFailureStatus(error: unknown): 400 | 503 {
  if (
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === 'MODULE_PAYMENT_PROVIDER_UNAVAILABLE'
  ) {
    return 503;
  }
  if (
    error &&
    typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    /^MODULE_(?:SERVICE|PAYMENT)_/.test(String((error as { code: string }).code))
  ) {
    return 400;
  }
  return 503;
}
