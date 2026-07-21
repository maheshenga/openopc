import { lookup } from 'node:dns/promises';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

export type BrowserOriginGuard = Readonly<{
  isAllowed(url: string, policy: BrowserPolicy): Promise<boolean>;
}>;

function isPrivateIpv4(value: string): boolean {
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isPrivateIpv6(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    address === '::' ||
    address === '::1' ||
    address.startsWith('fe8') ||
    address.startsWith('fe9') ||
    address.startsWith('fea') ||
    address.startsWith('feb') ||
    address.startsWith('fc') ||
    address.startsWith('fd') ||
    address.startsWith('::ffff:127.') ||
    address.startsWith('::ffff:10.') ||
    address.startsWith('::ffff:192.168.')
  );
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isNonPublicAddress(address: string): boolean {
  return address.includes(':') ? isPrivateIpv6(address) : isPrivateIpv4(address);
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
    async isAllowed(value, policy) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
        return false;
      }
      const permittedByPolicy =
        isOpenNetworkActive(policy, now()) || policy.allowed_origins.includes(url.origin);
      if (!permittedByPolicy) return false;

      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (isIpAddress(hostname)) return !isNonPublicAddress(hostname);
      try {
        const addresses = await resolveHostname(hostname);
        return addresses.length > 0 && addresses.every((address) => !isNonPublicAddress(address));
      } catch {
        return false;
      }
    },
  };
}

export async function isAllowedBrowserUrl(url: string, policy: BrowserPolicy): Promise<boolean> {
  return createBrowserOriginGuard().isAllowed(url, policy);
}
