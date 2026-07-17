import { StudioJobEventSchema } from '@kortix/api-contract';
import { canonicalStudioRequestHash } from '@kortix/studio-runtime';
import postgres from 'postgres';

const ENABLED = process.env.STUDIO_LIVE_PROVIDER_TESTS === 'true';
const CLEANUP_CONFIRMATION = 'DEDICATED_PROJECT_LIFECYCLE_CONFIRMED';

if (!ENABLED) {
  console.info('studio live provider smoke skipped: STUDIO_LIVE_PROVIDER_TESTS is not true');
} else {
  await main().catch(() => {
    console.error('studio live provider smoke failed (details redacted)');
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const input = {
    capability: 'image.generate' as const,
    image: {
      prompt: config.prompt,
      reference_asset_ids: [],
      aspect_ratio: '1:1' as const,
      quality: 'standard' as const,
      output_count: 1,
    },
  };
  const estimateRequest = {
    capability: input.capability,
    provider_config_id: config.providerConfigId,
    model: config.model,
    input,
  };
  const estimate = await requestJson(config, `/v1/projects/${config.projectId}/studio/estimates`, {
    method: 'POST',
    body: estimateRequest,
  });
  assertNumberAtMost(
    estimate.max_approved_credits,
    config.maxCredits,
    'estimate exceeds credit limit',
  );
  const idempotencyKey = `studio-live-smoke-${crypto.randomUUID()}`;
  const jobRequest = {
    ...estimateRequest,
    estimate_id: requiredString(estimate.estimate_id, 'estimate_id'),
    estimate_token: requiredString(estimate.estimate_token, 'estimate_token'),
    idempotency_key: idempotencyKey,
    request_hash: canonicalStudioRequestHash(estimateRequest),
  };
  const job = await requestJson(config, `/v1/projects/${config.projectId}/studio/jobs`, {
    method: 'POST',
    body: jobRequest,
  });
  const jobId = requiredString(job.job_id, 'job_id');
  assertEqual(job.provider_config_id, config.providerConfigId, 'job provider config mismatch');
  const jobInput = isRecord(job.input) ? job.input : null;
  const jobImage = jobInput && isRecord(jobInput.image) ? jobInput.image : null;
  assertEqual(jobImage?.output_count, 1, 'job output count is not one');

  const finished = await pollForCompletion(config, jobId);
  assertEqual(finished.status, 'succeeded', 'job did not succeed');
  assertNumber(finished.actual_credits, 'actual_credits');
  assertNumberAtMost(
    finished.actual_credits,
    config.maxCredits,
    'actual credits exceed credit limit',
  );

  const events = await requestJson(
    config,
    `/v1/projects/${config.projectId}/studio/jobs/${jobId}/events`,
  );
  const eventRows = requiredArray(events.items, 'events.items').map((event) =>
    StudioJobEventSchema.parse(event),
  );
  assertCount(eventRows, 'provider-submitted', 1);
  assertCount(eventRows, 'asset-created', 1);
  assertCount(eventRows, 'billing-settled', 1);
  const assetEvent = eventRows.find((event) => event?.type === 'asset-created');
  const assetId = requiredString(assetEvent?.payload?.asset_id, 'asset_id');
  const download = await requestJson(
    config,
    `/v1/projects/${config.projectId}/studio/assets/${assetId}/download-url`,
    { method: 'POST' },
  );
  const downloadUrl = new URL(requiredString(download.signed_download_url, 'signed_download_url'));
  assertSignedDownloadUrl(downloadUrl);
  const downloadResponse = await fetch(downloadUrl, {
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!downloadResponse.ok || (await downloadResponse.arrayBuffer()).byteLength === 0) {
    throw new Error('signed download assertion failed');
  }

  const sql = postgres(config.databaseUrl, { max: 1, connect_timeout: 10, prepare: false });
  try {
    const manifests = await sql<
      {
        staging_manifest_key: string | null;
        staging_manifest_checksum: string | null;
      }[]
    >`
      SELECT staging_manifest_key, staging_manifest_checksum
      FROM kortix.studio_job_attempts
      WHERE job_id = ${jobId}
      ORDER BY created_at ASC
    `;
    if (
      manifests.length !== 1 ||
      !manifests[0]?.staging_manifest_key ||
      !manifests[0]?.staging_manifest_checksum
    ) {
      throw new Error('expected exactly one persisted staging manifest');
    }
  } finally {
    await sql.end({ timeout: 5 });
  }

  // Signed URLs intentionally contain a credential/signature query. They are
  // checked separately and never copied into the log-safe API response scan.
  scanForSecrets([estimate, job, finished, events], config);
  // This smoke creates durable billing evidence. It never deletes it; a dedicated
  // project plus the documented lifecycle policy is the required cleanup boundary.
  console.info(
    'studio live provider smoke passed: one job, output, manifest, asset, and settlement',
  );
  console.info(
    'studio live provider smoke cleanup confirmed: dedicated-project lifecycle owns retained evidence',
  );
}

type Config = {
  apiUrl: URL;
  apiToken: string;
  projectId: string;
  providerConfigId: string;
  databaseUrl: string;
  model: string;
  prompt: string;
  maxCredits: number;
  timeoutMs: number;
};

function loadConfig(): Config {
  if (process.env.STUDIO_LIVE_PROVIDER_CONCURRENCY !== '1') {
    throw new Error('STUDIO_LIVE_PROVIDER_CONCURRENCY must be exactly 1');
  }
  if (process.env.STUDIO_LIVE_PROVIDER_CLEANUP_CONFIRMATION !== CLEANUP_CONFIRMATION) {
    throw new Error('dedicated-project cleanup confirmation is required');
  }
  const apiUrl = new URL(requiredEnvironment('STUDIO_LIVE_PROVIDER_API_URL'));
  if (
    apiUrl.protocol !== 'https:' ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error('live provider API URL must be a clean HTTPS origin');
  }
  const maxCredits = boundedInteger('STUDIO_LIVE_PROVIDER_MAX_CREDITS', 1, 5);
  const timeoutSeconds = boundedInteger('STUDIO_LIVE_PROVIDER_TIMEOUT_SECONDS', 1, 300);
  return {
    apiUrl,
    apiToken: requiredEnvironment('STUDIO_LIVE_PROVIDER_API_TOKEN'),
    projectId: uuidEnvironment('STUDIO_LIVE_PROVIDER_PROJECT_ID'),
    providerConfigId: uuidEnvironment('STUDIO_LIVE_PROVIDER_PROVIDER_CONFIG_ID'),
    databaseUrl: requiredEnvironment('STUDIO_LIVE_PROVIDER_DATABASE_URL'),
    model: requiredEnvironment('STUDIO_LIVE_PROVIDER_MODEL'),
    prompt: requiredEnvironment('STUDIO_LIVE_PROVIDER_PROMPT'),
    maxCredits,
    timeoutMs: timeoutSeconds * 1_000,
  };
}

async function requestJson(
  config: Config,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(path, config.apiUrl), {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw new Error(`Studio API returned ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error('Studio API response was not an object');
  return body;
}

async function pollForCompletion(config: Config, jobId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + config.timeoutMs;
  while (Date.now() < deadline) {
    const job = await requestJson(config, `/v1/projects/${config.projectId}/studio/jobs/${jobId}`);
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled')
      return job;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Studio job exceeded bounded smoke timeout');
}

function scanForSecrets(values: unknown[], config: Config): void {
  const serialized = JSON.stringify(values);
  if (
    serialized.includes(config.apiToken) ||
    serialized.includes(config.databaseUrl) ||
    /x-amz-(credential|signature|security-token)=/i.test(serialized)
  ) {
    throw new Error('live provider response failed secret redaction scan');
  }
}

function assertSignedDownloadUrl(url: URL): void {
  const signature =
    url.searchParams.get('X-Amz-Signature') ?? url.searchParams.get('x-amz-signature');
  const credential =
    url.searchParams.get('X-Amz-Credential') ?? url.searchParams.get('x-amz-credential');
  const expires = Number(
    url.searchParams.get('X-Amz-Expires') ?? url.searchParams.get('x-amz-expires') ?? Number.NaN,
  );
  if (
    url.protocol !== 'https:' ||
    !signature ||
    !credential ||
    !Number.isInteger(expires) ||
    expires < 60 ||
    expires > 900
  ) {
    throw new Error('signed download URL assertion failed');
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function uuidEnvironment(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} must be a UUID`);
  }
  return value;
}

function boundedInteger(name: string, min: number, max: number): number {
  const value = Number(requiredEnvironment(name));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function requiredArray(value: unknown, name: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error(`${name} must be an array`);
  return value;
}

function assertCount(events: Array<{ type: string }>, type: string, expected: number): void {
  if (events.filter((event) => event.type === type).length !== expected) {
    throw new Error(`expected ${expected} ${type} event`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}

function assertNumber(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${name} must be a number`);
}

function assertNumberAtMost(value: unknown, max: number, message: string): void {
  assertNumber(value, 'max_approved_credits');
  if ((value as number) > max) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
