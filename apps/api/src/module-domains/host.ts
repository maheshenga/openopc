import { createHash, timingSafeEqual } from 'node:crypto';

import { makeOpenApiApp } from '../openapi';
import { rejectUnavailableCapability } from '../release-profile/routes';
import type { RuntimeReleaseProfile } from '../release-profile/runtime';
import type { AppEnv } from '../types';
import type { ModuleCustomDomainEnvironment } from './bindings';
import {
  STATIC_MODULE_RELEASE_MAX_ARTIFACT_BYTES,
  type StaticModuleRelease,
  type StaticModuleReleaseReader,
} from './static-release-reader';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MODULE_CUSTOM_DOMAIN_MAX_ARTIFACT_BYTES = STATIC_MODULE_RELEASE_MAX_ARTIFACT_BYTES;

export interface ModuleCustomDomainStaticRelease extends StaticModuleRelease {
  environment: ModuleCustomDomainEnvironment;
  bindingId: string;
}

export interface ModuleCustomDomainHostRepository {
  loadActiveSandboxedWebRelease(input: {
    environment: ModuleCustomDomainEnvironment;
    bindingId: string;
    releaseId: string;
  }): Promise<ModuleCustomDomainStaticRelease | null>;
}

export interface ModulePlatformHostRepository {
  loadPublishedSandboxedWebRelease(input: {
    releaseId: string;
  }): Promise<StaticModuleRelease | null>;
}

function safeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function parseModuleFrameAncestors(
  values: readonly (string | undefined)[],
): readonly string[] {
  const origins = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const loopback =
        url.hostname === 'localhost' ||
        url.hostname === '[::1]' ||
        /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.hostname.includes('*') ||
        url.pathname !== '/' ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      ) {
        continue;
      }
      origins.add(url.origin);
    } catch {
      // Invalid operator configuration is omitted from the frame policy.
    }
  }
  return [...origins];
}

function staticHostHeaders(contentType: string, frameAncestors: readonly string[]): Headers {
  const framePolicy = frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'";
  return new Headers({
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'self' data: blob:; base-uri 'none'; object-src 'none'; connect-src 'self'; form-action 'self'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; frame-ancestors ${framePolicy}`,
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
      reader: Pick<StaticModuleReleaseReader, 'read'>;
    },
  ) {}

  async read(input: {
    environment: ModuleCustomDomainEnvironment;
    bindingId: string;
    releaseId: string;
    path: string;
  }): ReturnType<StaticModuleReleaseReader['read']> {
    if (!UUID_RE.test(input.bindingId) || !UUID_RE.test(input.releaseId)) return null;
    const release = await this.input.repository.loadActiveSandboxedWebRelease({
      environment: input.environment,
      bindingId: input.bindingId,
      releaseId: input.releaseId,
    });
    if (!release) return null;
    return this.input.reader.read(release, input.path);
  }
}

export class ModulePlatformStaticHostService {
  constructor(
    private readonly input: {
      repository: ModulePlatformHostRepository;
      reader: Pick<StaticModuleReleaseReader, 'read'>;
    },
  ) {}

  async read(input: {
    releaseId: string;
    path: string;
  }): ReturnType<StaticModuleReleaseReader['read']> {
    if (!CANONICAL_UUID_RE.test(input.releaseId)) return null;
    try {
      const release = await this.input.repository.loadPublishedSandboxedWebRelease({
        releaseId: input.releaseId,
      });
      if (!release || release.releaseId !== input.releaseId) return null;
      return await this.input.reader.read(release, input.path);
    } catch {
      return null;
    }
  }
}

export interface ModuleCustomDomainHostRouteDependencies {
  hostService: Pick<ModuleCustomDomainStaticHostService, 'read'> | null;
  platformHostService: Pick<ModulePlatformStaticHostService, 'read'> | null;
  frameAncestors: readonly string[];
  internalServiceKey: string;
  environment: ModuleCustomDomainEnvironment;
  runtime: RuntimeReleaseProfile;
}

export function createModuleCustomDomainHostRoutes(
  dependencies: ModuleCustomDomainHostRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();
  // biome-ignore lint/suspicious/noExplicitAny: Hono's path-specific handler generic is not reusable across routes.
  const rejectRequest = (context: any): Response | null => {
    const suppliedKey = context.req.header('X-Kortix-Internal-Key') ?? '';
    if (
      dependencies.internalServiceKey.length < 16 ||
      !safeEqual(suppliedKey, dependencies.internalServiceKey)
    ) {
      return new Response('Unauthorized', { status: 401 });
    }
    return rejectUnavailableCapability(context, 'module.app.render', dependencies.runtime);
  };
  // biome-ignore lint/suspicious/noExplicitAny: Hono's path-specific handler generic is not reusable across both routes.
  const handleCustomDomain = async (context: any) => {
    const rejected = rejectRequest(context);
    if (rejected) return rejected;
    if (!dependencies.hostService) return notFound();
    const releaseId = context.req.param('releaseId');
    const bindingId = context.req.header('X-OpenOPC-Module-Domain-Binding') ?? '';
    let asset = null;
    try {
      asset = await dependencies.hostService.read({
        environment: dependencies.environment,
        bindingId,
        releaseId,
        path: context.req.param('*') ?? '',
      });
    } catch {
      return notFound();
    }
    return asset
      ? new Response(Buffer.from(asset.bytes), {
          headers: staticHostHeaders(asset.contentType, dependencies.frameAncestors),
        })
      : notFound();
  };
  // biome-ignore lint/suspicious/noExplicitAny: Hono's path-specific handler generic is not reusable across both routes.
  const handlePlatform = async (context: any) => {
    const rejected = rejectRequest(context);
    if (rejected) return rejected;
    const releaseId = context.req.param('releaseId');
    const trustedReleaseId = context.req.header('X-OpenOPC-Module-Release') ?? '';
    if (!CANONICAL_UUID_RE.test(releaseId) || !safeEqual(trustedReleaseId, releaseId)) {
      return notFound();
    }
    if (!dependencies.platformHostService) return notFound();
    const asset = await dependencies.platformHostService.read({
      releaseId,
      path: context.req.param('*') ?? '',
    });
    return asset
      ? new Response(Buffer.from(asset.bytes), {
          headers: staticHostHeaders(asset.contentType, dependencies.frameAncestors),
        })
      : notFound();
  };
  app.get('/module-host/releases/:releaseId', handleCustomDomain);
  app.get('/module-host/releases/:releaseId/*', handleCustomDomain);
  app.get('/module-host/platform/releases/:releaseId', handlePlatform);
  app.get('/module-host/platform/releases/:releaseId/*', handlePlatform);
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
