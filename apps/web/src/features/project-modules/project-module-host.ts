import type { ProjectModuleLaunchDescriptor } from '@kortix/sdk';

import {
  isSandboxedWebModuleManifest,
  type issueProjectModuleServiceCapability,
  moduleServiceDeclarations,
} from './client';
import { attachModuleBootstrapBridge } from './module-bootstrap-bridge';
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

function manifestSdkApiVersion(
  manifest: unknown,
  descriptor: ProjectModuleLaunchDescriptor,
): 'v1' | null {
  if (!isRecord(manifest)) return null;
  if (!manifestMatchesDescriptor(manifest, descriptor) || !isSandboxedWebModuleManifest(manifest)) {
    return null;
  }
  if (!isRecord(manifest.openopc)) return null;
  return manifest.openopc.sdkApiVersion === 'v1' ? 'v1' : null;
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
  const sdkApiVersion = manifestSdkApiVersion(input.manifest, input.descriptor);
  const declarations = sdkApiVersion ? moduleServiceDeclarations(input.manifest) : [];
  const declaredServices = Object.fromEntries(
    declarations.map(({ service, operations }) => [service, operations]),
  );

  const cleanups: Array<() => void> = [];
  if (sdkApiVersion) {
    cleanups.push(
      attachModuleBootstrapBridge(input.eventTarget, {
        moduleOrigin: input.descriptor.origin,
        moduleSource: input.moduleSource,
        sdkApiVersion,
        context: {
          projectId: input.projectId,
          installationId: input.descriptor.installation_id,
          releaseId: input.descriptor.release_id,
          installRevision: input.descriptor.install_revision,
        },
      }),
    );
  }
  cleanups.push(
    attachModuleServiceBridge(input.eventTarget, {
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
    }),
  );

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      cleanups[index]?.();
    }
  };
}
