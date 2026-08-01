import { describe, expect, test } from 'bun:test';
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';
import { resolve } from 'node:path';

import {
  canonicalDigest,
  sha256Digest,
  type Sha256Digest,
} from '../../module-runtime-contracts/src';
import postgres, { type Sql } from 'postgres';

import {
  type ModuleRuntimeAppDependencies,
  createModuleRuntimeApp,
} from '../../../apps/api/src/module-runtime/app';
import {
  computeModuleExecutionBindingDigest,
  type ModuleExecutionBinding,
} from '../../../apps/api/src/module-runtime/executions';
import {
  createDrizzleModuleExecutionBindingResolver,
  createDrizzleModuleExecutionInputStore,
  createDrizzleModuleExecutionRepository,
  createDrizzleModuleRunnerRepository,
} from '../../../apps/api/src/module-runtime/executions.drizzle';
import {
  RuntimeArtifactService,
  type RuntimeArtifactStore,
} from '../../../apps/api/src/module-runtime/runtime-artifacts';
import { createDrizzleRuntimeArtifactLeaseStore } from '../../../apps/api/src/module-runtime/runtime-artifacts.drizzle';
import {
  ModuleRunnerProtocol,
  ModuleRunnerProtocolError,
} from '../../../apps/api/src/module-runtime/runner-protocol';
import { createDbFromClient } from '../src/client';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0;
const container = `openopc-module-dispatch-${crypto.randomUUID().slice(0, 8)}`;
const migrationPath = resolve(
  import.meta.dir,
  '..',
  'migrations',
  '20260727150000000_module_runtime_control_plane.sql',
);
const moduleRunnerManifest = resolve(import.meta.dir, '..', '..', '..', 'apps', 'module-runner', 'Cargo.toml');
const echoComponentPath = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  'apps',
  'module-runner',
  'tests',
  'fixtures',
  'components',
  'echo.component.wasm',
);

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const INSTALLATION_ID = '30000000-0000-4000-a000-000000000001';
const RELEASE_ID = '40000000-0000-4000-a000-000000000001';
const DESCRIPTOR_ID = '50000000-0000-4000-a000-000000000001';
const RUNTIME_ARTIFACT_ID = '60000000-0000-4000-a000-000000000001';
const CONSENT_ID = '70000000-0000-4000-a000-000000000001';
const RUNNER_A_ID = '80000000-0000-4000-a000-000000000001';
const RUNNER_B_ID = '80000000-0000-4000-a000-000000000002';
const EXECUTION_ID = '90000000-0000-4000-a000-000000000001';
const GRANT_ID = 'a0000000-0000-4000-a000-000000000001';
const ACTOR_ID = 'b0000000-0000-4000-a000-000000000001';
const RUNNER_A_THUMBPRINT = 'a'.repeat(64);
const RUNNER_B_THUMBPRINT = 'b'.repeat(64);
const ATTESTATION_DIGEST = `sha256:${'c'.repeat(64)}` as Sha256Digest;
const RELEASE_DIGEST = `sha256:${'d'.repeat(64)}` as Sha256Digest;
const PERMISSION_DIGEST = `sha256:${'e'.repeat(64)}` as Sha256Digest;
const POLICY_DIGEST = `sha256:${'f'.repeat(64)}` as Sha256Digest;
const RAW_INPUT = '{"message":"dispatch-e2e"}';
const CAPABILITY_TOKEN = 'dispatch-live-capability-token';
const SIGNING_KEY_ID = 'dispatch-live-ed25519-v1';
const SIGNING_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIJmCEDv64wizHIsTGchUi9SY2TMxJ6fGK3Zp990ICwJo
-----END PRIVATE KEY-----`;
const SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAoVgs2gCfzx600bFrcAj5EUZfvAo+NSC4hToWoDJHPY4=
-----END PUBLIC KEY-----`;

const runtimeDescriptor = {
  descriptorVersion: 1,
  runtime: {
    kind: 'wasi-component' as const,
    component: 'runtime/echo.component.wasm',
    world: 'openopc:module/module@1.0.0',
    operation: 'run',
    imports: ['openopc:module/input', 'openopc:module/output'],
    limits: {
      cpuMillis: 60_000,
      fuel: 10_000_000,
      memoryMiB: 64,
      outputBytes: 4_096,
      pids: 1,
      wallTimeMs: 30_000,
    },
  },
};

function dockerPsql(sql: string, allowFailure = false) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

function disposableBaseSchema(): string {
  return `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE developer_trust_worker NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE SCHEMA kortix;
    GRANT USAGE ON SCHEMA kortix TO service_role, developer_trust_worker;

    CREATE TABLE kortix.accounts(account_id uuid PRIMARY KEY);
    CREATE TABLE kortix.projects(
      project_id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
      UNIQUE (project_id, account_id)
    );
    CREATE TABLE kortix.developer_module_releases(
      release_id uuid PRIMARY KEY,
      account_id uuid NOT NULL REFERENCES kortix.accounts(account_id),
      publisher_id varchar(63) NOT NULL,
      item_name varchar(128) NOT NULL,
      module_id varchar(128) NOT NULL,
      module_version varchar(128) NOT NULL,
      manifest jsonb NOT NULL,
      manifest_digest varchar(71) NOT NULL,
      review_requirements jsonb NOT NULL,
      status varchar(32) NOT NULL,
      review_revision integer NOT NULL DEFAULT 0,
      artifact_id uuid,
      artifact_digest varchar(71),
      sbom_digest varchar(71),
      trust_attestation_digest varchar(71),
      verification_policy_digest varchar(71),
      runtime_descriptor_digest varchar(71),
      runtime_descriptor_path varchar(512),
      runtime_kind varchar(32),
      signature_algorithm varchar(16),
      signature_key_id varchar(128),
      signature varchar(96),
      signature_payload_digest varchar(71),
      signed_at timestamptz,
      published_at timestamptz,
      revoked_at timestamptz,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (release_id, account_id)
    );
    CREATE TABLE kortix.project_module_installations(
      installation_id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      account_id uuid NOT NULL,
      module_id varchar(128) NOT NULL,
      active_release_id uuid NOT NULL,
      active_version varchar(128) NOT NULL,
      install_revision integer NOT NULL DEFAULT 0,
      status varchar(32) NOT NULL,
      installed_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (installation_id, project_id, account_id),
      UNIQUE (project_id, module_id)
    );
  `;
}

async function waitForPostgres(): Promise<string> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const readiness = dockerPsql('SELECT current_database();', true);
    if (readiness.exitCode === 0 && readiness.output.trim() === 'testdb') {
      const mapped = Bun.spawnSync(['docker', 'port', container, '5432/tcp'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (mapped.exitCode !== 0) throw new Error(mapped.stderr.toString());
      const port = mapped.stdout
        .toString()
        .trim()
        .match(/:(\d+)$/)?.[1];
      if (!port) throw new Error(`Could not resolve PostgreSQL port: ${mapped.stdout}`);
      return port;
    }
    await Bun.sleep(5_000);
  }
  throw new Error('Disposable PostgreSQL did not become query-ready');
}

function createContentAddressedArtifactStore(): RuntimeArtifactStore {
  const objects = new Map<string, { digest: Sha256Digest; bytes: Uint8Array }>();
  return {
    async write(input) {
      if (input.bytes.byteLength === 0 || (await sha256Digest(input.bytes)) !== input.digest) {
        throw new Error('TEST_RUNTIME_ARTIFACT_INVALID');
      }
      const storageKey = `module-runtime/artifacts/${input.digest.slice(7)}.wasm`;
      const prior = objects.get(storageKey);
      if (
        prior &&
        (prior.digest !== input.digest ||
          prior.bytes.byteLength !== input.bytes.byteLength ||
          prior.bytes.some((byte, index) => byte !== input.bytes[index]))
      ) {
        throw new Error('TEST_RUNTIME_ARTIFACT_COLLISION');
      }
      if (!prior) {
        objects.set(storageKey, { digest: input.digest, bytes: new Uint8Array(input.bytes) });
      }
      return {
        digest: input.digest,
        bytes: input.bytes.byteLength,
        mediaType: 'application/wasm',
        storageKey,
      };
    },
    async *read(storageKey, maxBytes) {
      const object = objects.get(storageKey);
      if (!object || object.bytes.byteLength > maxBytes) {
        throw new Error('TEST_RUNTIME_ARTIFACT_UNAVAILABLE');
      }
      yield new Uint8Array(object.bytes);
    },
  };
}

async function seedDispatchScenario(sql: Sql, artifactStore: RuntimeArtifactStore) {
  const input = new TextEncoder().encode(RAW_INPUT);
  const component = new Uint8Array(await Bun.file(echoComponentPath).arrayBuffer());
  const inputDigest = await sha256Digest(input);
  const descriptorDigest = await canonicalDigest(runtimeDescriptor);
  const artifactDigest = await sha256Digest(component);
  const storedArtifact = await artifactStore.write({
    accountId: ACCOUNT_ID,
    digest: artifactDigest,
    bytes: component,
  });
  const deadlineAt = new Date(Date.now() + 180_000).toISOString();
  const binding: ModuleExecutionBinding = {
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    installationId: INSTALLATION_ID,
    installRevision: 1,
    releaseId: RELEASE_ID,
    releaseDigest: RELEASE_DIGEST,
    consentRevisionId: CONSENT_ID,
    permissionDigest: PERMISSION_DIGEST,
    policyDigest: POLICY_DIGEST,
    runtimeDescriptorId: DESCRIPTOR_ID,
    runtimeDescriptorDigest: descriptorDigest,
    runtimeDescriptor,
    runtimeArtifactDigest: artifactDigest,
    runtimeArtifactBytes: component.byteLength,
    runtimeKind: 'wasi-component',
    runtimeProfile: 'openopc-wasi-v1',
    killSwitchGeneration: 0,
    resourceCeilings: {
      cpuMillis: 60_000,
      memoryMiB: 64,
      wallTimeMs: 30_000,
      costMicro: 0,
    },
    confirmationRequired: false,
  };
  const workEnvelopeDigest = await computeModuleExecutionBindingDigest(
    binding,
    deadlineAt,
    inputDigest,
  );

  await sql.begin(async (tx) => {
    await tx`INSERT INTO kortix.accounts(account_id) VALUES (${ACCOUNT_ID}::uuid)`;
    await tx`
      INSERT INTO kortix.projects(project_id, account_id)
      VALUES (${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid)
    `;
    await tx`
      INSERT INTO kortix.developer_module_releases(
        release_id, account_id, publisher_id, item_name, module_id, module_version,
        manifest, manifest_digest, review_requirements, status, review_revision,
        verification_policy_digest, runtime_descriptor_digest, runtime_descriptor_path,
        runtime_kind, signature_algorithm, signature_key_id, signature,
        signature_payload_digest, signed_at, published_at, created_by
      ) VALUES (
        ${RELEASE_ID}::uuid, ${ACCOUNT_ID}::uuid, 'openopc', 'dispatch-live',
        'openopc.dispatch-live', '1.0.0',
        ${JSON.stringify({ execution: { mode: 'module-runtime' } })}::jsonb,
        ${RELEASE_DIGEST}, ${JSON.stringify([])}::jsonb, 'published', 1,
        ${POLICY_DIGEST}, ${descriptorDigest}, 'runtime/descriptor.json',
        'wasi-component', 'ed25519', ${SIGNING_KEY_ID}, ${`base64url:${'a'.repeat(86)}`},
        ${RELEASE_DIGEST}, now(), now(), ${ACTOR_ID}::uuid
      )
    `;
    await tx`
      INSERT INTO kortix.project_module_installations(
        installation_id, project_id, account_id, module_id, active_release_id,
        active_version, install_revision, status, installed_by
      ) VALUES (
        ${INSTALLATION_ID}::uuid, ${PROJECT_ID}::uuid, ${ACCOUNT_ID}::uuid,
        'openopc.dispatch-live', ${RELEASE_ID}::uuid, '1.0.0', 1, 'active', ${ACTOR_ID}::uuid
      )
    `;
    await tx`
      INSERT INTO kortix.module_runtime_descriptors(
        descriptor_id, account_id, release_id, runtime_kind, descriptor_digest, descriptor
      ) VALUES (
        ${DESCRIPTOR_ID}::uuid, ${ACCOUNT_ID}::uuid, ${RELEASE_ID}::uuid,
        'wasi-component', ${descriptorDigest}, ${JSON.stringify(runtimeDescriptor)}::jsonb
      )
    `;
    await tx`
      INSERT INTO kortix.module_runtime_artifacts(
        runtime_artifact_id, account_id, release_id, runtime_descriptor_id,
        artifact_digest, artifact_bytes, media_type, storage_key
      ) VALUES (
        ${RUNTIME_ARTIFACT_ID}::uuid, ${ACCOUNT_ID}::uuid, ${RELEASE_ID}::uuid,
        ${DESCRIPTOR_ID}::uuid, ${artifactDigest}, ${component.byteLength},
        'application/wasm', ${storedArtifact.storageKey}
      )
    `;
    await tx`
      INSERT INTO kortix.project_module_consent_revisions(
        consent_revision_id, account_id, project_id, installation_id, install_revision,
        release_id, permission_digest, permission_snapshot,
        resource_cpu_millis_ceiling, resource_memory_mib_ceiling,
        resource_wall_time_ms_ceiling, cost_ceiling_micro, accepted_by
      ) VALUES (
        ${CONSENT_ID}::uuid, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
        ${INSTALLATION_ID}::uuid, 1, ${RELEASE_ID}::uuid, ${PERMISSION_DIGEST},
        ${JSON.stringify({ actions: [] })}::jsonb, 60000, 64, 30000, 0, ${ACTOR_ID}::uuid
      )
    `;
    await tx`
      INSERT INTO kortix.module_runners(
        runner_id, account_id, node_identity, status, software_version,
        attestation_digest, certificate_thumbprint
      ) VALUES
        (${RUNNER_A_ID}::uuid, ${ACCOUNT_ID}::uuid, 'dispatch-runner-a', 'active', '1.0.0',
         ${ATTESTATION_DIGEST}, ${RUNNER_A_THUMBPRINT}),
        (${RUNNER_B_ID}::uuid, ${ACCOUNT_ID}::uuid, 'dispatch-runner-b', 'active', '1.0.0',
         ${ATTESTATION_DIGEST}, ${RUNNER_B_THUMBPRINT})
    `;
    await tx`
      INSERT INTO kortix.module_runner_profiles(runner_id, account_id, profile_name, runtime_kind)
      VALUES
        (${RUNNER_A_ID}::uuid, ${ACCOUNT_ID}::uuid, 'openopc-wasi-v1', 'wasi-component'),
        (${RUNNER_B_ID}::uuid, ${ACCOUNT_ID}::uuid, 'openopc-wasi-v1', 'wasi-component')
    `;
    await tx`
      INSERT INTO kortix.module_executions(
        execution_id, account_id, project_id, installation_id, release_id,
        consent_revision_id, runtime_descriptor_id, runtime_kind, runtime_profile,
        state, idempotency_key, work_envelope_digest, kill_switch_generation, deadline_at
      ) VALUES (
        ${EXECUTION_ID}::uuid, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
        ${INSTALLATION_ID}::uuid, ${RELEASE_ID}::uuid, ${CONSENT_ID}::uuid,
        ${DESCRIPTOR_ID}::uuid, 'wasi-component', 'openopc-wasi-v1', 'dispatchable',
        'dispatch-live-execution', ${workEnvelopeDigest}, 0, ${deadlineAt}::timestamptz
      )
    `;
    await tx`
      INSERT INTO kortix.module_execution_inputs(
        execution_id, account_id, project_id, input_payload, input_digest
      ) VALUES (
        ${EXECUTION_ID}::uuid, ${ACCOUNT_ID}::uuid, ${PROJECT_ID}::uuid,
        ${Buffer.from(input)}, ${inputDigest}
      )
    `;
  });

  return { component, deadlineAt };
}

function unusedExecutionService(): ModuleRuntimeAppDependencies['executionService'] {
  const unused = async () => {
    throw new Error('USER_EXECUTION_ROUTE_NOT_AVAILABLE_IN_DISPATCH_TEST');
  };
  return {
    estimate: unused,
    create: unused,
    confirm: unused,
    cancel: unused,
    get: unused,
    events: unused,
  } as ModuleRuntimeAppDependencies['executionService'];
}

describe.skipIf(!dockerAvailable)('module Runner dispatch - real PostgreSQL/API/two-Runner', () => {
  test(
    'leases and executes once while the losing capacity-1 Runner receives only no-work responses',
    async () => {
      let sql: Sql | undefined;
      let server: ReturnType<typeof Bun.serve> | undefined;
      try {
        const started = Bun.spawnSync([
          'docker',
          'run',
          '--rm',
          '-d',
          '--name',
          container,
          '-e',
          'POSTGRES_PASSWORD=test',
          '-e',
          'POSTGRES_DB=testdb',
          '-p',
          '127.0.0.1::5432',
          'postgres:16-alpine',
        ]);
        if (started.exitCode !== 0) throw new Error(started.stderr.toString());
        const mappedPort = await waitForPostgres();
        const migration = await Bun.file(migrationPath).text();
        dockerPsql(`${disposableBaseSchema()}\n${migration}`);
        dockerPsql(`
          ALTER TABLE kortix.developer_module_releases
          ALTER COLUMN runtime_kind TYPE kortix.module_runtime_kind
          USING runtime_kind::kortix.module_runtime_kind;
        `);
        dockerPsql(migration);

        sql = postgres(`postgres://postgres:test@127.0.0.1:${mappedPort}/testdb`, {
          max: 8,
          prepare: false,
          connection: { application_name: 'module-runner-dispatch-live', statement_timeout: 60_000 },
        });
        const db = createDbFromClient(sql);
        const artifactStore = createContentAddressedArtifactStore();
        const seeded = await seedDispatchScenario(sql, artifactStore);
        const executionRepository = createDrizzleModuleExecutionRepository(db);
        const executionInputStore = createDrizzleModuleExecutionInputStore(db);
        const runnerRepository = createDrizzleModuleRunnerRepository(db);
        const bindingResolver = createDrizzleModuleExecutionBindingResolver(db);
        const preflightExecution = await executionRepository.get(
          ACCOUNT_ID,
          PROJECT_ID,
          EXECUTION_ID,
        );
        const preflightBinding = await bindingResolver.resolveForClaim(EXECUTION_ID);
        const preflightInput = await executionInputStore.get(ACCOUNT_ID, PROJECT_ID, EXECUTION_ID);
        if (!preflightExecution || !preflightBinding || !preflightInput) {
          throw new Error(
            `dispatch preflight unavailable: ${JSON.stringify({
              execution: !!preflightExecution,
              binding: !!preflightBinding,
              input: !!preflightInput,
            })}`,
          );
        }
        const preflight = {
          coordinates:
            preflightBinding.accountId === preflightExecution.accountId &&
            preflightBinding.projectId === preflightExecution.projectId &&
            preflightBinding.installationId === preflightExecution.installationId &&
            preflightBinding.releaseId === preflightExecution.releaseId &&
            preflightBinding.consentRevisionId === preflightExecution.consentRevisionId &&
            preflightBinding.runtimeDescriptorId === preflightExecution.runtimeDescriptorId &&
            preflightBinding.killSwitchGeneration === preflightExecution.killSwitchGeneration &&
            preflightBinding.runtimeKind === preflightExecution.runtimeKind &&
            preflightBinding.runtimeProfile === preflightExecution.runtimeProfile,
          descriptor:
            (await canonicalDigest(preflightBinding.runtimeDescriptor)) ===
            preflightBinding.runtimeDescriptorDigest,
          input: (await sha256Digest(preflightInput.payload)) === preflightInput.digest,
          binding:
            (await computeModuleExecutionBindingDigest(
              preflightBinding,
              preflightExecution.deadlineAt,
              preflightInput.digest,
            )) === preflightExecution.workEnvelopeDigest,
          deadlineAt: preflightExecution.deadlineAt,
        };
        if (!preflight.coordinates || !preflight.descriptor || !preflight.input || !preflight.binding) {
          throw new Error(`dispatch preflight mismatch: ${JSON.stringify(preflight)}`);
        }
        const signingKey = createPrivateKey(SIGNING_PRIVATE_KEY);
        const protocol = new ModuleRunnerProtocol({
          executionRepository,
          executionInputStore,
          runnerRepository,
          bindingResolver,
          capabilityIssuer: {
            async issueForClaim({ lease }) {
              return [
                {
                  grantId: GRANT_ID,
                  audience: 'egress',
                  token: CAPABILITY_TOKEN,
                  expiresAt: lease.deadlineAt,
                },
              ];
            },
          },
          envelopeSigner: {
            async sign(envelope, metadata) {
              const protectedHeader = Buffer.from(
                JSON.stringify({
                  alg: 'EdDSA',
                  typ: 'openopc-work-envelope+jwt',
                  kid: SIGNING_KEY_ID,
                  traceparent: metadata.traceparent,
                }),
              ).toString('base64url');
              const payload = Buffer.from(JSON.stringify(envelope)).toString('base64url');
              const signature = cryptoSign(
                null,
                Buffer.from(`${protectedHeader}.${payload}`),
                signingKey,
              ).toString('base64url');
              return `${protectedHeader}.${payload}.${signature}`;
            },
          },
        });
        const runtimeArtifactService = new RuntimeArtifactService({
          leaseStore: createDrizzleRuntimeArtifactLeaseStore(db),
          artifactStore,
        });
        const thumbprints = new Map([
          [RUNNER_A_ID, RUNNER_A_THUMBPRINT],
          [RUNNER_B_ID, RUNNER_B_THUMBPRINT],
        ]);
        const app = createModuleRuntimeApp({
          authenticateUser: async (_context, next) => next(),
          loadProjectForUser: async () => null,
          assertProjectCapability: async () => undefined,
          executionService: unusedExecutionService(),
          runnerProtocol: protocol,
          runtimeArtifactService,
          authenticateRunner: async (context) => {
            const runnerId = context.req.header('x-openopc-runner-id');
            const accountId = context.req.header('x-openopc-runner-account-id');
            const certificateThumbprint = runnerId ? thumbprints.get(runnerId) : undefined;
            if (!runnerId || accountId !== ACCOUNT_ID || !certificateThumbprint) {
              throw new ModuleRunnerProtocolError('RUNNER_AUTHENTICATION_FAILED', 401);
            }
            return { runnerId, accountId, certificateThumbprint };
          },
          registrationIdentity: async () => ({ certificateThumbprint: '0'.repeat(64) }),
        });

        const cargoTest = [
          'cargo',
          '+1.97.1',
          'test',
          '--manifest-path',
          moduleRunnerManifest,
          '--test',
          'dispatcher_live',
        ];
        const cargoCwd = resolve(import.meta.dir, '..');
        const prebuilt = Bun.spawnSync([...cargoTest, '--no-run'], {
          cwd: cargoCwd,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        if (prebuilt.exitCode !== 0) {
          const prebuildStdout = prebuilt.stdout.toString();
          const prebuildStderr = prebuilt.stderr.toString();
          throw new Error(
            `dispatcher_live prebuild exited ${prebuilt.exitCode}\nstdout:\n${prebuildStdout}\nstderr:\n${prebuildStderr}`,
          );
        }

        let injectedFinalizeFailures = 0;
        const requestLogs: Array<{ path: string; runnerId: string | null; status: number }> = [];
        server = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          async fetch(request) {
            const path = new URL(request.url).pathname;
            const runnerId = request.headers.get('x-openopc-runner-id');
            const response =
              path === '/module-runtime/finalize' && injectedFinalizeFailures === 0
                ? (() => {
                    injectedFinalizeFailures += 1;
                    return Response.json({ error: 'TEST_TRANSIENT_FINALIZE' }, { status: 503 });
                  })()
                : await app.fetch(request);
            requestLogs.push({ path, runnerId, status: response.status });
            return response;
          },
        });

        const runnerDeadlineMs = Date.now() + 120_000;
        const cargo = Bun.spawn(
          [
            ...cargoTest,
            '--',
            '--ignored',
            '--nocapture',
          ],
          {
            cwd: cargoCwd,
            env: {
              ...process.env,
              OPENOPC_DISPATCH_TEST_SERVER_URL: `http://127.0.0.1:${server.port}/`,
              OPENOPC_DISPATCH_TEST_ACCOUNT_ID: ACCOUNT_ID,
              OPENOPC_DISPATCH_TEST_RUNNER_A_ID: RUNNER_A_ID,
              OPENOPC_DISPATCH_TEST_RUNNER_B_ID: RUNNER_B_ID,
              OPENOPC_DISPATCH_TEST_PUBLIC_KEY_PEM: SIGNING_PUBLIC_KEY,
              OPENOPC_DISPATCH_TEST_KEY_ID: SIGNING_KEY_ID,
              OPENOPC_DISPATCH_TEST_DEADLINE_MS: String(runnerDeadlineMs),
            },
            stdout: 'pipe',
            stderr: 'pipe',
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          cargo.exited,
          new Response(cargo.stdout).text(),
          new Response(cargo.stderr).text(),
        ]);
        if (exitCode !== 0) {
          const diagnostic = await sql`
            SELECT
              execution.state::text AS state,
              (SELECT jsonb_agg(jsonb_build_object(
                'runner_id', lease.runner_id,
                'generation', lease.generation,
                'released', lease.released_at IS NOT NULL
              ) ORDER BY lease.created_at)
                FROM kortix.module_execution_leases AS lease
                WHERE lease.execution_id = execution.execution_id) AS leases,
              (SELECT jsonb_agg(event.event_type ORDER BY event.sequence)
                FROM kortix.module_execution_events AS event
                WHERE event.execution_id = execution.execution_id) AS events,
              (SELECT count(*)::integer FROM kortix.module_capability_grants AS grant_row
                WHERE grant_row.execution_id = execution.execution_id) AS grants,
              (SELECT count(*)::integer FROM kortix.module_execution_evidence AS evidence
                WHERE evidence.execution_id = execution.execution_id) AS evidence,
              (SELECT count(*)::integer FROM kortix.module_execution_outbox AS outbox
                WHERE outbox.execution_id = execution.execution_id) AS outbox
            FROM kortix.module_executions AS execution
            WHERE execution.execution_id = ${EXECUTION_ID}::uuid
          `;
          throw new Error(
            `dispatcher_live exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}` +
              `\nrequest_logs:\n${JSON.stringify(requestLogs, null, 2)}` +
              `\ndatabase:\n${JSON.stringify(diagnostic, null, 2)}`,
          );
        }

        const summaryLine = stdout
          .split(/\r?\n/)
          .find((line) => line.includes('"event":"dispatcher_live_summary"'));
        expect(summaryLine).toBeDefined();
        const runnerSummary = JSON.parse(summaryLine ?? '{}') as {
          claims_200?: number;
          claims_204?: number;
          finalize_503?: number;
          finalize_200?: number;
          losing_runner_token_count?: number;
          losing_runner_envelope_count?: number;
        };
        expect(runnerSummary).toMatchObject({
          claims_200: 1,
          finalize_503: 1,
          finalize_200: 1,
          losing_runner_token_count: 0,
          losing_runner_envelope_count: 0,
        });
        expect(runnerSummary.claims_204).toBeGreaterThanOrEqual(1);
        expect(injectedFinalizeFailures).toBe(1);

        const [truth] = await sql<
          {
            state: string;
            executionClaimedEvents: number;
            runtimeStartedEvents: number;
            terminalEvidenceRows: number;
            usageOutboxRows: number;
            liveLeases: number;
            capabilityGrantRows: number;
            capabilityGrantLeaseCount: number;
            evidence: unknown;
          }[]
        >`
          SELECT
            execution.state::text AS state,
            (SELECT count(*)::integer FROM kortix.module_execution_events AS event
              WHERE event.execution_id = execution.execution_id
                AND event.event_type = 'execution_claimed') AS "executionClaimedEvents",
            (SELECT count(*)::integer FROM kortix.module_execution_events AS event
              WHERE event.execution_id = execution.execution_id
                AND event.event_type = 'runtime_started') AS "runtimeStartedEvents",
            (SELECT count(*)::integer FROM kortix.module_execution_evidence AS evidence
              WHERE evidence.execution_id = execution.execution_id) AS "terminalEvidenceRows",
            (SELECT count(*)::integer FROM kortix.module_execution_outbox AS outbox
              WHERE outbox.execution_id = execution.execution_id) AS "usageOutboxRows",
            (SELECT count(*)::integer FROM kortix.module_execution_leases AS lease
              WHERE lease.execution_id = execution.execution_id
                AND lease.released_at IS NULL) AS "liveLeases",
            (SELECT count(*)::integer FROM kortix.module_capability_grants AS grant_row
              WHERE grant_row.execution_id = execution.execution_id) AS "capabilityGrantRows",
            (SELECT count(DISTINCT grant_row.lease_id)::integer
              FROM kortix.module_capability_grants AS grant_row
              WHERE grant_row.execution_id = execution.execution_id) AS "capabilityGrantLeaseCount",
            (SELECT jsonb_agg(evidence.evidence ORDER BY evidence.created_at)
              FROM kortix.module_execution_evidence AS evidence
              WHERE evidence.execution_id = execution.execution_id) AS evidence
          FROM kortix.module_executions AS execution
          WHERE execution.execution_id = ${EXECUTION_ID}::uuid
        `;
        expect(truth).toMatchObject({
          state: 'succeeded',
          executionClaimedEvents: 1,
          runtimeStartedEvents: 1,
          terminalEvidenceRows: 1,
          usageOutboxRows: 1,
          liveLeases: 0,
          capabilityGrantRows: 1,
          capabilityGrantLeaseCount: 1,
        });

        const captured = `${JSON.stringify(requestLogs)}\n${stdout}\n${stderr}\n${JSON.stringify(truth.evidence)}`;
        for (const forbidden of [
          RAW_INPUT,
          CAPABILITY_TOKEN,
          Buffer.from(seeded.component).toString('base64'),
          '"inputBase64"',
          '"signedEnvelope"',
          '"capabilityTokens"',
          '"componentBytes"',
        ]) {
          expect(captured).not.toContain(forbidden);
        }
      } finally {
        server?.stop(true);
        await sql?.end({ timeout: 5 }).catch(() => undefined);
        Bun.spawnSync(['docker', 'rm', '-f', container], {
          stdout: 'ignore',
          stderr: 'ignore',
        });
      }
    },
    420_000,
  );
});
