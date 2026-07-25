export interface DeveloperResolvedAddress {
  address: string;
  family: 4 | 6;
}

export class DeveloperVerificationEgressError extends Error {
  readonly code = 'DEVELOPER_VERIFICATION_EGRESS_DENIED';

  constructor() {
    super('DEVELOPER_VERIFICATION_EGRESS_DENIED');
    this.name = 'DeveloperVerificationEgressError';
  }
}

export interface AuthorizedDeveloperEgressTarget {
  url: string;
  origin: string;
  hostname: string;
  address: string;
  family: 4 | 6;
  method: string;
  tlsServername: string;
  maxResponseBytes: number;
}

export interface DeveloperModuleEgressPolicy {
  authorize(input: {
    url: string;
    method: string;
    requestBytes: number;
    declaredOrigins: readonly string[];
    policyOrigins: readonly string[];
  }): Promise<AuthorizedDeveloperEgressTarget>;
}

export function createDeveloperModuleEgressPolicy(input: {
  resolve(hostname: string): Promise<readonly DeveloperResolvedAddress[]>;
  allowedMethods: readonly string[];
  maxRequestBytes: number;
  maxResponseBytes: number;
}): DeveloperModuleEgressPolicy {
  const methods = new Set(input.allowedMethods.map((method) => method.toUpperCase()));
  if (
    methods.size === 0 ||
    [...methods].some((method) => !['GET', 'HEAD', 'POST'].includes(method)) ||
    !positiveInteger(input.maxRequestBytes) ||
    !positiveInteger(input.maxResponseBytes)
  ) {
    throw new TypeError('DEVELOPER_VERIFICATION_EGRESS_CONFIG_INVALID');
  }
  return {
    async authorize(request) {
      let url: URL;
      try {
        url = new URL(request.url);
      } catch {
        deny();
      }
      const method = request.method.toUpperCase();
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.hostname === '' ||
        !methods.has(method) ||
        !Number.isSafeInteger(request.requestBytes) ||
        request.requestBytes < 0 ||
        request.requestBytes > input.maxRequestBytes
      ) {
        deny();
      }
      const declared = normalizeOrigins(request.declaredOrigins);
      const policy = normalizeOrigins(request.policyOrigins);
      if (!declared.has(url.origin) || !policy.has(url.origin)) deny();

      const hostname = normalizeHostname(url.hostname);
      let answers: readonly DeveloperResolvedAddress[];
      const directFamily = addressFamily(hostname);
      if (directFamily !== 0) {
        answers = [{ address: hostname, family: directFamily }];
      } else {
        try {
          answers = await input.resolve(hostname);
        } catch {
          deny();
        }
      }
      if (!Array.isArray(answers) || answers.length === 0 || answers.length > 16) deny();
      const normalized = answers.map((answer) => normalizeAddress(answer));
      if (normalized.some((answer) => !isPublicAddress(answer.address, answer.family))) deny();
      normalized.sort(
        (left, right) =>
          left.family - right.family ||
          (left.address < right.address ? -1 : left.address > right.address ? 1 : 0),
      );
      const selected = normalized[0];
      return {
        url: url.href,
        origin: url.origin,
        hostname,
        address: selected.address,
        family: selected.family,
        method,
        tlsServername: hostname,
        maxResponseBytes: input.maxResponseBytes,
      };
    },
  };
}

function deny(): never {
  throw new DeveloperVerificationEgressError();
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeOrigins(origins: readonly string[]): Set<string> {
  if (!Array.isArray(origins) || origins.length > 100) deny();
  const normalized = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      deny();
    }
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      deny();
    }
    normalized.add(url.origin);
  }
  return normalized;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function normalizeAddress(answer: DeveloperResolvedAddress): DeveloperResolvedAddress {
  if (!answer || (answer.family !== 4 && answer.family !== 6)) deny();
  const family = addressFamily(answer.address);
  if (family !== answer.family) deny();
  return { address: normalizeHostname(answer.address), family: answer.family };
}

function addressFamily(value: string): 0 | 4 | 6 {
  return parseIpv4(value) ? 4 : parseIpv6(value) ? 6 : 0;
}

function isPublicAddress(value: string, family: 4 | 6): boolean {
  if (family === 4) {
    const bytes = parseIpv4(value);
    return bytes !== null && isPublicIpv4(bytes);
  }
  const words = parseIpv6(value);
  return words !== null && isPublicIpv6(words);
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map((part) => {
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return -1;
    const number = Number(part);
    return number <= 255 ? number : -1;
  });
  return bytes.some((byte) => byte < 0) ? null : (bytes as [number, number, number, number]);
}

function isPublicIpv4([a, b, c]: [number, number, number, number]): boolean {
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(value: string): number[] | null {
  if (value.includes('%') || value.split('::').length > 2) return null;
  let normalized = value;
  const ipv4Match = /(?:^|:)([0-9]+(?:\.[0-9]+){3})$/.exec(value);
  if (ipv4Match) {
    const ipv4 = parseIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    normalized = `${value.slice(0, value.length - ipv4Match[1].length)}${(
      (ipv4[0] << 8) | ipv4[1]
    ).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = normalized.split('::');
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  if (
    left.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part)) ||
    right.some((part) => !/^[0-9a-fA-F]{1,4}$/.test(part))
  ) {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [
    ...left.map((part) => Number.parseInt(part, 16)),
    ...Array.from({ length: missing }, () => 0),
    ...right.map((part) => Number.parseInt(part, 16)),
  ];
}

function isPublicIpv6(words: number[]): boolean {
  if (words.length !== 8) return false;
  const [first, second] = words;
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  return !(
    allZero ||
    loopback ||
    mappedIpv4 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2001 && second === 0x0000) ||
    (first === 0x0064 && second === 0xff9b) ||
    first < 0x2000 ||
    first > 0x3fff
  );
}
