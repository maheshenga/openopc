import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserPolicy } from '@kortix/intelligence-contracts';
import ipaddr from 'ipaddr.js';

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

function isNonPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.range() !== 'unicast' || parsed.toString() === '168.63.129.16';
  } catch {
    return true;
  }
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
