import ipaddr from 'ipaddr.js';

export interface StudioResolvedAddress {
  address: string;
  family: 4 | 6;
}

export class StudioNetworkPolicyError extends Error {
  readonly code = 'STUDIO_NETWORK_POLICY';

  constructor(message = 'Studio network policy rejected the request') {
    super(message);
    this.name = 'StudioNetworkPolicyError';
  }
}

export async function validateStudioOrigin(input: {
  url: URL;
  resolve: (hostname: string) => Promise<readonly StudioResolvedAddress[]>;
  allowPrivateOrigins: ReadonlySet<string>;
  allowInsecureLocalEndpoints: boolean;
}): Promise<readonly StudioResolvedAddress[]> {
  assertSafeUrlShape(input.url, input.allowInsecureLocalEndpoints);

  const hostname = normalizedHostname(input.url);
  if (
    (hostname === 'localhost' || hostname.endsWith('.localhost')) &&
    !input.allowInsecureLocalEndpoints
  ) {
    throw new StudioNetworkPolicyError();
  }

  const directAddress = parseAddress(hostname);
  let answers: readonly StudioResolvedAddress[];
  if (directAddress) {
    answers = [
      {
        address: directAddress.toString(),
        family: directAddress.kind() === 'ipv4' ? 4 : 6,
      },
    ];
  } else {
    try {
      answers = await input.resolve(hostname);
    } catch {
      throw new StudioNetworkPolicyError('Studio origin resolution failed');
    }
  }

  if (answers.length === 0) {
    throw new StudioNetworkPolicyError('Studio origin resolved to no addresses');
  }

  const privateOriginAllowed = input.allowPrivateOrigins.has(input.url.origin);
  for (const answer of answers) {
    const parsed = parseAddress(answer.address);
    if (!parsed) throw new StudioNetworkPolicyError();
    const actualFamily = parsed.kind() === 'ipv4' ? 4 : 6;
    if (actualFamily !== answer.family) throw new StudioNetworkPolicyError();

    const range = parsed.range();
    const isPublicUnicast = range === 'unicast';
    const isAllowlistEligiblePrivate =
      (parsed.kind() === 'ipv4' && range === 'private') ||
      (parsed.kind() === 'ipv6' && range === 'uniqueLocal');
    const isAuthorizedLoopback = input.allowInsecureLocalEndpoints && range === 'loopback';
    if (
      !isPublicUnicast &&
      !isAuthorizedLoopback &&
      !(privateOriginAllowed && isAllowlistEligiblePrivate)
    ) {
      throw new StudioNetworkPolicyError();
    }
  }

  return answers.map((answer) => ({ ...answer }));
}

function assertSafeUrlShape(url: URL, allowInsecure: boolean): void {
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !allowInsecure) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname === ''
  ) {
    throw new StudioNetworkPolicyError();
  }
}

function normalizedHostname(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function parseAddress(value: string): ipaddr.IPv4 | ipaddr.IPv6 | null {
  try {
    return ipaddr.parse(value);
  } catch {
    return null;
  }
}
