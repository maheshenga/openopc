import { createHash, timingSafeEqual } from 'node:crypto';

import { readRegistryModuleManifest } from '@kortix/registry';

import {
  type DeveloperArtifactStore,
  parseDeveloperModuleArtifactPackage,
  readDeveloperArtifactBytes,
} from '../developer/artifacts';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import type { ModuleCustomDomainEnvironment } from './bindings';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const MODULE_CUSTOM_DOMAIN_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface ModuleCustomDomainStaticRelease {
  environment: ModuleCustomDomainEnvironment;
  bindingId: string;
  releaseId: string;
  storageKey: string;
  artifactDigest: `sha256:${string}`;
  artifactSize: number;
  entryPath: string;
}

export interface ModuleCustomDomainHostRepository {
  loadActiveSandboxedWebRelease(input: {
    environment: ModuleCustomDomainEnvironment;
    bindingId: string;
    releaseId: string;
  }): Promise<ModuleCustomDomainStaticRelease | null>;
}

type StaticModuleAsset = Readonly<{
  bytes: Uint8Array;
  contentType: string;
}>;

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizedAssetPath(value: string, entryPath: string): string | null {
  const requested = value.replace(/^\/+/, '');
  if (!requested) return entryPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded;
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.wasm': 'application/wasm',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extension] ?? 'application/octet-stream'
  );
}

function staticHostHeaders(contentType: string): Headers {
  return new Headers({
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'self' data: blob:; base-uri 'none'; object-src 'none'; connect-src 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'",
    'content-type': contentType,
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
}

function notFound(): Response {
  return new Response('Not Found', { status: 404 });
}

export class ModuleCustomDomainStaticHostService {
  constructor(
    private readonly input: {
      repository: ModuleCustomDomainHostRepository;
      artifactStore: Pick<DeveloperArtifactStore, 'readCanonical'>;
    },
  ) {}

  async read(input: {
    environment: ModuleCustomDomainEnvironment;
    bindingId: string;
    releaseId: string;
    path: string;
  }): Promise<StaticModuleAsset | null> {
    if (!UUID_RE.test(input.bindingId) || !UUID_RE.test(input.releaseId)) return null;
    const release = await this.input.repository.loadActiveSandboxedWebRelease({
      environment: input.environment,
      bindingId: input.bindingId,
      releaseId: input.releaseId,
    });
    if (
      !release ||
      !SHA256_RE.test(release.artifactDigest) ||
      !Number.isSafeInteger(release.artifactSize) ||
      release.artifactSize <= 0 ||
      release.artifactSize > MODULE_CUSTOM_DOMAIN_MAX_ARTIFACT_BYTES
    ) {
      return null;
    }
    const assetPath = normalizedAssetPath(input.path, release.entryPath);
    if (!assetPath) return null;

    let artifactBytes: Uint8Array;
    try {
      artifactBytes = await readDeveloperArtifactBytes(
        this.input.artifactStore.readCanonical(release.storageKey, {
          maxBytes: MODULE_CUSTOM_DOMAIN_MAX_ARTIFACT_BYTES,
        }),
        release.artifactSize,
      );
    } catch {
      return null;
    }
    if (digest(artifactBytes) !== release.artifactDigest) return null;

    try {
      const artifact = parseDeveloperModuleArtifactPackage(artifactBytes);
      const manifest = readRegistryModuleManifest(artifact.item);
      if (
        !manifest ||
        manifest.execution.mode !== 'sandboxed-web' ||
        manifest.execution.entry !== release.entryPath
      ) {
        return null;
      }
      const file = artifact.files?.find(
        (candidate) =>
          candidate.target === assetPath &&
          (candidate.kind === undefined || candidate.kind === 'file'),
      );
      if (!file) return null;
      return { bytes: file.bytes, contentType: contentTypeFor(assetPath) };
    } catch {
      return null;
    }
  }
}

export interface ModuleCustomDomainHostRouteDependencies {
  hostService: Pick<ModuleCustomDomainStaticHostService, 'read'> | null;
  internalServiceKey: string;
  environment: ModuleCustomDomainEnvironment;
}

export function createModuleCustomDomainHostRoutes(
  dependencies: ModuleCustomDomainHostRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();
  // biome-ignore lint/suspicious/noExplicitAny: Hono's path-specific handler generic is not reusable across both routes.
  const handle = async (context: any) => {
    const suppliedKey = context.req.header('X-Kortix-Internal-Key') ?? '';
    if (
      dependencies.internalServiceKey.length < 16 ||
      !safeEqual(suppliedKey, dependencies.internalServiceKey)
    ) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (!dependencies.hostService) return notFound();
    const releaseId = context.req.param('releaseId');
    const bindingId = context.req.header('X-OpenOPC-Module-Domain-Binding') ?? '';
    const asset = await dependencies.hostService.read({
      environment: dependencies.environment,
      bindingId,
      releaseId,
      path: context.req.param('*') ?? '',
    });
    return asset
      ? new Response(Buffer.from(asset.bytes), { headers: staticHostHeaders(asset.contentType) })
      : notFound();
  };
  app.get('/module-host/releases/:releaseId', handle);
  app.get('/module-host/releases/:releaseId/*', handle);
  return app;
}

export function createMemoryModuleCustomDomainHostRepository(input?: {
  releases?: readonly ModuleCustomDomainStaticRelease[];
}): ModuleCustomDomainHostRepository {
  const releases = new Map(
    (input?.releases ?? []).map((release) => [
      `${release.environment}\0${release.bindingId}\0${release.releaseId}`,
      structuredClone(release),
    ]),
  );
  return {
    async loadActiveSandboxedWebRelease(query) {
      return (
        structuredClone(
          releases.get(`${query.environment}\0${query.bindingId}\0${query.releaseId}`) ?? null,
        ) ?? null
      );
    },
  };
}
