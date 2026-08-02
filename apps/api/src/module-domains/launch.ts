import type { RegistryModuleManifest } from '@kortix/registry';

import type { ModuleAppHostConfiguration } from './platform-host-config';

export interface ProjectModuleLaunchDescriptor {
  installation_id: string;
  release_id: string;
  install_revision: number;
  module_id: string;
  module_version: string;
  execution_mode: 'sandboxed-web';
  url: string;
  origin: string;
}

export interface ProjectModuleLaunchCandidate {
  accountId: string;
  projectId: string;
  installationId: string;
  installRevision: number;
  installationStatus: 'active' | 'blocked';
  activeReleaseId: string;
  activeVersion: string;
  moduleId: string;
  releaseId: string;
  releaseStatus: string;
  releaseModuleId: string;
  releaseModuleVersion: string;
  manifest: RegistryModuleManifest | null;
  signatureAlgorithm: string | null;
  signatureKeyId: string | null;
  signature: string | null;
  signaturePayloadDigest: string | null;
  signedAt: string | null;
  publishedAt: string | null;
  revokedAt: string | null;
  artifactId: string | null;
  storageKey: string | null;
  artifactDigest: string | null;
  artifactSize: number | null;
}

export interface ProjectModuleLaunchRepository {
  loadCandidate(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ProjectModuleLaunchCandidate | null>;
  isCurrent(input: {
    accountId: string;
    projectId: string;
    installationId: string;
    releaseId: string;
    installRevision: number;
  }): Promise<boolean>;
}

export type ProjectModuleLaunchErrorCode =
  | 'PROJECT_MODULE_NOT_FOUND'
  | 'PROJECT_MODULE_INACTIVE'
  | 'PROJECT_MODULE_NOT_LAUNCHABLE'
  | 'PROJECT_MODULE_LAUNCH_STALE'
  | 'PROJECT_MODULE_HOST_UNAVAILABLE';

export class ProjectModuleLaunchError extends Error {
  constructor(
    readonly code: ProjectModuleLaunchErrorCode,
    readonly status: 404 | 409 | 503,
  ) {
    super(code);
    this.name = 'ProjectModuleLaunchError';
  }
}

function fail(
  code: ProjectModuleLaunchErrorCode,
  status: ProjectModuleLaunchError['status'],
): never {
  throw new ProjectModuleLaunchError(code, status);
}

function isInactive(candidate: ProjectModuleLaunchCandidate): boolean {
  return (
    candidate.installationStatus !== 'active' ||
    candidate.releaseStatus !== 'published' ||
    candidate.publishedAt === null ||
    candidate.revokedAt !== null
  );
}

function hasStaleIdentity(candidate: ProjectModuleLaunchCandidate): boolean {
  return (
    candidate.activeReleaseId !== candidate.releaseId ||
    candidate.moduleId !== candidate.releaseModuleId ||
    candidate.activeVersion !== candidate.releaseModuleVersion ||
    !Number.isSafeInteger(candidate.installRevision) ||
    candidate.installRevision <= 0 ||
    (candidate.manifest !== null &&
      (candidate.manifest.id !== candidate.moduleId ||
        candidate.manifest.version !== candidate.activeVersion))
  );
}

function isLaunchable(candidate: ProjectModuleLaunchCandidate): boolean {
  const manifest = candidate.manifest;
  return Boolean(
    manifest &&
      manifest.schemaVersion === 3 &&
      manifest.execution.mode === 'sandboxed-web' &&
      manifest.execution.entry &&
      manifest.verification?.profile === 'sandboxed-web' &&
      candidate.artifactId &&
      candidate.storageKey &&
      candidate.artifactDigest &&
      typeof candidate.artifactSize === 'number' &&
      Number.isSafeInteger(candidate.artifactSize) &&
      candidate.artifactSize > 0 &&
      candidate.signatureAlgorithm === 'ed25519' &&
      candidate.signatureKeyId &&
      candidate.signature &&
      candidate.signaturePayloadDigest &&
      candidate.signedAt,
  );
}

export class ProjectModuleLaunchService {
  constructor(
    private readonly input: {
      repository: ProjectModuleLaunchRepository;
      hostConfiguration: ModuleAppHostConfiguration | null;
    },
  ) {}

  async resolve(input: {
    accountId: string;
    projectId: string;
    installationId: string;
  }): Promise<ProjectModuleLaunchDescriptor> {
    const candidate = await this.input.repository.loadCandidate(input);
    if (!candidate) fail('PROJECT_MODULE_NOT_FOUND', 404);
    if (
      candidate.accountId !== input.accountId ||
      candidate.projectId !== input.projectId ||
      candidate.installationId !== input.installationId
    ) {
      fail('PROJECT_MODULE_NOT_FOUND', 404);
    }
    if (isInactive(candidate)) fail('PROJECT_MODULE_INACTIVE', 409);
    if (hasStaleIdentity(candidate)) fail('PROJECT_MODULE_LAUNCH_STALE', 409);
    if (!isLaunchable(candidate)) fail('PROJECT_MODULE_NOT_LAUNCHABLE', 409);
    if (!this.input.hostConfiguration) fail('PROJECT_MODULE_HOST_UNAVAILABLE', 503);

    const host = this.input.hostConfiguration.descriptorForRelease(candidate.releaseId);
    const descriptor: ProjectModuleLaunchDescriptor = {
      installation_id: candidate.installationId,
      release_id: candidate.releaseId,
      install_revision: candidate.installRevision,
      module_id: candidate.moduleId,
      module_version: candidate.activeVersion,
      execution_mode: 'sandboxed-web',
      url: host.url,
      origin: host.origin,
    };

    const current = await this.input.repository.isCurrent({
      ...input,
      releaseId: candidate.releaseId,
      installRevision: candidate.installRevision,
    });
    if (!current) fail('PROJECT_MODULE_LAUNCH_STALE', 409);
    return Object.freeze(descriptor);
  }
}

export function createMemoryProjectModuleLaunchRepository(input?: {
  candidates?: readonly ProjectModuleLaunchCandidate[];
  current?: (candidate: ProjectModuleLaunchCandidate) => boolean;
}): ProjectModuleLaunchRepository {
  const candidates = (input?.candidates ?? []).map((candidate) => structuredClone(candidate));
  return {
    async loadCandidate(scope) {
      const candidate = candidates.find(
        (item) =>
          item.accountId === scope.accountId &&
          item.projectId === scope.projectId &&
          item.installationId === scope.installationId,
      );
      return candidate ? structuredClone(candidate) : null;
    },
    async isCurrent(scope) {
      const candidate = candidates.find(
        (item) =>
          item.accountId === scope.accountId &&
          item.projectId === scope.projectId &&
          item.installationId === scope.installationId &&
          item.releaseId === scope.releaseId &&
          item.installRevision === scope.installRevision,
      );
      return Boolean(candidate && (input?.current?.(structuredClone(candidate)) ?? true));
    },
  };
}
