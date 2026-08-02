import type { ProjectModuleLaunchDescriptor } from '@kortix/sdk';

import { type issueProjectModuleServiceCapability, moduleServiceDeclarations } from './client';
import { attachModuleServiceBridge } from './module-service-bridge';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function manifestMatchesDescriptor(
  manifest: unknown,
  descriptor: ProjectModuleLaunchDescriptor,
): boolean {
  return (
    isRecord(manifest) &&
    manifest.id === descriptor.module_id &&
    manifest.version === descriptor.module_version
  );
}

export function attachProjectModuleHostBridge(input: {
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  moduleSource: Window;
  projectId: string;
  descriptor: ProjectModuleLaunchDescriptor;
  manifest: unknown;
  issueCapability: typeof issueProjectModuleServiceCapability;
  resolveLaunch: () => Promise<ProjectModuleLaunchDescriptor>;
}): () => void {
  const declarations = manifestMatchesDescriptor(input.manifest, input.descriptor)
    ? moduleServiceDeclarations(input.manifest)
    : [];
  const declaredServices = Object.fromEntries(
    declarations.map(({ service, operations }) => [service, operations]),
  );

  return attachModuleServiceBridge(input.eventTarget, {
    moduleOrigin: input.descriptor.origin,
    moduleSource: input.moduleSource,
    projectId: input.projectId,
    installationId: input.descriptor.installation_id,
    releaseId: input.descriptor.release_id,
    installRevision: input.descriptor.install_revision,
    declaredServices,
    issueToken: async ({ installationId, service, operation }) => {
      const capability = await input.issueCapability(input.projectId, installationId, {
        service,
        operations: [operation],
      });
      return { token: capability.token, expiresAt: capability.expires_at };
    },
    resolveCurrentState: async () => {
      const descriptor = await input.resolveLaunch();
      return {
        projectId: input.projectId,
        installationId: descriptor.installation_id,
        releaseId: descriptor.release_id,
        installRevision: descriptor.install_revision,
      };
    },
  });
}
