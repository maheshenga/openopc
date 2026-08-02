import { isIP } from 'node:net';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_BASE_DOMAIN_LENGTH = 214;

export interface ModuleAppHostConfiguration {
  readonly baseDomain: string;
  descriptorForRelease(releaseId: string): {
    url: string;
    origin: string;
  };
}

export function parseModuleAppHostConfiguration(
  value: string | undefined,
): ModuleAppHostConfiguration | null {
  if (
    !value ||
    value !== value.trim() ||
    value !== value.toLowerCase() ||
    value.length > MAX_BASE_DOMAIN_LENGTH ||
    isIP(value) !== 0
  ) {
    return null;
  }

  const labels = value.split('.');
  if (labels.length < 2 || labels.some((label) => !DNS_LABEL_RE.test(label))) {
    return null;
  }

  return Object.freeze({
    baseDomain: value,
    descriptorForRelease(releaseId: string) {
      if (!UUID_RE.test(releaseId)) throw new Error('INVALID_MODULE_RELEASE_ID');
      const origin = `https://r-${releaseId}.${value}`;
      return Object.freeze({ url: `${origin}/`, origin });
    },
  });
}

export function moduleAppHostReadiness(input: {
  renderingEnabled: boolean;
  configuration: ModuleAppHostConfiguration | null;
  internalServiceKey: string;
}): {
  ready: boolean;
  code: 'PROJECT_MODULE_HOST_UNAVAILABLE' | null;
} {
  const ready =
    !input.renderingEnabled ||
    (input.configuration !== null && input.internalServiceKey.length >= 16);
  return Object.freeze({
    ready,
    code: ready ? null : 'PROJECT_MODULE_HOST_UNAVAILABLE',
  });
}

export function combineModuleAppHostReadiness<T extends { ready: boolean }>(
  profile: T,
  host: ReturnType<typeof moduleAppHostReadiness>,
): T & {
  ready: boolean;
  module_app_host_ready: boolean;
} {
  return Object.freeze({
    ...profile,
    ready: profile.ready && host.ready,
    module_app_host_ready: host.ready,
  });
}
