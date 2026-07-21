import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export type BrowserOriginGuard = Readonly<{
  resolve(url: string, policy: BrowserPolicy): Promise<ResolvedBrowserTarget | null>;
  isAllowed(url: string, policy: BrowserPolicy): Promise<boolean>;
}>;

export type ResolvedBrowserTarget = Readonly<{
  address: string;
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
  url: string;
}>;

function ipv4Number(address: string): number | null {
  const octets = address.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }
  return ((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3];
}

function ipv4InCidr(address: number, network: string, prefix: number): boolean {
  const networkValue = ipv4Number(network);
  if (networkValue === null) return false;
  const divisor = 2 ** (32 - prefix);
  return Math.floor(address / divisor) === Math.floor(networkValue / divisor);
}

function normalizedIpv6Parts(address: string): string[] | null {
  const [leftRaw, rightRaw, extra] = address.toLowerCase().split('::');
  if (extra !== undefined) return null;
  const expand = (raw: string | undefined): string[] => {
    if (!raw) return [];
    const parts = raw.split(':');
    const last = parts.at(-1);
    if (last?.includes('.')) {
      const ipv4 = ipv4Number(last);
      if (ipv4 === null) return ['invalid'];
      parts.splice(
        parts.length - 1,
        1,
        ((ipv4 >>> 16) & 0xffff).toString(16),
        (ipv4 & 0xffff).toString(16),
      );
    }
    return parts;
  };
  const left = expand(leftRaw);
  const right = expand(rightRaw);
  const hadCompression = address.includes('::');
  const missing = 8 - left.length - right.length;
  if ((!hadCompression && missing !== 0) || (hadCompression && missing < 1)) return null;
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  return parts;
}

function ipv6Number(address: string): bigint | null {
  const parts = normalizedIpv6Parts(address);
  if (parts === null) return null;
  return parts.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function ipv6InCidr(address: bigint, network: string, prefix: number): boolean {
  const networkValue = ipv6Number(network);
  if (networkValue === null) return false;
  const shift = BigInt(128 - prefix);
  return address >> shift === networkValue >> shift;
}

function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) {
    const value = ipv4Number(address);
    if (value === null) return true;
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['168.63.129.16', 32],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([network, prefix]) => ipv4InCidr(value, network as string, prefix as number));
  }
  const value = ipv6Number(address);
  if (value === null) return true;
  return [
    ['::', 128],
    ['::1', 128],
    ['::ffff:0:0', 96],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ].some(([network, prefix]) => ipv6InCidr(value, network as string, prefix as number));
}

async function defaultResolveHostname(hostname: string): Promise<readonly string[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => answer.address);
}

function isOpenNetworkActive(policy: BrowserPolicy, now: Date): boolean {
  return (
    policy.network_mode === 'open' &&
    policy.open_network_expires_at !== null &&
    Date.parse(policy.open_network_expires_at) > now.getTime()
  );
}

export function createBrowserOriginGuard(options?: {
  resolveHostname?: HostnameResolver;
  now?: () => Date;
}): BrowserOriginGuard {
  const resolveHostname = options?.resolveHostname ?? defaultResolveHostname;
  const now = options?.now ?? (() => new Date());

  return {
    async resolve(value, policy) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return null;
      }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        return null;
      }
      const permittedByPolicy =
        isOpenNetworkActive(policy, now()) ||
        policy.allowed_origins.some((origin) => new URL(origin).origin === url.origin);
      if (!permittedByPolicy) return null;

      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: readonly string[];
      try {
        addresses = isIP(hostname) === 0 ? await resolveHostname(hostname) : [hostname];
      } catch {
        return null;
      }
      if (addresses.length === 0 || addresses.some(isNonPublicAddress)) return null;
      return {
        address: addresses[0],
        hostname,
        port: url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port),
        protocol: url.protocol,
        url: url.href,
      };
    },
    async isAllowed(value, policy) {
      return (await this.resolve(value, policy)) !== null;
    },
  };
}

export async function isAllowedBrowserUrl(url: string, policy: BrowserPolicy): Promise<boolean> {
  return createBrowserOriginGuard().isAllowed(url, policy);
}
