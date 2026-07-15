import { z } from 'zod';

export interface StudioMemoryStorageConfig {
  mode: 'memory';
  namespace: string;
  ephemeral: true;
}

export interface StudioS3StorageConfig {
  mode: 's3';
  bucket: string;
  prefix: string;
  endpoint: URL;
  publicEndpoint: URL | null;
  region: string;
  forcePathStyle: boolean;
  expectedBucketOwner: string | null;
  credentialMode: 'default-chain' | 'static';
  accessKeyId: string | null;
  secretAccessKey: string | null;
  sessionToken: string | null;
  sse: 'AES256' | 'aws:kms';
  kmsKeyId: string | null;
}

export type StudioAdapterEnvironment =
  | { enabled: false }
  | {
      enabled: true;
      fakeProviderEnabled: boolean;
      openAiCompatibleEnabled: boolean;
      storage: StudioMemoryStorageConfig | StudioS3StorageConfig;
      privateProviderOrigins: readonly string[];
      allowInsecureLocalEndpoints: boolean;
    };

export class StudioAdapterConfigurationError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(`Invalid Studio adapter environment: ${fields.join(', ')}`);
    this.name = 'StudioAdapterConfigurationError';
  }
}

const BooleanStringSchema = z.enum(['true', 'false']);
const EnabledEnvironmentSchema = z
  .object({
    STUDIO_FAKE_PROVIDER_ENABLED: BooleanStringSchema.default('false'),
    STUDIO_OPENAI_COMPATIBLE_ENABLED: BooleanStringSchema.default('false'),
    STUDIO_OBJECT_STORE_MODE: z.enum(['memory', 's3']),
    STUDIO_ALLOW_EPHEMERAL_STORAGE: BooleanStringSchema.default('false'),
    STUDIO_OBJECT_STORE_BUCKET: z.string().trim().min(1).optional(),
    STUDIO_OBJECT_STORE_PREFIX: z.string().trim().min(1).optional(),
    STUDIO_S3_ENDPOINT: z.string().trim().min(1).optional(),
    STUDIO_S3_PUBLIC_ENDPOINT: z.string().trim().min(1).optional(),
    STUDIO_S3_REGION: z.string().trim().min(1).optional(),
    STUDIO_S3_FORCE_PATH_STYLE: BooleanStringSchema.default('false'),
    STUDIO_S3_EXPECTED_BUCKET_OWNER: z.string().trim().min(1).optional(),
    STUDIO_S3_CREDENTIAL_MODE: z.enum(['default-chain', 'static']).optional(),
    STUDIO_S3_ACCESS_KEY_ID: z.string().trim().min(1).optional(),
    STUDIO_S3_SECRET_ACCESS_KEY: z.string().trim().min(1).optional(),
    STUDIO_S3_SESSION_TOKEN: z.string().trim().min(1).optional(),
    STUDIO_S3_SSE: z.enum(['AES256', 'aws:kms']).optional(),
    STUDIO_S3_KMS_KEY_ID: z.string().trim().min(1).optional(),
    STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST: z.string().default(''),
    STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS: BooleanStringSchema.default('false'),
  })
  .passthrough();

export function parseStudioAdapterEnvironment(
  env: Record<string, string | undefined> = process.env,
  options: { test?: boolean } = {},
): StudioAdapterEnvironment {
  if (env.STUDIO_ENABLED === undefined || env.STUDIO_ENABLED === 'false') {
    return { enabled: false };
  }
  if (env.STUDIO_ENABLED !== 'true') {
    throw configurationError('STUDIO_ENABLED');
  }

  const parsedResult = EnabledEnvironmentSchema.safeParse(env);
  if (!parsedResult.success) {
    throw new StudioAdapterConfigurationError(
      uniqueFields(parsedResult.error.issues.map((issue) => String(issue.path[0]))),
    );
  }
  const parsed = parsedResult.data;
  const fakeProviderEnabled = parsed.STUDIO_FAKE_PROVIDER_ENABLED === 'true';
  const openAiCompatibleEnabled = parsed.STUDIO_OPENAI_COMPATIBLE_ENABLED === 'true';
  const allowEphemeralStorage = parsed.STUDIO_ALLOW_EPHEMERAL_STORAGE === 'true';
  const insecureRequested = parsed.STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS === 'true';
  const insecureAuthorized = options.test === true || allowEphemeralStorage;

  if (!fakeProviderEnabled && !openAiCompatibleEnabled) {
    throw configurationError('STUDIO_FAKE_PROVIDER_ENABLED', 'STUDIO_OPENAI_COMPATIBLE_ENABLED');
  }
  if (insecureRequested && !insecureAuthorized) {
    throw configurationError(
      'STUDIO_ALLOW_INSECURE_LOCAL_ENDPOINTS',
      ...(parsed.STUDIO_S3_ENDPOINT?.startsWith('http:') ? ['STUDIO_S3_ENDPOINT'] : []),
    );
  }

  const allowInsecureLocalEndpoints = insecureRequested && insecureAuthorized;
  const privateProviderOrigins = parseOriginAllowlist(
    parsed.STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST,
    allowInsecureLocalEndpoints,
  );

  if (parsed.STUDIO_OBJECT_STORE_MODE === 'memory') {
    if (!allowEphemeralStorage) {
      throw configurationError('STUDIO_ALLOW_EPHEMERAL_STORAGE');
    }
    if (openAiCompatibleEnabled && options.test !== true) {
      throw configurationError('STUDIO_OPENAI_COMPATIBLE_ENABLED', 'STUDIO_OBJECT_STORE_MODE');
    }
    return {
      enabled: true,
      fakeProviderEnabled,
      openAiCompatibleEnabled,
      storage: { mode: 'memory', namespace: 'studio-memory', ephemeral: true },
      privateProviderOrigins,
      allowInsecureLocalEndpoints,
    };
  }

  const requiredFields = [
    ['STUDIO_OBJECT_STORE_BUCKET', parsed.STUDIO_OBJECT_STORE_BUCKET],
    ['STUDIO_OBJECT_STORE_PREFIX', parsed.STUDIO_OBJECT_STORE_PREFIX],
    ['STUDIO_S3_ENDPOINT', parsed.STUDIO_S3_ENDPOINT],
    ['STUDIO_S3_REGION', parsed.STUDIO_S3_REGION],
    ['STUDIO_S3_CREDENTIAL_MODE', parsed.STUDIO_S3_CREDENTIAL_MODE],
    ['STUDIO_S3_SSE', parsed.STUDIO_S3_SSE],
  ] as const;
  const missingFields = requiredFields
    .filter(([, value]) => value === undefined)
    .map(([field]) => field);
  if (missingFields.length > 0) {
    throw new StudioAdapterConfigurationError(missingFields);
  }

  const credentialMode = parsed.STUDIO_S3_CREDENTIAL_MODE as 'default-chain' | 'static';
  if (credentialMode === 'static') {
    const missingCredentialFields = [
      parsed.STUDIO_S3_ACCESS_KEY_ID ? null : 'STUDIO_S3_ACCESS_KEY_ID',
      parsed.STUDIO_S3_SECRET_ACCESS_KEY ? null : 'STUDIO_S3_SECRET_ACCESS_KEY',
    ].filter((field): field is string => field !== null);
    if (missingCredentialFields.length > 0) {
      throw new StudioAdapterConfigurationError(missingCredentialFields);
    }
  } else {
    const conflictingCredentialFields = [
      parsed.STUDIO_S3_ACCESS_KEY_ID ? 'STUDIO_S3_ACCESS_KEY_ID' : null,
      parsed.STUDIO_S3_SECRET_ACCESS_KEY ? 'STUDIO_S3_SECRET_ACCESS_KEY' : null,
      parsed.STUDIO_S3_SESSION_TOKEN ? 'STUDIO_S3_SESSION_TOKEN' : null,
    ].filter((field): field is string => field !== null);
    if (conflictingCredentialFields.length > 0) {
      throw new StudioAdapterConfigurationError(conflictingCredentialFields);
    }
  }

  const sse = parsed.STUDIO_S3_SSE as 'AES256' | 'aws:kms';
  if (sse === 'aws:kms' && !parsed.STUDIO_S3_KMS_KEY_ID) {
    throw configurationError('STUDIO_S3_KMS_KEY_ID');
  }
  if (sse === 'AES256' && parsed.STUDIO_S3_KMS_KEY_ID) {
    throw configurationError('STUDIO_S3_KMS_KEY_ID', 'STUDIO_S3_SSE');
  }

  const endpoint = parseEndpoint(
    parsed.STUDIO_S3_ENDPOINT as string,
    'STUDIO_S3_ENDPOINT',
    allowInsecureLocalEndpoints,
  );
  const publicEndpoint = parsed.STUDIO_S3_PUBLIC_ENDPOINT
    ? parseEndpoint(
        parsed.STUDIO_S3_PUBLIC_ENDPOINT,
        'STUDIO_S3_PUBLIC_ENDPOINT',
        allowInsecureLocalEndpoints,
      )
    : null;

  return {
    enabled: true,
    fakeProviderEnabled,
    openAiCompatibleEnabled,
    storage: {
      mode: 's3',
      bucket: parsed.STUDIO_OBJECT_STORE_BUCKET as string,
      prefix: parsed.STUDIO_OBJECT_STORE_PREFIX as string,
      endpoint,
      publicEndpoint,
      region: parsed.STUDIO_S3_REGION as string,
      forcePathStyle: parsed.STUDIO_S3_FORCE_PATH_STYLE === 'true',
      expectedBucketOwner: parsed.STUDIO_S3_EXPECTED_BUCKET_OWNER ?? null,
      credentialMode,
      accessKeyId: credentialMode === 'static' ? (parsed.STUDIO_S3_ACCESS_KEY_ID ?? null) : null,
      secretAccessKey:
        credentialMode === 'static' ? (parsed.STUDIO_S3_SECRET_ACCESS_KEY ?? null) : null,
      sessionToken: credentialMode === 'static' ? (parsed.STUDIO_S3_SESSION_TOKEN ?? null) : null,
      sse,
      kmsKeyId: sse === 'aws:kms' ? (parsed.STUDIO_S3_KMS_KEY_ID ?? null) : null,
    },
    privateProviderOrigins,
    allowInsecureLocalEndpoints,
  };
}

function parseEndpoint(value: string, field: string, allowInsecure: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError(field);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    !['', '/'].includes(url.pathname) ||
    (url.protocol === 'http:' && !allowInsecure)
  ) {
    throw configurationError(field);
  }
  return url;
}

function parseOriginAllowlist(value: string, allowInsecure: boolean): readonly string[] {
  const origins: string[] = [];
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const url = parseEndpoint(entry, 'STUDIO_PROVIDER_PRIVATE_ORIGIN_ALLOWLIST', allowInsecure);
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return origins;
}

function configurationError(...fields: string[]): StudioAdapterConfigurationError {
  return new StudioAdapterConfigurationError(uniqueFields(fields));
}

function uniqueFields(fields: readonly string[]): string[] {
  return [...new Set(fields)];
}
