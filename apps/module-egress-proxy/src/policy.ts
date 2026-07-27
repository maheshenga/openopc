import { BlockList, isIP } from 'node:net';

import type { CapabilityTokenClaimsV1 } from '@openopc/module-runtime-contracts';

const MAX_URL_LENGTH = 2_048;

// Bun 1.3.x cannot safely check a mixed-family BlockList on Windows.
const blockedV4Addresses = new BlockList();
const blockedV6Addresses = new BlockList();
const globalV6Addresses = new BlockList();
globalV6Addresses.addSubnet('2000::', 3, 'ipv6');

for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
] as const) {
  blockedV4Addresses.addSubnet(network, prefix, 'ipv4');
}

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blockedV6Addresses.addSubnet(network, prefix, 'ipv6');
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface AuthorizedEgressTarget extends ResolvedAddress {
  url: string;
  origin: string;
  tlsServername: string;
  maxResponseBytes: number;
}

export interface ModuleEgressPolicy {
  authorize(input: {
    url: string;
    method: string;
    requestBytes: number;
    claims: CapabilityTokenClaimsV1;
  }): Promise<AuthorizedEgressTarget>;
}

function isPublicAddress(value: ResolvedAddress): boolean {
  if (isIP(value.address) !== value.family) return false;
  return value.family === 4
    ? !blockedV4Addresses.check(value.address, 'ipv4')
    : globalV6Addresses.check(value.address, 'ipv6') &&
        !blockedV6Addresses.check(value.address, 'ipv6');
}

function deny(): never {
  throw new Error('MODULE_EGRESS_DENIED');
}

export function createEgressPolicy(input: {
  resolve(hostname: string): Promise<readonly ResolvedAddress[]>;
}): ModuleEgressPolicy {
  return {
    async authorize(request) {
      if (
        request.url.length > MAX_URL_LENGTH ||
        !Number.isSafeInteger(request.requestBytes) ||
        request.requestBytes < 0 ||
        request.requestBytes > request.claims.ceilings.maxRequestBytes
      ) {
        deny();
      }

      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        deny();
      }

      const method = request.method.toUpperCase();
      const egress = request.claims.egress;
      if (
        request.claims.aud !== 'openopc:capability/egress' ||
        request.claims.action !== 'http.request' ||
        !egress ||
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.hash !== '' ||
        !egress.origins.includes(url.origin) ||
        !egress.methods.includes(method)
      ) {
        deny();
      }

      const addresses = await input.resolve(url.hostname);
      if (addresses.length === 0 || !addresses.every(isPublicAddress)) deny();
      const pinned = addresses[0];
      if (!pinned) deny();

      return {
        url: url.href,
        origin: url.origin,
        address: pinned.address,
        family: pinned.family,
        tlsServername: url.hostname,
        maxResponseBytes: request.claims.ceilings.maxResponseBytes,
      };
    },
  };
}
