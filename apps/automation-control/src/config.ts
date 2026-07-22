import { isAbsolute } from 'node:path';
import { z } from 'zod';

const ServiceIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/);
const BrowserWorkerTrustSchema = z.record(
  ServiceIdSchema,
  z
    .object({
      fingerprints: z
        .array(z.string().trim().min(1).max(256))
        .min(1)
        .max(16)
        .refine((values) => new Set(values).size === values.length),
      shared_secret: z.string().min(32).max(4_096),
    })
    .strict(),
);

type BrowserWorkerPeers = AutomationControlConfig['browserWorkerPeers'];

function parseBrowserWorkerTrust(raw: string): BrowserWorkerPeers | null {
  try {
    const parsed = BrowserWorkerTrustSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || Object.keys(parsed.data).length === 0) return null;
    return Object.freeze(
      Object.fromEntries(
        Object.entries(parsed.data).map(([serviceId, peer]) => [
          serviceId,
          Object.freeze({
            role: 'browser-worker' as const,
            fingerprints: Object.freeze([...peer.fingerprints]),
            sharedSecret: peer.shared_secret,
          }),
        ]),
      ),
    );
  } catch {
    return null;
  }
}

function parseBrowserWorkerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'wss:' ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== '/' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const AutomationControlEnvironmentSchema = z
  .object({
    AUTOMATION_CONTROL_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTOMATION_DESKTOP_COORDINATOR_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTOMATION_BROWSER_HEARTBEAT_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTOMATION_BROWSER_DISPATCH_ENABLED: z.enum(['true', 'false']).default('false'),
    AUTOMATION_CONTROL_PORT: z.coerce.number().int().min(1).max(65_535).default(4011),
    AUTOMATION_API_URL: z.string().url().default('http://localhost:8008'),
    DATABASE_URL: z.string().trim().default(''),
    REDIS_URL: z.string().trim().default(''),
    AUTOMATION_SERVICE_ID: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9._:-]*$/)
      .default('automation-control'),
    AUTOMATION_CONTROL_SHARED_SECRET: z.string().max(4_096).default(''),
    AUTOMATION_BROWSER_WORKER_TRUST_JSON: z.string().trim().default(''),
    AUTOMATION_WORKER_TLS_ATTESTATION_SECRET: z.string().max(4_096).default(''),
    AUTOMATION_WORKER_PROOF_SKEW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(60_000),
    AUTOMATION_WORKER_HEARTBEAT_MAX_BODY_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024)
      .default(64 * 1024),
    AUTOMATION_WORKER_HEARTBEAT_BODY_READ_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(5_000),
    AUTOMATION_BROWSER_WORKER_URL: z.string().trim().max(2_048).default(''),
    AUTOMATION_CONTROL_MTLS_CERT_PATH: z.string().trim().max(4_096).default(''),
    AUTOMATION_CONTROL_MTLS_KEY_PATH: z.string().trim().max(4_096).default(''),
    AUTOMATION_CONTROL_MTLS_CA_PATH: z.string().trim().max(4_096).default(''),
    AUTOMATION_BROWSER_DISPATCH_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(30_000)
      .default(5_000),
    AUTOMATION_BROWSER_DISPATCH_MAX_MESSAGE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(1024 * 1024)
      .default(64 * 1024),
    AUTOMATION_LEASE_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(5 * 60_000)
      .default(30_000),
    AUTOMATION_COORDINATOR_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1_000),
    AUTOMATION_COORDINATOR_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(4),
  })
  .superRefine((environment, context) => {
    if (
      environment.AUTOMATION_DESKTOP_COORDINATOR_ENABLED === 'true' &&
      environment.AUTOMATION_CONTROL_ENABLED !== 'true'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTOMATION_DESKTOP_COORDINATOR_ENABLED'],
        message: 'Desktop coordinator requires automation control to be enabled',
      });
    }
    if (
      environment.AUTOMATION_BROWSER_HEARTBEAT_ENABLED === 'true' &&
      environment.AUTOMATION_CONTROL_ENABLED !== 'true'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTOMATION_BROWSER_HEARTBEAT_ENABLED'],
        message: 'Browser Worker heartbeat requires automation control to be enabled',
      });
    }
    if (
      environment.AUTOMATION_BROWSER_DISPATCH_ENABLED === 'true' &&
      environment.AUTOMATION_BROWSER_HEARTBEAT_ENABLED !== 'true'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTOMATION_BROWSER_DISPATCH_ENABLED'],
        message: 'Browser Worker dispatch requires heartbeat to be enabled',
      });
    }
    if (environment.AUTOMATION_BROWSER_DISPATCH_ENABLED === 'true') {
      if (parseBrowserWorkerUrl(environment.AUTOMATION_BROWSER_WORKER_URL) === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTOMATION_BROWSER_WORKER_URL'],
          message: 'Browser Worker dispatch URL must be a WSS origin',
        });
      }
      for (const name of [
        'AUTOMATION_CONTROL_MTLS_CERT_PATH',
        'AUTOMATION_CONTROL_MTLS_KEY_PATH',
        'AUTOMATION_CONTROL_MTLS_CA_PATH',
      ] as const) {
        if (!isAbsolute(environment[name])) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: `${name} must be an absolute path`,
          });
        }
      }
    }
    if (environment.AUTOMATION_CONTROL_ENABLED !== 'true') return;

    if (!/^postgres(?:ql)?:\/\//.test(environment.DATABASE_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL must be a PostgreSQL URL when automation control is enabled',
      });
    }
    if (!/^rediss?:\/\//.test(environment.REDIS_URL)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'REDIS_URL must be a Redis URL when automation control is enabled',
      });
    }
    if (environment.AUTOMATION_CONTROL_SHARED_SECRET.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.too_small,
        type: 'string',
        minimum: 32,
        inclusive: true,
        path: ['AUTOMATION_CONTROL_SHARED_SECRET'],
        message: 'AUTOMATION_CONTROL_SHARED_SECRET must contain at least 32 characters',
      });
    }
    if (environment.AUTOMATION_BROWSER_HEARTBEAT_ENABLED === 'true') {
      if (parseBrowserWorkerTrust(environment.AUTOMATION_BROWSER_WORKER_TRUST_JSON) === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTOMATION_BROWSER_WORKER_TRUST_JSON'],
          message: 'Trusted Browser Worker configuration is required when heartbeat is enabled',
        });
      }
      if (environment.AUTOMATION_WORKER_TLS_ATTESTATION_SECRET.length < 32) {
        context.addIssue({
          code: z.ZodIssueCode.too_small,
          type: 'string',
          minimum: 32,
          inclusive: true,
          path: ['AUTOMATION_WORKER_TLS_ATTESTATION_SECRET'],
          message: 'Worker TLS attestation secret must contain at least 32 characters',
        });
      }
    }
  });

export type AutomationBrowserDispatchConfig =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      workerUrl: string;
      mtlsCertificatePath: string;
      mtlsPrivateKeyPath: string;
      mtlsCaPath: string;
      requestTimeoutMs: number;
      maxMessageBytes: number;
    }>;

export type AutomationControlConfig = Readonly<{
  enabled: boolean;
  desktopCoordinatorEnabled: boolean;
  browserHeartbeatEnabled: boolean;
  browserDispatch: AutomationBrowserDispatchConfig;
  port: number;
  automationApiUrl: string;
  databaseUrl: string;
  redisUrl: string;
  serviceId: string;
  sharedSecret: string;
  browserWorkerPeers: Readonly<
    Record<
      string,
      Readonly<{
        role: 'browser-worker';
        fingerprints: readonly string[];
        sharedSecret: string;
      }>
    >
  >;
  workerTlsAttestationSecret: string;
  workerProofSkewMs: number;
  workerHeartbeatMaxBodyBytes: number;
  workerHeartbeatBodyReadTimeoutMs: number;
  leaseMs: number;
  coordinatorPollMs: number;
  coordinatorBatchSize: number;
}>;

export function loadAutomationControlConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AutomationControlConfig {
  const parsed = AutomationControlEnvironmentSchema.parse(environment);
  const browserHeartbeatEnabled = parsed.AUTOMATION_BROWSER_HEARTBEAT_ENABLED === 'true';
  const browserDispatchEnabled = parsed.AUTOMATION_BROWSER_DISPATCH_ENABLED === 'true';
  const browserWorkerPeers = browserHeartbeatEnabled
    ? parseBrowserWorkerTrust(parsed.AUTOMATION_BROWSER_WORKER_TRUST_JSON)
    : Object.freeze({});
  if (browserHeartbeatEnabled && browserWorkerPeers === null) {
    throw new Error('Trusted Browser Worker configuration is invalid');
  }
  const workerUrl = browserDispatchEnabled
    ? parseBrowserWorkerUrl(parsed.AUTOMATION_BROWSER_WORKER_URL)
    : null;
  if (browserDispatchEnabled && workerUrl === null) {
    throw new Error('Browser Worker dispatch URL is invalid');
  }
  const browserDispatch: AutomationBrowserDispatchConfig = browserDispatchEnabled
    ? Object.freeze({
        enabled: true,
        workerUrl: workerUrl as string,
        mtlsCertificatePath: parsed.AUTOMATION_CONTROL_MTLS_CERT_PATH,
        mtlsPrivateKeyPath: parsed.AUTOMATION_CONTROL_MTLS_KEY_PATH,
        mtlsCaPath: parsed.AUTOMATION_CONTROL_MTLS_CA_PATH,
        requestTimeoutMs: parsed.AUTOMATION_BROWSER_DISPATCH_TIMEOUT_MS,
        maxMessageBytes: parsed.AUTOMATION_BROWSER_DISPATCH_MAX_MESSAGE_BYTES,
      })
    : Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: parsed.AUTOMATION_CONTROL_ENABLED === 'true',
    desktopCoordinatorEnabled: parsed.AUTOMATION_DESKTOP_COORDINATOR_ENABLED === 'true',
    browserHeartbeatEnabled,
    browserDispatch,
    port: parsed.AUTOMATION_CONTROL_PORT,
    automationApiUrl: parsed.AUTOMATION_API_URL,
    databaseUrl: parsed.DATABASE_URL,
    redisUrl: parsed.REDIS_URL,
    serviceId: parsed.AUTOMATION_SERVICE_ID,
    sharedSecret: parsed.AUTOMATION_CONTROL_SHARED_SECRET,
    browserWorkerPeers: browserWorkerPeers ?? Object.freeze({}),
    workerTlsAttestationSecret: parsed.AUTOMATION_WORKER_TLS_ATTESTATION_SECRET,
    workerProofSkewMs: parsed.AUTOMATION_WORKER_PROOF_SKEW_MS,
    workerHeartbeatMaxBodyBytes: parsed.AUTOMATION_WORKER_HEARTBEAT_MAX_BODY_BYTES,
    workerHeartbeatBodyReadTimeoutMs: parsed.AUTOMATION_WORKER_HEARTBEAT_BODY_READ_TIMEOUT_MS,
    leaseMs: parsed.AUTOMATION_LEASE_MS,
    coordinatorPollMs: parsed.AUTOMATION_COORDINATOR_POLL_MS,
    coordinatorBatchSize: parsed.AUTOMATION_COORDINATOR_BATCH_SIZE,
  });
}
