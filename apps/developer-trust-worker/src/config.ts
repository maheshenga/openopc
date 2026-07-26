import { isAbsolute } from 'node:path';

export type DeveloperTrustEnvironment = 'development' | 'test' | 'staging';

export interface DeveloperTrustWorkerDisabledConfig {
  enabled: false;
  workerId: 'developer-trust-disabled';
  leaseMs: 30_000;
  pollMs: 1_000;
}

export interface DeveloperTrustWorkerEnabledConfig {
  enabled: true;
  environment: DeveloperTrustEnvironment;
  workerId: string;
  leaseMs: number;
  pollMs: number;
  policyJson: string;
  databaseUrlFile: string;
  workspaceRoot: string;
  maxArtifactBytes: number;
  semgrepRulesFile: string;
  s3: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyIdFile: string;
    secretAccessKeyFile: string;
    forcePathStyle: boolean;
  };
  attestation: {
    privateKeyFile: string;
    publicKeyFile: string;
    keyId: string;
    issuer: string;
  };
  wasmtime: {
    executable: string;
    expectedDigest: `sha256:${string}`;
    expectedVersion: string;
  };
  oci: {
    controlEndpoint: string;
    controlTokenFile: string;
    verificationBrokerUrl: string;
  };
  acceptance:
    | { enabled: false }
    | {
        enabled: true;
        keyFile: string;
        controllerIdentity: string;
      };
  allowedLicenses: readonly string[];
}

export type DeveloperTrustWorkerConfig =
  | DeveloperTrustWorkerDisabledConfig
  | DeveloperTrustWorkerEnabledConfig;

export function loadDeveloperTrustWorkerConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DeveloperTrustWorkerConfig {
  const enabledValue = environment.DEVELOPER_TRUST_ENABLED;
  if (enabledValue !== undefined && enabledValue !== 'true' && enabledValue !== 'false') {
    invalid();
  }
  if (enabledValue !== 'true') {
    return {
      enabled: false,
      workerId: 'developer-trust-disabled',
      leaseMs: 30_000,
      pollMs: 1_000,
    };
  }

  try {
    const deploymentEnvironment = requiredEnvironment(environment.DEVELOPER_TRUST_ENVIRONMENT);
    const workerId = requiredMatch(
      environment.DEVELOPER_TRUST_WORKER_ID,
      /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/,
    );
    const leaseMs = boundedInteger(environment.DEVELOPER_TRUST_LEASE_MS, 5_000, 300_000);
    const pollMs = boundedInteger(environment.DEVELOPER_TRUST_POLL_MS, 100, 60_000);
    const policyJson = requiredBounded(environment.DEVELOPER_TRUST_POLICY_JSON, 1024 * 1024);
    const policy = JSON.parse(policyJson) as unknown;
    if (!record(policy) || policy.schema !== 1) invalid();
    const databaseUrlFile = secretPath(environment.DEVELOPER_TRUST_DATABASE_URL_FILE);
    const workspaceRoot = absolutePath(environment.DEVELOPER_TRUST_WORKSPACE_ROOT);
    const maxArtifactBytes = environment.DEVELOPER_TRUST_MAX_ARTIFACT_BYTES
      ? boundedInteger(environment.DEVELOPER_TRUST_MAX_ARTIFACT_BYTES, 1, 512 * 1024 * 1024)
      : 512 * 1024 * 1024;
    const semgrepRulesFile = absolutePath(environment.DEVELOPER_TRUST_SEMGREP_RULES_FILE);
    const forcePathStyle = requiredBoolean(environment.DEVELOPER_TRUST_S3_FORCE_PATH_STYLE);
    const endpoint = serviceUrl(environment.DEVELOPER_TRUST_S3_ENDPOINT);
    const region = requiredMatch(
      environment.DEVELOPER_TRUST_S3_REGION,
      /^[a-z0-9][a-z0-9-]{0,62}$/,
    );
    const bucket = requiredMatch(
      environment.DEVELOPER_TRUST_S3_BUCKET,
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
    );
    const accessKeyIdFile = secretPath(environment.DEVELOPER_TRUST_S3_ACCESS_KEY_ID_FILE);
    const secretAccessKeyFile = secretPath(environment.DEVELOPER_TRUST_S3_SECRET_ACCESS_KEY_FILE);
    const privateKeyFile = secretPath(environment.DEVELOPER_TRUST_ATTESTATION_PRIVATE_KEY_FILE);
    const publicKeyFile = secretPath(environment.DEVELOPER_TRUST_ATTESTATION_PUBLIC_KEY_FILE);
    const keyId = requiredMatch(
      environment.DEVELOPER_TRUST_ATTESTATION_KEY_ID,
      new RegExp(`^openopc-attestation-${deploymentEnvironment}-[A-Za-z0-9._:-]{1,128}$`),
    );
    const issuer = requiredMatch(
      environment.DEVELOPER_TRUST_ATTESTATION_ISSUER,
      /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/,
    );
    const executable = absolutePath(environment.DEVELOPER_TRUST_WASMTIME_EXECUTABLE);
    const expectedDigest = requiredMatch(
      environment.DEVELOPER_TRUST_WASMTIME_DIGEST,
      /^sha256:[0-9a-f]{64}$/,
    ) as `sha256:${string}`;
    const expectedVersion = requiredMatch(
      environment.DEVELOPER_TRUST_WASMTIME_VERSION,
      /^wasmtime (?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*) \([0-9a-f]{7,40} [0-9]{4}-[0-9]{2}-[0-9]{2}\)$/,
    );
    const controlEndpoint = serviceUrl(environment.DEVELOPER_TRUST_OCI_CONTROL_ENDPOINT);
    const controlTokenFile = secretPath(environment.DEVELOPER_TRUST_OCI_CONTROL_TOKEN_FILE);
    const verificationBrokerUrl = serviceUrl(environment.DEVELOPER_TRUST_VERIFICATION_BROKER_URL);
    const acceptanceEnabled = environment.MODULE_BETA_ACCEPTANCE_WORKER_ENABLED;
    if (
      acceptanceEnabled !== undefined &&
      acceptanceEnabled !== 'true' &&
      acceptanceEnabled !== 'false'
    ) {
      invalid();
    }
    const acceptance =
      acceptanceEnabled === 'true'
        ? {
            enabled: true as const,
            keyFile: secretPath(environment.MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE),
            controllerIdentity: requiredMatch(
              environment.MODULE_BETA_ACCEPTANCE_CONTROLLER_IDENTITY,
              /^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,127}#sha256:[0-9a-f]{64}$/,
            ),
          }
        : { enabled: false as const };
    if (acceptance.enabled && deploymentEnvironment === 'development') invalid();
    const allowedLicensesValue = JSON.parse(
      requiredBounded(environment.DEVELOPER_TRUST_ALLOWED_LICENSES_JSON, 16 * 1024),
    ) as unknown;
    if (
      !Array.isArray(allowedLicensesValue) ||
      allowedLicensesValue.length < 1 ||
      allowedLicensesValue.length > 256 ||
      allowedLicensesValue.some(
        (license) =>
          typeof license !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/.test(license),
      )
    ) {
      invalid();
    }
    const allowedLicenses = [...new Set(allowedLicensesValue as string[])].sort();
    if (allowedLicenses.length !== allowedLicensesValue.length) invalid();

    return {
      enabled: true,
      environment: deploymentEnvironment,
      workerId,
      leaseMs,
      pollMs,
      policyJson,
      databaseUrlFile,
      workspaceRoot,
      maxArtifactBytes,
      semgrepRulesFile,
      s3: {
        endpoint,
        region,
        bucket,
        accessKeyIdFile,
        secretAccessKeyFile,
        forcePathStyle,
      },
      attestation: { privateKeyFile, publicKeyFile, keyId, issuer },
      wasmtime: { executable, expectedDigest, expectedVersion },
      oci: { controlEndpoint, controlTokenFile, verificationBrokerUrl },
      acceptance,
      allowedLicenses,
    };
  } catch {
    invalid();
  }
}

function requiredEnvironment(value: string | undefined): DeveloperTrustEnvironment {
  if (value !== 'development' && value !== 'test' && value !== 'staging') invalid();
  return value;
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number): number {
  if (!value || !/^(?:0|[1-9][0-9]*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) invalid();
  return parsed;
}

function requiredBoolean(value: string | undefined): boolean {
  if (value !== 'true' && value !== 'false') invalid();
  return value === 'true';
}

function requiredBounded(value: string | undefined, maxBytes: number): string {
  if (!value || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) invalid();
  return value;
}

function requiredMatch(value: string | undefined, pattern: RegExp): string {
  const bounded = requiredBounded(value, 4_096);
  if (!pattern.test(bounded)) invalid();
  return bounded;
}

function absolutePath(value: string | undefined): string {
  const path = requiredBounded(value, 1_024);
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) invalid();
  return path;
}

function secretPath(value: string | undefined): string {
  return absolutePath(value);
}

function serviceUrl(value: string | undefined): string {
  const raw = requiredBounded(value, 2_048);
  const url = new URL(raw);
  const privateHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      !url.hostname.includes('.') ||
      /^10\.|^192\.168\.|^172\.(?:1[6-9]|2[0-9]|3[01])\./.test(url.hostname));
  if (
    (url.protocol !== 'https:' && !privateHttp) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    invalid();
  }
  return url.href.replace(/\/$/, '');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid(): never {
  throw new Error('DEVELOPER_TRUST_CONFIG_INVALID');
}
