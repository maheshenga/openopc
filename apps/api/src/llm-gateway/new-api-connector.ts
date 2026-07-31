import { config } from '../config';

export type NewApiConnectorEnvironmentName = 'dev' | 'staging' | 'prod' | 'preview';

export interface NewApiConnectorEnvironment {
  NEWAPI_BASE_URL: string;
  NEWAPI_SERVICE_API_KEY: string;
  NEWAPI_API_COMPATIBILITY: 'openai-v1';
  INTERNAL_KORTIX_ENV: NewApiConnectorEnvironmentName;
}

export function normalizeNewApiBaseUrl(
  value: string,
  environment: NewApiConnectorEnvironmentName,
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('NEWAPI_BASE_URL is invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (environment !== 'dev' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('NEWAPI_BASE_URL is invalid');
  }

  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : `${path}/v1`;
  return url.toString().replace(/\/$/, '');
}

const runtimeBaseUrl = config.NEWAPI_BASE_URL
  ? normalizeNewApiBaseUrl(config.NEWAPI_BASE_URL, config.INTERNAL_KORTIX_ENV)
  : null;

export function newApiBaseUrl(environment?: NewApiConnectorEnvironment): string | null {
  if (!environment) return runtimeBaseUrl;
  return environment.NEWAPI_BASE_URL
    ? normalizeNewApiBaseUrl(environment.NEWAPI_BASE_URL, environment.INTERNAL_KORTIX_ENV)
    : null;
}

export function newApiConnectorConfigured(environment?: NewApiConnectorEnvironment): boolean {
  const target = environment ?? config;
  return Boolean(
    newApiBaseUrl(environment) &&
      target.NEWAPI_SERVICE_API_KEY &&
      target.NEWAPI_API_COMPATIBILITY === 'openai-v1',
  );
}
