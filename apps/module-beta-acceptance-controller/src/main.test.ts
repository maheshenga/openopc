import { expect, test } from 'bun:test';
import { HeadBucketCommand, type S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import type { Sql } from 'postgres';

import { startModuleBetaAcceptanceServer } from './main';

const controllerIdentity = `module-beta-controller@1.0.0#sha256:${'1'.repeat(64)}`;

const enabledEnvironment = {
  MODULE_BETA_ACCEPTANCE_ENABLED: 'true',
  MODULE_BETA_ACCEPTANCE_ENVIRONMENT: 'staging',
  MODULE_BETA_ACCEPTANCE_IDENTITY: controllerIdentity,
  MODULE_BETA_ACCEPTANCE_TOKEN_FILE: '/run/openopc-secrets/acceptance-token',
  MODULE_BETA_ACCEPTANCE_FAULT_KEY_FILE: '/run/openopc-secrets/acceptance-hmac',
  MODULE_BETA_ACCEPTANCE_DATABASE_URL_FILE: '/run/openopc-secrets/database-url',
  MODULE_BETA_ACCEPTANCE_S3_ENDPOINT: 'https://minio.staging.openopc.internal',
  MODULE_BETA_ACCEPTANCE_S3_REGION: 'us-east-1',
  MODULE_BETA_ACCEPTANCE_S3_BUCKET: 'developer-artifacts',
  MODULE_BETA_ACCEPTANCE_S3_ACCESS_KEY_ID_FILE: '/run/openopc-secrets/s3-access-key-id',
  MODULE_BETA_ACCEPTANCE_S3_SECRET_ACCESS_KEY_FILE: '/run/openopc-secrets/s3-secret-access-key',
  MODULE_BETA_ACCEPTANCE_S3_FORCE_PATH_STYLE: 'true',
  MODULE_BETA_ACCEPTANCE_S3_SERVER_SIDE_ENCRYPTION: 'AES256',
  MODULE_BETA_ACCEPTANCE_PLAN_TTL_SECONDS: '600',
  MODULE_BETA_ACCEPTANCE_PRESIGN_TTL_SECONDS: '300',
  MODULE_BETA_ACCEPTANCE_RETENTION_PROBE_GRACE_MS: '5000',
  MODULE_BETA_ACCEPTANCE_PRESIGN_ALLOWED_HOSTS_JSON: '["minio.staging.openopc.internal"]',
  MODULE_BETA_ACCEPTANCE_PORT: '8081',
};

test('starts an inert disabled listener without reading staging resources', async () => {
  let secretReads = 0;
  let resourceCreates = 0;
  let stopped = 0;
  const runtime = await startModuleBetaAcceptanceServer({
    environment: {},
    dependencies: {
      readTextSecret() {
        secretReads += 1;
        throw new Error('must not read');
      },
      readBinarySecret() {
        secretReads += 1;
        throw new Error('must not read');
      },
      createPostgres() {
        resourceCreates += 1;
        throw new Error('must not create');
      },
      createS3Client() {
        resourceCreates += 1;
        throw new Error('must not create');
      },
      serve(handler, port) {
        expect(port).toBe(8081);
        return {
          port,
          handler,
          stop() {
            stopped += 1;
          },
        };
      },
    },
  });

  const business = await runtime.handler(
    new Request('http://controller.internal/module-beta/trust/registrations', {
      method: 'POST',
    }),
  );
  expect(business.status).toBe(404);
  expect(secretReads).toBe(0);
  expect(resourceCreates).toBe(0);
  await runtime.close();
  await runtime.close();
  expect(stopped).toBe(1);
});

test('composes the enabled controller from file secrets and closes owned resources', async () => {
  const textSecrets: Record<string, string> = {
    '/run/openopc-secrets/acceptance-token': 'acceptance-control-token-for-staging',
    '/run/openopc-secrets/database-url':
      'postgres://openopc:secret@postgres.staging.internal:5432/openopc_trust',
    '/run/openopc-secrets/s3-access-key-id': 'openopc-staging-access',
    '/run/openopc-secrets/s3-secret-access-key': 'openopc-staging-secret',
  };
  const created: { databaseUrl?: string; s3?: S3ClientConfig; port?: number } = {};
  let databaseClosed = 0;
  let serverStopped = 0;
  const sql = {
    async unsafe(_query: string, parameters: unknown[]) {
      const tableName = String(parameters[0]);
      return [{ table_name: tableName }];
    },
    async end() {
      databaseClosed += 1;
    },
  } as unknown as Sql;
  const s3 = {
    async send(command: unknown) {
      if (command instanceof HeadBucketCommand) return {};
      throw new Error('unexpected command');
    },
  } as unknown as S3Client;

  const runtime = await startModuleBetaAcceptanceServer({
    environment: enabledEnvironment,
    dependencies: {
      readTextSecret(path) {
        const value = textSecrets[path];
        if (!value) throw new Error('missing test secret');
        return value;
      },
      readBinarySecret(path) {
        expect(path).toBe('/run/openopc-secrets/acceptance-hmac');
        return new Uint8Array(32).fill(7);
      },
      createPostgres(databaseUrl) {
        created.databaseUrl = databaseUrl;
        return sql;
      },
      createS3Client(input) {
        created.s3 = input;
        return s3;
      },
      async presign() {
        return 'https://minio.staging.openopc.internal/object?X-Amz-Signature=opaque';
      },
      serve(handler, port) {
        created.port = port;
        return {
          port,
          handler,
          stop() {
            serverStopped += 1;
          },
        };
      },
    },
  });

  const readiness = await runtime.handler(new Request('http://controller.internal/readyz'));
  expect(readiness.status).toBe(200);
  expect(await readiness.json()).toMatchObject({
    enabled: true,
    ready: true,
    identity: controllerIdentity,
  });
  expect(created).toMatchObject({
    databaseUrl: 'postgres://openopc:secret@postgres.staging.internal:5432/openopc_trust',
    port: 8081,
    s3: {
      endpoint: 'https://minio.staging.openopc.internal',
      region: 'us-east-1',
      forcePathStyle: true,
      serverSideEncryption: 'AES256',
      credentials: {
        accessKeyId: 'openopc-staging-access',
        secretAccessKey: 'openopc-staging-secret',
      },
    },
  });
  expect(runtime.config).toMatchObject({ retentionProbeGraceMs: 5_000 });

  await runtime.close();
  expect(serverStopped).toBe(1);
  expect(databaseClosed).toBe(1);
});
