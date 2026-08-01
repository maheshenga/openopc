import { createHash, timingSafeEqual } from 'node:crypto';

import {
  type DeveloperModulePaymentCheckout,
  DeveloperModulePaymentError,
  type DeveloperModulePaymentProviderPort,
} from './orders';

const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const MAX_AMOUNT_MINOR = 100_000_000;
const ZPAY_CALLBACK_PATH = '/v1/module-services/payments/zpay/callback';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ZPayCreateInput {
  orderId: string;
  merchantOrderNo: string;
  amountMinor: number;
  currency: 'CNY';
  productName: string;
  expiresAt: string;
  channel?: 'alipay' | 'wxpay';
  clientIp?: string;
}

export interface ZPayCreateResult {
  providerOrderId: string;
  checkout: DeveloperModulePaymentCheckout;
}

export interface ZPayLookupResult {
  tradeNo: string;
  outTradeNo: string;
  amountMinor: number;
  tradeStatus: string;
}

export interface ZPayRefundResult {
  status: 'refunded' | 'failed' | 'unknown';
  providerResult: Record<string, unknown> | null;
}

export interface ZPayClient {
  create(input: ZPayCreateInput): Promise<ZPayCreateResult>;
  lookup(input: { outTradeNo: string }): Promise<ZPayLookupResult>;
  refund(input: {
    tradeNo?: string;
    outTradeNo?: string;
    amountMinor: number;
  }): Promise<ZPayRefundResult>;
}

export interface ZPayClientOptions {
  baseUrl: string;
  merchantPid: string;
  merchantKey: string;
  callbackBaseUrl: string;
  fetch?: FetchLike;
}

interface ConfiguredZPayClient {
  baseUrl: string;
  merchantPid: string;
  merchantKey: string;
  callbackUrl: string;
}

export function zPayCanonicalString(fields: Record<string, unknown>): string {
  return Object.keys(fields)
    .filter((key) => key !== 'sign' && key !== 'sign_type')
    .filter((key) => fields[key] !== '' && fields[key] !== null && fields[key] !== undefined)
    .sort()
    .map((key) => `${key}=${String(fields[key])}`)
    .join('&');
}

export function zPaySign(fields: Record<string, unknown>, merchantKey: string): string {
  if (typeof merchantKey !== 'string' || merchantKey.length === 0) {
    providerUnavailable();
  }
  return createHash('md5')
    .update(`${zPayCanonicalString(fields)}${merchantKey}`)
    .digest('hex');
}

export function verifyZPaySignature(
  fields: Record<string, unknown>,
  signature: string,
  merchantKey: string,
): boolean {
  if (!/^[0-9a-f]{32}$/.test(signature)) return false;
  let expected: string;
  try {
    expected = zPaySign(fields, merchantKey);
  } catch {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export function formatZPayMoney(amountMinor: number): string {
  assertAmountMinor(amountMinor);
  const major = Math.floor(amountMinor / 100);
  const minor = String(amountMinor % 100).padStart(2, '0');
  return `${major}.${minor}`;
}

export function parseZPayMoney(value: string): number {
  const match = value.match(/^(0|[1-9][0-9]*)\.([0-9]{2})$/);
  if (!match) providerUnavailable();
  const amountMinor = Number(match[1]) * 100 + Number(match[2]);
  assertAmountMinor(amountMinor);
  return amountMinor;
}

export function createZPayClient(options: ZPayClientOptions): ZPayClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return {
    async create(input) {
      const configured = configuredOptions(options);
      validateCreateInput(input);
      const fields = {
        pid: configured.merchantPid,
        type: input.channel ?? 'alipay',
        out_trade_no: input.merchantOrderNo,
        notify_url: configured.callbackUrl,
        return_url: configured.callbackUrl,
        name: input.productName,
        money: formatZPayMoney(input.amountMinor),
        clientip: validClientIp(input.clientIp),
      };
      const body = signedForm(fields, configured.merchantKey);
      const payload = await fetchZPayJson(fetchImpl, `${configured.baseUrl}/mapi.php`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body,
      });
      if (Number(payload.code) !== 1) providerUnavailable();
      const providerOrderId = boundedProviderString(payload.trade_no, 128);
      const checkout = parseCheckout(payload);
      return { providerOrderId, checkout };
    },

    async lookup(input) {
      const configured = configuredOptions(options);
      const outTradeNo = boundedMerchantOrderNo(input.outTradeNo);
      const url = new URL(`${configured.baseUrl}/api.php`);
      url.search = new URLSearchParams({
        act: 'order',
        pid: configured.merchantPid,
        key: configured.merchantKey,
        out_trade_no: outTradeNo,
      }).toString();
      const payload = await fetchZPayJson(fetchImpl, url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (Number(payload.code) !== 1) providerUnavailable();
      return {
        tradeNo: boundedProviderString(payload.trade_no, 128),
        outTradeNo: boundedMerchantOrderNo(payload.out_trade_no),
        amountMinor: parseZPayMoney(boundedProviderString(payload.money, 32)),
        tradeStatus: boundedProviderString(payload.trade_status, 64),
      };
    },

    async refund(input) {
      const configured = configuredOptions(options);
      assertAmountMinor(input.amountMinor);
      const hasTradeNo = typeof input.tradeNo === 'string' && input.tradeNo.length > 0;
      const hasOutTradeNo = typeof input.outTradeNo === 'string' && input.outTradeNo.length > 0;
      if (hasTradeNo === hasOutTradeNo) providerUnavailable();
      const body = new URLSearchParams({
        pid: configured.merchantPid,
        key: configured.merchantKey,
        money: formatZPayMoney(input.amountMinor),
        ...(hasTradeNo
          ? { trade_no: boundedProviderString(input.tradeNo, 128) }
          : { out_trade_no: boundedMerchantOrderNo(input.outTradeNo) }),
      });
      try {
        const payload = await fetchZPayJson(fetchImpl, `${configured.baseUrl}/api.php?act=refund`, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          },
          body,
        });
        const code = Number(payload.code);
        return code === 1
          ? { status: 'refunded', providerResult: { code: 1 } }
          : { status: 'failed', providerResult: { code: Number.isFinite(code) ? code : 0 } };
      } catch {
        return { status: 'unknown', providerResult: null };
      }
    },
  };
}

export function createZPayDeveloperModulePaymentProvider(
  client: ZPayClient,
): DeveloperModulePaymentProviderPort {
  return {
    create: (input) => client.create(input),
    refund: ({ providerOrderId, amountMinor }) =>
      client.refund({ tradeNo: providerOrderId, amountMinor }),
  };
}

function configuredOptions(options: ZPayClientOptions): ConfiguredZPayClient {
  const baseUrl = normalizedHttpsOrigin(options.baseUrl);
  const callbackBaseUrl = normalizedHttpsOrigin(options.callbackBaseUrl);
  const merchantPid = boundedProviderString(options.merchantPid, 128);
  const merchantKey = boundedProviderString(options.merchantKey, 4096);
  return {
    baseUrl,
    merchantPid,
    merchantKey,
    callbackUrl: `${callbackBaseUrl}${ZPAY_CALLBACK_PATH}`,
  };
}

function normalizedHttpsOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    ) {
      providerUnavailable();
    }
    return url.origin;
  } catch {
    providerUnavailable();
  }
}

function validateCreateInput(input: ZPayCreateInput): void {
  boundedMerchantOrderNo(input.merchantOrderNo);
  assertAmountMinor(input.amountMinor);
  if (input.currency !== 'CNY') providerUnavailable();
  const productLength = [...input.productName].length;
  if (productLength < 1 || productLength > 100) providerUnavailable();
  if (!Number.isFinite(new Date(input.expiresAt).getTime())) providerUnavailable();
  if (input.channel !== undefined && !['alipay', 'wxpay'].includes(input.channel)) {
    providerUnavailable();
  }
}

function boundedMerchantOrderNo(value: unknown): string {
  const result = boundedProviderString(value, 32);
  if (!/^[A-Za-z0-9]+$/.test(result)) providerUnavailable();
  return result;
}

function boundedProviderString(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    hasAsciiControlCharacter(value)
  ) {
    providerUnavailable();
  }
  return value;
}

function validClientIp(value: string | undefined): string {
  if (value === undefined) return '127.0.0.1';
  if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)) providerUnavailable();
  return value;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertAmountMinor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_AMOUNT_MINOR) {
    providerUnavailable();
  }
}

function signedForm(fields: Record<string, string>, merchantKey: string): URLSearchParams {
  return new URLSearchParams({
    ...fields,
    sign: zPaySign(fields, merchantKey),
    sign_type: 'MD5',
  });
}

function parseCheckout(payload: Record<string, unknown>): DeveloperModulePaymentCheckout {
  const payUrl = optionalCheckoutUrl(payload.payurl);
  const mobileUrl = optionalCheckoutUrl(payload.payurl2);
  const qrCode = optionalCheckoutUrl(payload.qrcode);
  if (payUrl) return { kind: 'redirect', url: payUrl, mobileUrl };
  if (qrCode) return { kind: 'qr', url: qrCode, mobileUrl };
  providerUnavailable();
}

function optionalCheckoutUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) providerUnavailable();
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      providerUnavailable();
    }
    return url.toString();
  } catch {
    providerUnavailable();
  }
}

async function fetchZPayJson(
  fetchImpl: FetchLike,
  input: RequestInfo | URL,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch {
    providerUnavailable();
  }
  if (!response.ok) providerUnavailable();
  const text = await response.text();
  if (text.length > MAX_PROVIDER_RESPONSE_BYTES) providerUnavailable();
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) providerUnavailable();
    return parsed as Record<string, unknown>;
  } catch {
    providerUnavailable();
  }
}

function providerUnavailable(): never {
  throw new DeveloperModulePaymentError('MODULE_PAYMENT_PROVIDER_UNAVAILABLE', 503);
}
