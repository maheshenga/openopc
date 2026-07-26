import { readFileSync } from 'node:fs';

import { type GetObjectCommand, S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import postgres, { type Sql } from 'postgres';

import { type ModuleBetaAcceptanceConfig, loadModuleBetaAcceptanceConfig } from './config';
import { createModuleBetaAcceptanceController } from './controller';
import { createPostgresModuleBetaAcceptanceRepository } from './postgres';
import { createS3ModuleBetaAcceptanceStore } from './s3';
import { createModuleBetaAcceptanceServerHandler } from './server';

type HttpServer = {
  port: number;
  stop(force?: boolean): void | Promise<void>;
};

type ModuleBetaAcceptanceS3ClientConfig = S3ClientConfig & {
  serverSideEncryption: 'AES256';
};

export type ModuleBetaAcceptanceRuntimeDependencies = {
  readTextSecret?(path: string, maximumBytes: number): string;
  readBinarySecret?(path: string, minimumBytes: number, maximumBytes: number): Uint8Array;
  createPostgres?(databaseUrl: string): Sql;
  createS3Client?(config: ModuleBetaAcceptanceS3ClientConfig): S3Client;
  presign?(command: GetObjectCommand, expiresIn: number): Promise<string>;
  serve?(handler: (request: Request) => Promise<Response>, port: number): HttpServer;
};

export type ModuleBetaAcceptanceRuntime = {
  config: ModuleBetaAcceptanceConfig;
  handler(request: Request): Promise<Response>;
  port: number;
  close(): Promise<void>;
};

export class ModuleBetaAcceptanceStartupError extends Error {
  override readonly name = 'ModuleBetaAcceptanceStartupError';
  readonly code = 'MODULE_BETA_ACCEPTANCE_STARTUP_FAILED';

  constructor() {
    super('MODULE_BETA_ACCEPTANCE_STARTUP_FAILED');
  }
}

export async function startModuleBetaAcceptanceServer(
  input: {
    environment?: Readonly<Record<string, string | undefined>>;
    dependencies?: ModuleBetaAcceptanceRuntimeDependencies;
  } = {},
): Promise<ModuleBetaAcceptanceRuntime> {
  const dependencies = input.dependencies ?? {};
  let sql: Sql | null = null;
  let server: HttpServer | null = null;
  try {
    const config = loadModuleBetaAcceptanceConfig(input.environment ?? process.env);
    const handler = config.enabled
      ? (() => {
          const readText = dependencies.readTextSecret ?? readTextSecret;
          const readBinary = dependencies.readBinarySecret ?? readBinarySecret;
          const token = boundedText(readText(config.tokenFile, 4_096), 32, 4_096);
          const faultKey = readBinary(config.faultKeyFile, 32, 128);
          if (
            !(faultKey instanceof Uint8Array) ||
            faultKey.byteLength < 32 ||
            faultKey.byteLength > 128
          ) {
            throw new Error('MODULE_BETA_ACCEPTANCE_SECRET_INVALID');
          }
          const databaseUrl = validatedDatabaseUrl(
            boundedText(readText(config.databaseUrlFile, 4_096), 1, 4_096),
          );
          const accessKeyId = boundedText(readText(config.s3.accessKeyIdFile, 1_024), 1, 1_024);
          const secretAccessKey = boundedText(
            readText(config.s3.secretAccessKeyFile, 4_096),
            1,
            4_096,
          );
          sql = (dependencies.createPostgres ?? defaultPostgres)(databaseUrl);
          const s3 = (dependencies.createS3Client ?? ((value) => new S3Client(value)))({
            endpoint: config.s3.endpoint,
            region: config.s3.region,
            forcePathStyle: config.s3.forcePathStyle,
            serverSideEncryption: config.s3.serverSideEncryption,
            credentials: { accessKeyId, secretAccessKey },
          });
          const repository = createPostgresModuleBetaAcceptanceRepository({ sql });
          const store = createS3ModuleBetaAcceptanceStore({
            client: s3,
            bucket: config.s3.bucket,
            serverSideEncryption: config.s3.serverSideEncryption,
            key: new Uint8Array(faultKey),
            controllerIdentity: config.controllerIdentity,
            planTtlSeconds: config.planTtlSeconds,
            presignTtlSeconds: config.presignTtlSeconds,
            allowedPresignHosts: config.allowedPresignHosts,
            presign:
              dependencies.presign ??
              ((command, expiresIn) => getSignedUrl(s3, command, { expiresIn })),
          });
          const controller = createModuleBetaAcceptanceController({
            controllerIdentity: config.controllerIdentity,
            repository,
            store,
            retentionProbeGraceMs: config.retentionProbeGraceMs,
          });
          return createModuleBetaAcceptanceServerHandler({
            enabled: true,
            token,
            controllerIdentity: config.controllerIdentity,
            controller,
          });
        })()
      : createModuleBetaAcceptanceServerHandler({ enabled: false });
    server = (dependencies.serve ?? defaultServe)(handler, config.port);
    if (!Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65_535) {
      throw new Error('MODULE_BETA_ACCEPTANCE_SERVER_INVALID');
    }
    let closePromise: Promise<void> | null = null;
    return {
      config,
      handler,
      port: server.port,
      close() {
        closePromise ??= (async () => {
          await Promise.resolve(server?.stop(true)).catch(() => undefined);
          await Promise.resolve(sql?.end({ timeout: 5 })).catch(() => undefined);
        })();
        return closePromise;
      },
    };
  } catch {
    await Promise.resolve(server?.stop(true)).catch(() => undefined);
    await Promise.resolve(sql?.end({ timeout: 5 })).catch(() => undefined);
    throw new ModuleBetaAcceptanceStartupError();
  }
}

function defaultPostgres(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 4, connect_timeout: 5, idle_timeout: 30 });
}

function defaultServe(handler: (request: Request) => Promise<Response>, port: number): HttpServer {
  const server = Bun.serve({ hostname: '0.0.0.0', port, fetch: handler });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error('MODULE_BETA_ACCEPTANCE_SERVER_INVALID');
  }
  return { port: server.port, stop: (force) => server.stop(force) };
}

function readTextSecret(path: string, maximumBytes: number): string {
  const bytes = readFileSync(path);
  if (bytes.byteLength < 1 || bytes.byteLength > maximumBytes) {
    throw new Error('MODULE_BETA_ACCEPTANCE_SECRET_INVALID');
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function readBinarySecret(path: string, minimumBytes: number, maximumBytes: number): Uint8Array {
  const bytes = readFileSync(path);
  if (bytes.byteLength < minimumBytes || bytes.byteLength > maximumBytes) {
    throw new Error('MODULE_BETA_ACCEPTANCE_SECRET_INVALID');
  }
  return new Uint8Array(bytes);
}

function boundedText(value: string, minimumBytes: number, maximumBytes: number): string {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes < minimumBytes || bytes > maximumBytes || /[\0\r\n]/.test(value)) {
    throw new Error('MODULE_BETA_ACCEPTANCE_SECRET_INVALID');
  }
  return value;
}

function validatedDatabaseUrl(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    !url.hostname ||
    url.hash ||
    /prod(?:uction)?/i.test(url.hostname) ||
    /prod(?:uction)?/i.test(url.pathname)
  ) {
    throw new Error('MODULE_BETA_ACCEPTANCE_DATABASE_URL_INVALID');
  }
  return value;
}

if (import.meta.main) {
  const runtime = await startModuleBetaAcceptanceServer();
  const shutdown = () => void runtime.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
