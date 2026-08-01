import type { CloudflareCustomHostnamePort, CloudflareCustomHostnameResult } from './bindings';

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4';
const CONFIG_VALUE_RE = /^[A-Za-z0-9._:-]{1,255}$/;
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ModuleDomainOperatorConfig {
  accountId: string;
  zoneId: string;
  apiToken: string;
  cnameTarget: string;
  origin: string;
  controlledSuffix: string;
}

export class ModuleCustomDomainProviderError extends Error {
  readonly code = 'MODULE_DOMAIN_PROVIDER_UNAVAILABLE';

  constructor() {
    super('MODULE_DOMAIN_PROVIDER_UNAVAILABLE');
    this.name = 'ModuleCustomDomainProviderError';
  }
}

function invalidConfig(): never {
  throw new TypeError('MODULE_DOMAIN_CONFIG_INVALID');
}

function normalizeHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/[.]$/, '');
  if (
    !HOSTNAME_RE.test(hostname) ||
    hostname.length > 253 ||
    !hostname.includes('.') ||
    hostname.includes('..') ||
    hostname.split('.').some((label) => !DNS_LABEL_RE.test(label))
  ) {
    invalidConfig();
  }
  return hostname;
}

function isStrictSubdomain(hostname: string, suffix: string): boolean {
  return hostname !== suffix && hostname.endsWith(`.${suffix}`);
}

export function parseModuleDomainOperatorConfig(input: {
  accountId: string;
  zoneId: string;
  apiToken: string;
  cnameTarget: string;
  origin: string;
  controlledSuffix: string;
}): ModuleDomainOperatorConfig | null {
  const values = [
    input.accountId,
    input.zoneId,
    input.apiToken,
    input.cnameTarget,
    input.origin,
    input.controlledSuffix,
  ];
  if (values.every((value) => value.trim() === '')) return null;
  if (values.some((value) => value.trim() === '')) invalidConfig();
  if (!CONFIG_VALUE_RE.test(input.accountId) || !CONFIG_VALUE_RE.test(input.zoneId))
    invalidConfig();
  if (input.apiToken.trim().length < 16 || input.apiToken.length > 4096) invalidConfig();

  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    invalidConfig();
  }
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    (origin.pathname !== '' && origin.pathname !== '/')
  ) {
    invalidConfig();
  }
  const originHostname = normalizeHostname(origin.hostname);
  const cnameTarget = normalizeHostname(input.cnameTarget);
  const controlledSuffix = normalizeHostname(input.controlledSuffix);
  if (controlledSuffix.split('.').length < 2) invalidConfig();
  if (
    !isStrictSubdomain(originHostname, controlledSuffix) ||
    !isStrictSubdomain(cnameTarget, controlledSuffix) ||
    cnameTarget === originHostname
  ) {
    invalidConfig();
  }
  return Object.freeze({
    accountId: input.accountId.trim(),
    zoneId: input.zoneId.trim(),
    apiToken: input.apiToken,
    cnameTarget,
    origin: origin.origin,
    controlledSuffix,
  });
}

function providerError(): never {
  throw new ModuleCustomDomainProviderError();
}

function providerState(result: Record<string, unknown>): CloudflareCustomHostnameResult {
  const id = typeof result.id === 'string' ? result.id : '';
  const status = typeof result.status === 'string' ? result.status : '';
  const ssl =
    result.ssl && typeof result.ssl === 'object' && !Array.isArray(result.ssl)
      ? (result.ssl as Record<string, unknown>)
      : null;
  const sslStatus = typeof ssl?.status === 'string' ? ssl.status : '';
  if (!id || id.length > 128 || !status) providerError();
  if (status === 'active' && sslStatus === 'active') {
    return { id, state: 'active', failureCode: null };
  }
  if (
    ['moved', 'deleted', 'blocked'].includes(status) ||
    /(?:failed|timed_out|error|expired)/i.test(sslStatus)
  ) {
    const code = (sslStatus || status).slice(0, 128);
    return { id, state: 'failed', failureCode: code };
  }
  return { id, state: 'pending', failureCode: null };
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    providerError();
  }
  if (!response.ok || text.length > MAX_RESPONSE_BYTES) providerError();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    providerError();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) providerError();
  const body = value as Record<string, unknown>;
  if (body.success !== true) providerError();
  return body;
}

export function createCloudflareCustomHostnamePort(
  input: ModuleDomainOperatorConfig & {
    fetch?: (request: Request) => Promise<Response>;
    apiBaseUrl?: string;
  },
): CloudflareCustomHostnamePort {
  const config = parseModuleDomainOperatorConfig(input);
  if (!config) invalidConfig();
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const apiBaseUrl = input.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const collectionUrl = `${apiBaseUrl}/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`;

  const request = async (
    url: string,
    init: RequestInit,
    options: { allowNotFound?: boolean } = {},
  ): Promise<Record<string, unknown>> => {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${config.apiToken}`);
    headers.set('accept', 'application/json');
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    let response: Response;
    try {
      response = await fetchImpl(
        new Request(url, {
          ...init,
          headers,
          signal: init.signal ?? AbortSignal.timeout(10_000),
        }),
      );
    } catch {
      providerError();
    }
    if (options.allowNotFound && response.status === 404) return {};
    return responseBody(response);
  };

  return {
    async create(hostname) {
      const body = await request(collectionUrl, {
        method: 'POST',
        body: JSON.stringify({ hostname, ssl: { method: 'cname', type: 'dv' } }),
      });
      if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
        providerError();
      }
      return providerState(body.result as Record<string, unknown>);
    },
    async get(id) {
      const body = await request(`${collectionUrl}/${encodeURIComponent(id)}`, { method: 'GET' });
      if (!body.result || typeof body.result !== 'object' || Array.isArray(body.result)) {
        providerError();
      }
      return providerState(body.result as Record<string, unknown>);
    },
    async delete(id) {
      await request(
        `${collectionUrl}/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        { allowNotFound: true },
      );
    },
  };
}
