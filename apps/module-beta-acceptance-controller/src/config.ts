import { isAbsolute } from 'node:path';

export type ModuleBetaAcceptanceConfig =
  | { enabled: false; port: number }
  | {
      enabled: true;
      environment: 'staging';
      controllerIdentity: string;
      tokenFile: string;
      faultKeyFile: string;
      databaseUrlFile: string;
      planTtlSeconds: number;
      presignTtlSeconds: number;
      retentionProbeGraceMs: number;
      allowedPresignHosts: readonly string[];
      port: number;
      s3: {
        endpoint: string;
        region: string;
        bucket: string;
        serverSideEncryption: 'AES256';
        accessKeyIdFile: string;
        secretAccessKeyFile: string;
        forcePathStyle: boolean;
      };
    };

const DEPENDENCY_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/;

export function loadModuleBetaAcceptanceConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ModuleBetaAcceptanceConfig {
  const enabled = environment.MODULE_BETA_ACCEPTANCE_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') invalid();
  const port = environment.MODULE_BETA_ACCEPTANCE_PORT
    ? integer(environment.MODULE_BETA_ACCEPTANCE_PORT, 1, 65_535)
    : 8081;
  if (enabled !== 'true') return { enabled: false, port };

  try {
    const deploymentEnvironment = required(environment.MODULE_BETA_ACCEPTANCE_ENVIRONMENT);
    if (deploymentEnvironment !== 'staging') invalid();
    const controllerIdentity = match(
      environment.MODULE_BETA_ACCEPTANCE_IDENTITY,
      DEPENDENCY_IDENTITY,
    );
    const tokenFile = secretPath(environment.MODULE_BETA_ACCEPTANCE_TOKEN_FILE);
    const faultKeyFile = secretPath(environment.MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE);
    const databaseUrlFile = secretPath(environment.MODULE_BETA_ACCEPTANCE_DATABASE_URL_FILE);
    const endpoint = serviceUrl(environment.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT);
    const region = match(environment.MODULE_BETA_ACCEPTANCE_S3_REGION, /^[a-z0-9][a-z0-9-]{0,62}$/);
    const bucket = match(
      environment.MODULE_BETA_ACCEPTANCE_S3_BUCKET,
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    );
    const accessKeyIdFile = secretPath(environment.MODULE_BETA_ACCEPTANCE_S3_ACCESS_KEY_ID_FILE);
    const secretAccessKeyFile = secretPath(
      environment.MODULE_BETA_ACCEPTANCE_S3_SECRET_ACCESS_KEY_FILE,
    );
    const forcePathStyle = boolean(environment.MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE);
    const serverSideEncryption = required(
      environment.MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION,
    );
    if (serverSideEncryption !== 'AES256') invalid();
    const planTtlSeconds = integer(environment.MODULE_BETA_ACCEPTANCE_PLAN_TTL_SECONDS, 60, 900);
    const presignTtlSeconds = integer(
      environment.MODULE_BETA_ACCEPTANCE_PRESIGN_TTL_SECONDS,
      30,
      900,
    );
    const retentionProbeGraceMs = integer(
      environment.MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS,
      1_000,
      5 * 60_000,
    );
    const allowedPresignHostsValue = JSON.parse(
      bounded(environment.MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON, 4 * 1024),
    ) as unknown;
    if (
      !Array.isArray(allowedPresignHostsValue) ||
      allowedPresignHostsValue.length < 1 ||
      allowedPresignHostsValue.length > 32 ||
      allowedPresignHostsValue.some((host) => typeof host !== 'string' || !safePresignHost(host)) ||
      new Set(allowedPresignHostsValue).size !== allowedPresignHostsValue.length
    ) {
      invalid();
    }
    const allowedPresignHosts = [...(allowedPresignHostsValue as string[])].sort();
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== 'https:' || !allowedPresignHosts.includes(endpointUrl.hostname)) {
      invalid();
    }

    return {
      enabled: true,
      environment: deploymentEnvironment,
      controllerIdentity,
      tokenFile,
      faultKeyFile,
      databaseUrlFile,
      planTtlSeconds,
      presignTtlSeconds,
      retentionProbeGraceMs,
      allowedPresignHosts,
      port,
      s3: {
        endpoint,
        region,
        bucket,
        serverSideEncryption,
        accessKeyIdFile,
        secretAccessKeyFile,
        forcePathStyle,
      },
    };
  } catch {
    invalid();
  }
}

function bounded(value: string | undefined, maxBytes: number): string {
  if (!value || Buffer.byteLength(value, 'utf8') > maxBytes || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function required(value: string | undefined): string {
  return bounded(value, 4_096);
}

function match(value: string | undefined, pattern: RegExp): string {
  const result = required(value);
  if (!pattern.test(result)) invalid();
  return result;
}

function integer(value: string | undefined, minimum: number, maximum: number): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) invalid();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) invalid();
  return result;
}

function boolean(value: string | undefined): boolean {
  if (value !== 'true' && value !== 'false') invalid();
  return value === 'true';
}

function secretPath(value: string | undefined): string {
  const result = bounded(value, 1_024);
  if (!isAbsolute(result)) invalid();
  return result;
}

function serviceUrl(value: string | undefined): string {
  const url = new URL(bounded(value, 2_048));
  const privateHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      !url.hostname.includes('.') ||
      /^10\.|^192\.168\.|^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(url.hostname));
  if (
    (url.protocol !== 'https:' && !privateHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    /prod(?:uction)?/i.test(url.hostname)
  ) {
    invalid();
  }
  return url.href.replace(/\/$/, '');
}

function safePresignHost(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 253 ||
    value !== value.toLowerCase() ||
    value.includes(':') ||
    /prod(?:uction)?/i.test(value)
  ) {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value && url.pathname === '/' && url.port === '';
  } catch {
    return false;
  }
}

function invalid(): never {
  throw new Error('MODULE_BETA_ACCEPTANCE_CONFIG_INVALID');
}
