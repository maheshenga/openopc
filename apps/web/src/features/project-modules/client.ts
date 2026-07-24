import {
  type ProjectModuleInstallation,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationTransition,
  type ProjectModuleMutationOptions,
  installProjectModule,
  listMarketplaceCatalogItems,
  listProjectModuleInstallationHistory,
  listProjectModules,
  rollbackProjectModule,
  updateProjectModule,
} from '@kortix/sdk';

export interface PublishedProjectModuleRelease {
  release_id: string;
  module_id: string;
  module_version: string;
  item_name: string;
  publisher_id: string;
  signature_key_id: string | null;
  signed_at: string | null;
  published_at: string | null;
}

export async function listInstalledProjectModules(
  projectId: string,
): Promise<ProjectModuleInstallation[]> {
  return (await listProjectModules(projectId)).modules;
}

export async function listProjectModuleHistory(
  projectId: string,
  moduleId: string,
): Promise<ProjectModuleInstallationEvent[]> {
  return (await listProjectModuleInstallationHistory(projectId, moduleId)).history;
}

function asPublishedRelease(value: Record<string, unknown>): PublishedProjectModuleRelease | null {
  const releaseId = value.release_id;
  const moduleId = value.module_id;
  const moduleVersion = value.module_version;
  const itemName = value.name ?? value.title;
  const publisherId = value.publisher_id ?? value.owner;
  if (
    typeof releaseId !== 'string' ||
    typeof moduleId !== 'string' ||
    typeof moduleVersion !== 'string' ||
    typeof itemName !== 'string' ||
    typeof publisherId !== 'string'
  ) {
    return null;
  }
  return {
    release_id: releaseId,
    module_id: moduleId,
    module_version: moduleVersion,
    item_name: itemName,
    publisher_id: publisherId,
    signature_key_id: typeof value.signature_key_id === 'string' ? value.signature_key_id : null,
    signed_at: typeof value.signed_at === 'string' ? value.signed_at : null,
    published_at: typeof value.published_at === 'string' ? value.published_at : null,
  };
}

export async function listPublishedProjectModuleReleases(): Promise<
  PublishedProjectModuleRelease[]
> {
  const response = await listMarketplaceCatalogItems({
    type: 'registry:module',
    source: 'openopc-modules',
  });
  return response.items
    .map((item) => asPublishedRelease(item))
    .filter((item): item is PublishedProjectModuleRelease => item !== null)
    .sort(
      (left, right) =>
        left.module_id.localeCompare(right.module_id) ||
        left.module_version.localeCompare(right.module_version) ||
        left.release_id.localeCompare(right.release_id),
    );
}

function mutationOptions(idempotencyKey?: string): ProjectModuleMutationOptions | undefined {
  return idempotencyKey ? { idempotencyKey } : undefined;
}

export function installPublishedProjectModule(
  projectId: string,
  releaseId: string,
  idempotencyKey?: string,
): Promise<ProjectModuleInstallationTransition> {
  return installProjectModule(
    projectId,
    { release_id: releaseId, expected_install_revision: 0 },
    mutationOptions(idempotencyKey),
  );
}

export function updatePublishedProjectModule(
  projectId: string,
  moduleId: string,
  releaseId: string,
  expectedInstallRevision: number,
  idempotencyKey?: string,
): Promise<ProjectModuleInstallationTransition> {
  return updateProjectModule(
    projectId,
    moduleId,
    { release_id: releaseId, expected_install_revision: expectedInstallRevision },
    mutationOptions(idempotencyKey),
  );
}

export function rollbackPublishedProjectModule(
  projectId: string,
  moduleId: string,
  releaseId: string,
  expectedInstallRevision: number,
  idempotencyKey?: string,
): Promise<ProjectModuleInstallationTransition> {
  return rollbackProjectModule(
    projectId,
    moduleId,
    { release_id: releaseId, expected_install_revision: expectedInstallRevision },
    mutationOptions(idempotencyKey),
  );
}
