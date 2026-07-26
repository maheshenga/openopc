import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadModuleBetaAcceptanceConfig } from '../../apps/module-beta-acceptance-controller/src/config';

interface ComposeService {
  build?: { context?: string; dockerfile?: string; target?: string };
  cap_drop?: string[];
  command?: string | string[];
  depends_on?: Record<string, unknown>;
  environment?: Record<string, unknown> | string[];
  networks?: string[] | Record<string, unknown>;
  ports?: unknown;
  read_only?: boolean;
  security_opt?: string[];
  tmpfs?: string[];
  user?: string;
  volumes?: string[];
}

interface ComposeDocument {
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
}

const composePath = fileURLToPath(new URL('./trust.compose.yml', import.meta.url));
const fixtureScriptPath = fileURLToPath(
  new URL(
    '../../apps/developer-trust-worker/scripts/trust-acceptance-fixtures.ts',
    import.meta.url,
  ),
);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function loadCompose(): ComposeDocument {
  return Bun.YAML.parse(readFileSync(composePath, 'utf8')) as ComposeDocument;
}

function service(document: ComposeDocument, name: string): ComposeService {
  const value = document.services[name];
  if (!value) throw new Error(`missing Compose service: ${name}`);
  return value;
}

function environment(value: ComposeService): Record<string, string> {
  if (Array.isArray(value.environment)) {
    return Object.fromEntries(
      value.environment.map((entry) => {
        const separator = entry.indexOf('=');
        return separator === -1
          ? [entry, '']
          : [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(value.environment ?? {}).map(([name, entry]) => [name, String(entry ?? '')]),
  );
}

function interpolate(value: string, overrides: Readonly<Record<string, string>>): string {
  const match = /^\$\{([A-Z0-9_]+):-([\s\S]*)\}$/.exec(value);
  if (!match) return value;
  const name = match[1];
  const fallback = match[2];
  if (name === undefined || fallback === undefined) {
    throw new Error(`invalid Compose interpolation: ${value}`);
  }
  return overrides[name] ?? fallback;
}

function interpolationDefault(value: string): string {
  return interpolate(value, {});
}

function resolvedEnvironment(
  value: ComposeService,
  overrides: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment(value)).map(([name, entry]) => [
      name,
      interpolate(entry, overrides),
    ]),
  );
}

function commandText(value: ComposeService): string {
  if (typeof value.command === 'string') return value.command;
  return value.command?.at(-1) ?? '';
}

function requiredEnvironmentValue(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined) throw new Error(`missing environment value: ${name}`);
  return value;
}

function networks(value: ComposeService): string[] {
  return Array.isArray(value.networks) ? value.networks : Object.keys(value.networks ?? {});
}

function initializeSecrets(): string {
  const directory = mkdtempSync(join(tmpdir(), 'openopc-trust-secrets-'));
  temporaryDirectories.push(directory);
  execFileSync(process.execPath, ['run', fixtureScriptPath, '--init-secrets', directory], {
    stdio: 'pipe',
  });
  return directory;
}

describe('developer trust acceptance deployment policy', () => {
  test('generates distinct raw HMAC and base64url token secrets with locked metadata', () => {
    const first = initializeSecrets();
    const second = initializeSecrets();
    const firstHmac = readFileSync(join(first, 'acceptance-hmac'));
    const secondHmac = readFileSync(join(second, 'acceptance-hmac'));
    const firstToken = readFileSync(join(first, 'acceptance-token'), 'utf8');
    const secondToken = readFileSync(join(second, 'acceptance-token'), 'utf8');

    expect(firstHmac).toHaveLength(32);
    expect(secondHmac).toHaveLength(32);
    expect(firstHmac.equals(secondHmac)).toBe(false);
    expect(firstToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secondToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(firstToken, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(Buffer.from(secondToken, 'base64url').byteLength).toBeGreaterThanOrEqual(32);
    expect(firstToken).not.toBe(secondToken);

    for (const path of [join(first, 'acceptance-hmac'), join(first, 'acceptance-token')]) {
      const metadata = statSync(path);
      expect(metadata.mode & 0o222).toBe(0);
      if (process.platform !== 'win32') {
        expect(metadata.mode & 0o777).toBe(0o400);
        expect(metadata.uid).toBe(65_532);
        expect(metadata.gid).toBe(65_532);
      }
    }
  });

  test('bootstraps upload lifecycle and bounded SBOM evidence coordinates', () => {
    const postgresInit = service(loadCompose(), 'postgres-init');
    const sql = commandText(postgresInit).replace(/\s+/g, ' ');

    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS kortix\.developer_module_artifact_uploads\s*\(/i,
    );
    expect(sql).toMatch(/CREATE TYPE kortix\.developer_artifact_upload_state AS ENUM/i);
    expect(sql).toMatch(/upload_id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(sql).toMatch(/publisher_id varchar\(63\) NOT NULL/i);
    expect(sql).toMatch(
      /state kortix\.developer_artifact_upload_state NOT NULL DEFAULT 'created'/i,
    );
    expect(sql).toMatch(/expected_digest varchar\(71\) NOT NULL/i);
    expect(sql).toMatch(/expected_size bigint NOT NULL/i);
    expect(sql).toMatch(/staging_storage_key text NOT NULL/i);
    expect(sql).toMatch(/artifact_id uuid/i);
    expect(sql).toMatch(/expires_at timestamptz NOT NULL/i);
    expect(sql).toMatch(/created_by uuid NOT NULL/i);
    expect(sql).toMatch(/created_at timestamptz NOT NULL DEFAULT now\(\)/i);
    expect(sql).toMatch(/updated_at timestamptz NOT NULL DEFAULT now\(\)/i);
    expect(sql).toContain('developer_module_artifact_uploads_digest_check');
    expect(sql).toContain('expected_size BETWEEN 1 AND 536870912');
    expect(sql).toContain('octet_length(staging_storage_key) BETWEEN 1 AND 2048');
    expect(sql).toContain("state = 'finalized' AND artifact_id IS NOT NULL");

    expect(sql).toMatch(/sbom_storage_key text/i);
    expect(sql).toMatch(/sbom_size_bytes bigint/i);
    expect(sql).toMatch(
      /ALTER TABLE kortix\.developer_module_verification_runs ADD COLUMN IF NOT EXISTS sbom_storage_key text, ADD COLUMN IF NOT EXISTS sbom_size_bytes bigint/i,
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS developer_module_verification_runs_sbom_reference_check',
    );
    expect(sql).toContain(
      'DROP CONSTRAINT IF EXISTS developer_module_verification_runs_passed_evidence_check',
    );
    expect(sql).toContain('developer_module_verification_runs_sbom_reference_check');
    expect(sql).toContain('sbom_storage_key IS NULL AND sbom_size_bytes IS NULL');
    expect(sql).toContain('octet_length(sbom_storage_key) BETWEEN 1 AND 2048');
    expect(sql).toContain("sbom_storage_key !~ '[[:cntrl:]]'");
    expect(sql).toContain("sbom_storage_key NOT LIKE '/%'");
    expect(sql).toContain("NOT ('..' = ANY(string_to_array(sbom_storage_key, '/')))");
    expect(sql).toContain('sbom_size_bytes BETWEEN 1 AND 16777216');
    expect(sql).toContain('developer_module_verification_runs_passed_evidence_check');

    expect(postgresInit.volumes).toContain(
      '../../packages/db/migrations/20260726150000000_developer_artifact_retention.sql:/migrations/20260726150000000_developer_artifact_retention.sql:ro',
    );
    expect(sql).toContain('CREATE ROLE anon NOLOGIN');
    expect(sql).toContain('CREATE ROLE authenticated NOLOGIN');
    expect(sql).toContain('CREATE ROLE service_role NOLOGIN');
    expect(sql).toContain('CREATE ROLE developer_trust_worker NOLOGIN');
    expect(sql).toMatch(
      /psql .* -v ON_ERROR_STOP=1 -f \/migrations\/20260726150000000_developer_artifact_retention\.sql/i,
    );
  });

  test('wires the worker acceptance channel through the exact disabled-by-default config names', () => {
    const worker = service(loadCompose(), 'trust-worker');
    const workerEnvironment = environment(worker);

    expect(
      interpolationDefault(
        requiredEnvironmentValue(workerEnvironment, 'MODULE_BETA_ACCEPTANCE_WORKER_ENABLED'),
      ),
    ).toBe('false');
    expect(workerEnvironment.MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE).toBe(
      '/run/openopc-secrets/acceptance-hmac',
    );
    expect(workerEnvironment.MODULE_BETA_ACCEPTANCE_CONTROLLER_IDENTITY).toBe(
      '${MODULE_BETA_ACCEPTANCE_CONTROLLER_IDENTITY:-}',
    );
    expect(worker.volumes).toContain('trust-secrets:/run/openopc-secrets:ro');
  });

  test('isolates the controller and leaves private TLS configuration operator-supplied', () => {
    const document = loadCompose();
    const controller = service(document, 'module-beta-acceptance-controller');
    const controllerEnvironment = environment(controller);
    const controllerDefaults = resolvedEnvironment(controller);
    const workerEnvironment = environment(service(document, 'trust-worker'));

    expect(controller.build).toEqual({
      context: '../..',
      dockerfile: 'apps/module-beta-acceptance-controller/Dockerfile',
      target: 'runtime',
    });
    expect(controller.ports).toBeUndefined();
    expect(networks(controller)).toEqual(['trust-private']);
    expect(document.networks['trust-private']?.internal).toBe(true);
    expect(controller.user).toBe('65532:65532');
    expect(Object.keys(controller.depends_on ?? {}).sort()).toEqual([
      'postgres-init',
      'trust-secrets',
    ]);
    expect(controller.read_only).toBe(true);
    expect(controller.cap_drop).toEqual(['ALL']);
    expect(controller.security_opt).toContain('no-new-privileges:true');
    expect(controller.volumes).toContain('trust-secrets:/run/openopc-secrets:ro');
    expect(controller.tmpfs).toContain('/tmp/openopc-controller:uid=65532,gid=65532,mode=0700');

    const enableFlags = Object.entries(controllerDefaults).filter(([name]) =>
      name.endsWith('_ENABLED'),
    );
    expect(enableFlags.length).toBeGreaterThan(0);
    expect(enableFlags.every(([, value]) => value === 'false')).toBe(true);
    expect(controllerDefaults.MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE).toBe('true');
    expect(controllerDefaults.MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION).toBe('AES256');
    expect(controllerDefaults.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT).toBe('');
    expect(controllerDefaults.MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON).toBe('[]');
    expect(controllerDefaults.MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS).toBe('5000');
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS).toBe(
      '${OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ORPHAN_GRACE_MS:-5000}',
    );
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_IDENTITY).toBe(
      workerEnvironment.MODULE_BETA_ACCEPTANCE_CONTROLLER_IDENTITY,
    );
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE).toBe(
      workerEnvironment.MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE,
    );
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_TOKEN_FILE).toBe(
      '/run/openopc-secrets/acceptance-token',
    );
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT).not.toContain('minio:9000');
    expect(controllerEnvironment.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT).not.toContain('https://minio');
    expect(
      interpolationDefault(
        requiredEnvironmentValue(workerEnvironment, 'DEVELOPER_TRUST_S3_ENDPOINT'),
      ),
    ).toBe('http://minio:9000');
    expect(loadModuleBetaAcceptanceConfig(controllerDefaults)).toEqual({
      enabled: false,
      port: 8081,
    });
  });

  test('resolves an operator TLS S3 override identically for every acceptance consumer', () => {
    const document = loadCompose();
    const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'c'.repeat(64)}`;
    const overrides = {
      MODULE_BETA_ACCEPTANCE_ENABLED: 'true',
      MODULE_BETA_ACCEPTANCE_WORKER_ENABLED: 'true',
      MODULE_BETA_ACCEPTANCE_CONTROLLER_IDENTITY: controllerIdentity,
      MODULE_BETA_ACCEPTANCE_S3_ENDPOINT: 'https://s3.staging.private.example',
      MODULE_BETA_ACCEPTANCE_S3_REGION: 'us-west-2',
      MODULE_BETA_ACCEPTANCE_S3_BUCKET: 'openopc-staging-artifacts',
      MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE: 'false',
      MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON: JSON.stringify([
        's3.staging.private.example',
      ]),
      OPENOPC_DEVELOPER_ARTIFACT_RETENTION_ORPHAN_GRACE_MS: '7000',
    };
    const controller = resolvedEnvironment(
      service(document, 'module-beta-acceptance-controller'),
      overrides,
    );
    const worker = resolvedEnvironment(service(document, 'trust-worker'), overrides);
    const integration = resolvedEnvironment(service(document, 'trust-acceptance'), overrides);

    expect(controller.MODULE_BETA_ACCEPTANCE_ENABLED).toBe('true');
    expect(controller.MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS).toBe('7000');
    expect(worker.MODULE_BETA_ACCEPTANCE_WORKER_ENABLED).toBe('true');
    expect(worker.DEVELOPER_TRUST_S3_ENDPOINT).toBe(controller.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT);
    expect(worker.DEVELOPER_TRUST_S3_REGION).toBe(controller.MODULE_BETA_ACCEPTANCE_S3_REGION);
    expect(worker.DEVELOPER_TRUST_S3_BUCKET).toBe(controller.MODULE_BETA_ACCEPTANCE_S3_BUCKET);
    expect(worker.DEVELOPER_TRUST_S3_FORCE_PATH_STYLE).toBe(
      controller.MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE,
    );
    expect(integration.DEVELOPER_TRUST_S3_ENDPOINT).toBe(worker.DEVELOPER_TRUST_S3_ENDPOINT);
    expect(integration.DEVELOPER_TRUST_S3_REGION).toBe(worker.DEVELOPER_TRUST_S3_REGION);
    expect(integration.DEVELOPER_TRUST_S3_BUCKET).toBe(worker.DEVELOPER_TRUST_S3_BUCKET);
    expect(integration.DEVELOPER_TRUST_S3_FORCE_PATH_STYLE).toBe(
      worker.DEVELOPER_TRUST_S3_FORCE_PATH_STYLE,
    );

    const enabledConfig = loadModuleBetaAcceptanceConfig(controller);
    expect(enabledConfig.enabled).toBe(true);
    if (!enabledConfig.enabled) throw new Error('controller config unexpectedly disabled');
    expect(enabledConfig.controllerIdentity).toBe(controllerIdentity);
    expect(enabledConfig.allowedPresignHosts).toEqual(['s3.staging.private.example']);
    expect(enabledConfig.s3).toEqual({
      endpoint: overrides.MODULE_BETA_ACCEPTANCE_S3_ENDPOINT,
      region: overrides.MODULE_BETA_ACCEPTANCE_S3_REGION,
      bucket: overrides.MODULE_BETA_ACCEPTANCE_S3_BUCKET,
      accessKeyIdFile: '/run/openopc-secrets/s3-access-key-id',
      secretAccessKeyFile: '/run/openopc-secrets/s3-secret-access-key',
      forcePathStyle: false,
      serverSideEncryption: 'AES256',
    });
  });
});
