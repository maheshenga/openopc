import { createHash, timingSafeEqual } from 'node:crypto';

import {
  type CapabilityTokenClaimsV1,
  parseCapabilityTokenClaims,
} from '@openopc/module-runtime-contracts';
import { verify } from 'paseto-ts/v4';

import type { ModuleEgressPolicy } from './policy';

export interface ModuleEgressTransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
  address: string;
  family: 4 | 6;
  tlsServername: string;
  rejectUnauthorized: true;
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface ModuleEgressTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface VerifiedModuleCapability {
  claims: CapabilityTokenClaimsV1;
  tokenHash: `sha256:${string}`;
}

export interface ModuleCapabilityVerifier {
  verify(token: string): Promise<VerifiedModuleCapability | null>;
}

export interface ModuleEgressProxyRequest {
  authorization: string | null;
  certificateThumbprint: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}

export interface ModuleEgressProxy {
  handle(input: ModuleEgressProxyRequest): Promise<ModuleEgressTransportResponse>;
}

const DENIED_BODY = new TextEncoder().encode('{"error":"MODULE_EGRESS_DENIED"}');
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const MAX_TOKEN_LENGTH = 16_384;
const STRIPPED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function tokenKeyId(token: string): string | null {
  if (token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v4' || parts[1] !== 'public' || !parts[3]) return null;
  try {
    const footer = JSON.parse(Buffer.from(parts[3], 'base64url').toString('utf8')) as unknown;
    if (
      !footer ||
      typeof footer !== 'object' ||
      Array.isArray(footer) ||
      Object.keys(footer).length !== 1 ||
      typeof (footer as { kid?: unknown }).kid !== 'string'
    ) {
      return null;
    }
    return (footer as { kid: string }).kid;
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createPasetoCapabilityVerifier(input: {
  keys: ReadonlyMap<string, string>;
  now?: () => Date;
}): ModuleCapabilityVerifier {
  const now = input.now ?? (() => new Date());
  return {
    async verify(token) {
      try {
        const kid = tokenKeyId(token);
        if (!kid) return null;
        const key = input.keys.get(kid);
        if (!key) return null;
        const verified = verify(key, token, {
          maxDepth: 8,
          maxKeys: 64,
          validatePayload: false,
        });
        if (
          !verified.footer ||
          typeof verified.footer !== 'object' ||
          Array.isArray(verified.footer) ||
          Object.keys(verified.footer).length !== 1 ||
          !safeEqual(String(verified.footer.kid ?? ''), kid)
        ) {
          return null;
        }
        const claims = parseCapabilityTokenClaims(verified.payload);
        const observedAt = now().getTime();
        if (Date.parse(claims.iat) > observedAt || observedAt >= Date.parse(claims.exp))
          return null;
        return {
          claims,
          tokenHash: `sha256:${createHash('sha256').update(token).digest('hex')}`,
        };
      } catch {
        return null;
      }
    },
  };
}

function denied(): ModuleEgressTransportResponse {
  return {
    status: 403,
    headers: { 'content-type': 'application/json' },
    body: DENIED_BODY.slice(),
  };
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const entries: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  const dynamicHopByHop = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAME.test(name) || /[\r\n\0]/.test(value) || seen.has(normalized)) {
      throw new Error('MODULE_EGRESS_DENIED');
    }
    seen.add(normalized);
    entries.push([normalized, value]);
    if (normalized === 'connection') {
      for (const token of value.split(',')) {
        const connectionHeader = token.trim().toLowerCase();
        if (!HEADER_NAME.test(connectionHeader)) throw new Error('MODULE_EGRESS_DENIED');
        dynamicHopByHop.add(connectionHeader);
      }
    }
  }
  const sanitized: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!STRIPPED_HEADERS.has(name) && !dynamicHopByHop.has(name)) sanitized[name] = value;
  }
  return sanitized;
}

function responseHeader(headers: Record<string, string>, target: string): string | null {
  let found: string | null = null;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== target) continue;
    if (found !== null || /[\r\n\0]/.test(value)) throw new Error('MODULE_EGRESS_DENIED');
    found = value;
  }
  return found;
}

function redirectedRequest(
  status: number,
  method: string,
  body: Uint8Array | null,
): { method: string; body: Uint8Array | null } {
  if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
    return { method: 'GET', body: null };
  }
  return { method, body };
}

export function createModuleEgressProxy(input: {
  verifier: ModuleCapabilityVerifier;
  policy: ModuleEgressPolicy;
  consume(input: {
    tokenHash: `sha256:${string}`;
    claims: CapabilityTokenClaimsV1;
    observedAt: string;
  }): Promise<boolean>;
  credentialFor(input: {
    claims: CapabilityTokenClaimsV1;
    origin: string;
  }): Promise<{ name: string; value: string } | null>;
  transport(request: ModuleEgressTransportRequest): Promise<ModuleEgressTransportResponse>;
  now?: () => Date;
  monotonicNow?: () => number;
}): ModuleEgressProxy {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? (() => performance.now());
  return {
    async handle(request) {
      try {
        const match = request.authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/);
        if (!match) return denied();
        const capability = await input.verifier.verify(match[1]);
        if (
          !capability ||
          capability.claims.aud !== 'openopc:capability/egress' ||
          capability.claims.action !== 'http.request' ||
          !safeEqual(capability.claims.cnf.certificateSha256, request.certificateThumbprint)
        ) {
          return denied();
        }

        const callerHeaders = sanitizeHeaders(request.headers);
        let url = request.url;
        let method = request.method.toUpperCase();
        let body = request.body;
        let target = await input.policy.authorize({
          url,
          method,
          requestBytes: body?.byteLength ?? 0,
          claims: capability.claims,
        });
        const consumed = await input.consume({
          tokenHash: capability.tokenHash,
          claims: capability.claims,
          observedAt: now().toISOString(),
        });
        if (!consumed) return denied();

        const startedAt = monotonicNow();
        for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
          const elapsedMs = Math.max(0, monotonicNow() - startedAt);
          const remainingMs = Math.floor(capability.claims.ceilings.wallTimeMs - elapsedMs);
          if (!Number.isFinite(remainingMs) || remainingMs < 1) return denied();
          const headers = { ...callerHeaders };
          const credential = await input.credentialFor({
            claims: capability.claims,
            origin: target.origin,
          });
          if (credential) {
            const credentialName = credential.name.toLowerCase();
            if (!HEADER_NAME.test(credential.name) || /[\r\n\0]/.test(credential.value))
              return denied();
            headers[credentialName] = credential.value;
          }

          const response = await input.transport({
            url: target.url,
            method,
            headers,
            body,
            address: target.address,
            family: target.family,
            tlsServername: target.tlsServername,
            rejectUnauthorized: true,
            maxResponseBytes: target.maxResponseBytes,
            timeoutMs: remainingMs,
          });
          if (response.body.byteLength > target.maxResponseBytes) return denied();

          if (!REDIRECT_STATUSES.has(response.status)) {
            if (response.status < 200 || response.status >= 300) return denied();
            return {
              status: response.status,
              headers: sanitizeHeaders(response.headers),
              body: response.body,
            };
          }
          if (redirectCount === MAX_REDIRECTS) return denied();
          const location = responseHeader(response.headers, 'location');
          if (!location) return denied();
          url = new URL(location, url).href;
          ({ method, body } = redirectedRequest(response.status, method, body));
          target = await input.policy.authorize({
            url,
            method,
            requestBytes: body?.byteLength ?? 0,
            claims: capability.claims,
          });
        }
        return denied();
      } catch {
        return denied();
      }
    },
  };
}
