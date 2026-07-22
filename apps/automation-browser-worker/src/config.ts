import { isAbsolute } from 'node:path';
import { AUTOMATION_MAX_STEPS } from '@kortix/intelligence-contracts';

function positiveInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

export const browserWorkerConfig = Object.freeze({
  port: positiveInteger('AUTOMATION_BROWSER_PORT', 8091),
  maxSteps: AUTOMATION_MAX_STEPS,
  maxRuntimeMs: positiveInteger('AUTOMATION_BROWSER_MAX_RUNTIME_MS', 120_000),
  maxDownloads: positiveInteger('AUTOMATION_BROWSER_MAX_DOWNLOADS', 4),
  maxDownloadBytes: positiveInteger('AUTOMATION_BROWSER_MAX_DOWNLOAD_BYTES', 25 * 1024 * 1024),
  maxMemoryMb: positiveInteger('AUTOMATION_BROWSER_MAX_MEMORY_MB', 512),
  maxCpuSeconds: positiveInteger('AUTOMATION_BROWSER_MAX_CPU_SECONDS', 120),
});

export type BrowserWorkerHeartbeatConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      controlUrl: string;
      serviceId: string;
      certificateFingerprint256: string;
      sharedSecret: string;
      mtlsCertificatePath: string;
      mtlsPrivateKeyPath: string;
      mtlsCaPath: string;
      intervalMs: number;
      requestTimeoutMs: number;
    }>;

function boundedInteger(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a bounded integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a bounded integer`);
  }
  return value;
}

function requiredValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  maximum = 4_096,
): string {
  const value = environment[name]?.trim() ?? '';
  if (value.length === 0 || value.length > maximum) throw new Error(`${name} is required`);
  return value;
}

function requiredSecret(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name] ?? '';
  if (value.length < 32 || value.length > 4_096) {
    throw new Error(`${name} must contain between 32 and 4096 characters`);
  }
  return value;
}

export function loadBrowserWorkerHeartbeatConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BrowserWorkerHeartbeatConfig {
  const enabledText = environment.AUTOMATION_BROWSER_HEARTBEAT_ENABLED ?? 'false';
  if (enabledText !== 'true' && enabledText !== 'false') {
    throw new Error('AUTOMATION_BROWSER_HEARTBEAT_ENABLED must be true or false');
  }
  const enabled = enabledText === 'true';
  if (!enabled) return Object.freeze({ enabled: false });

  const controlUrlText = requiredValue(environment, 'AUTOMATION_CONTROL_URL', 2_048);
  let controlUrl: URL;
  try {
    controlUrl = new URL(controlUrlText);
  } catch {
    throw new Error('AUTOMATION_CONTROL_URL must be a valid HTTPS URL');
  }
  if (
    controlUrl.protocol !== 'https:' ||
    controlUrl.username !== '' ||
    controlUrl.password !== '' ||
    controlUrl.pathname !== '/' ||
    controlUrl.search !== '' ||
    controlUrl.hash !== ''
  ) {
    throw new Error('AUTOMATION_CONTROL_URL must be a valid HTTPS URL');
  }
  const serviceId = requiredValue(environment, 'AUTOMATION_BROWSER_SERVICE_ID', 128);
  if (!/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(serviceId)) {
    throw new Error('AUTOMATION_BROWSER_SERVICE_ID is invalid');
  }
  const certificateFingerprint256 = requiredValue(
    environment,
    'AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256',
    256,
  );
  if (/[\r\n]/.test(certificateFingerprint256)) {
    throw new Error('AUTOMATION_BROWSER_CERTIFICATE_FINGERPRINT256 is invalid');
  }
  const sharedSecret = requiredSecret(environment, 'AUTOMATION_BROWSER_WORKER_SHARED_SECRET');
  const mtlsCertificatePath = requiredValue(environment, 'AUTOMATION_BROWSER_MTLS_CERT_PATH');
  const mtlsPrivateKeyPath = requiredValue(environment, 'AUTOMATION_BROWSER_MTLS_KEY_PATH');
  const mtlsCaPath = requiredValue(environment, 'AUTOMATION_BROWSER_MTLS_CA_PATH');
  if (![mtlsCertificatePath, mtlsPrivateKeyPath, mtlsCaPath].every(isAbsolute)) {
    throw new Error('Browser Worker mTLS files must use absolute paths');
  }

  return Object.freeze({
    enabled: true,
    controlUrl: controlUrl.toString(),
    serviceId,
    certificateFingerprint256,
    sharedSecret,
    mtlsCertificatePath,
    mtlsPrivateKeyPath,
    mtlsCaPath,
    intervalMs: boundedInteger(
      environment,
      'AUTOMATION_BROWSER_HEARTBEAT_INTERVAL_MS',
      10_000,
      1_000,
      60_000,
    ),
    requestTimeoutMs: boundedInteger(
      environment,
      'AUTOMATION_BROWSER_HEARTBEAT_REQUEST_TIMEOUT_MS',
      5_000,
      100,
      30_000,
    ),
  });
}
