import { isIP } from 'node:net';

function parseIpv4(address: string): readonly number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split('.').map(Number);
  return octets.length === 4 ? octets : null;
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && octets[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && octets[2] === 100) ||
    (a === 203 && b === 0 && octets[2] === 113) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase().split('%')[0];
  if (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized === '2001:db8::'
  ) {
    return false;
  }
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  const first = Number.parseInt(normalized.split(':')[0] || '0', 16);
  return (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.trim();
  return isPublicIpv4(normalized) || isPublicIpv6(normalized);
}

export function allResolvedAddressesArePublic(addresses: readonly string[]): boolean {
  return addresses.length > 0 && addresses.every(isPublicAddress);
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      parsed.username !== '' ||
      parsed.password !== ''
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.home.arpa')
  );
}

export function isSafePublicTarget(
  targetUrl: string,
  resolvedAddresses: readonly string[],
): boolean {
  const parsed = parseHttpUrl(targetUrl);
  if (!parsed || isLocalHostname(parsed.hostname)) return false;
  if (isIP(parsed.hostname) !== 0 && !isPublicAddress(parsed.hostname)) return false;
  return allResolvedAddressesArePublic(resolvedAddresses);
}

export function matchesAllowedOrigin(
  targetUrl: string,
  allowedOrigins: readonly string[],
): boolean {
  const target = parseHttpUrl(targetUrl);
  if (!target) return false;
  return allowedOrigins.some((allowedValue) => {
    const allowed = parseHttpUrl(allowedValue);
    return (
      allowed !== null &&
      allowed.pathname === '/' &&
      allowed.search === '' &&
      allowed.hash === '' &&
      target.origin === allowed.origin
    );
  });
}
