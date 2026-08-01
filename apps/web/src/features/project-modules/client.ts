import {
  type ProjectModuleInstallation,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationTransition,
  type ProjectModuleMutationOptions,
  backendApi,
  installProjectModule,
  listMarketplaceCatalogItems,
  listProjectModuleInstallationHistory,
  listProjectModules,
  rollbackProjectModule,
  updateProjectModule,
} from '@kortix/sdk';

export type OpenOpcServiceName = 'ai' | 'payment';
export type OpenOpcAiServiceOperation = 'models.read' | 'text.generate' | 'text.stream';
export type OpenOpcPaymentServiceOperation = 'orders.create' | 'orders.read' | 'refunds.create';
export type OpenOpcServiceOperation = OpenOpcAiServiceOperation | OpenOpcPaymentServiceOperation;

export interface ModuleServiceDeclaration {
  service: OpenOpcServiceName;
  operations: OpenOpcServiceOperation[];
}

export interface ModuleServiceConsent {
  consent_id: string;
  installation_id: string;
  release_id: string;
  install_revision: number;
  service: OpenOpcServiceName;
  operations: OpenOpcServiceOperation[];
  consent_digest: string;
  accepted_at: string;
  revoked_at: string | null;
}

export interface ModuleServiceConsentsResponse {
  consents: ModuleServiceConsent[];
}

export interface ModuleServiceConsentMutationInput {
  operations: OpenOpcServiceOperation[];
  expected_install_revision: number;
}

export interface ModuleServiceCapabilityTokenRequest {
  service: OpenOpcServiceName;
  operations: OpenOpcServiceOperation[];
}

export interface ModuleServiceCapabilityTokenResponse {
  token: string;
  expires_at: string;
  grant_id: string;
}

const SERVICE_OPERATIONS: Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]> = {
  ai: ['models.read', 'text.generate', 'text.stream'],
  payment: ['orders.create', 'orders.read', 'refunds.create'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read only the signed v3 service declarations; malformed or legacy manifests fail closed. */
export function moduleServiceDeclarations(manifest: unknown): ModuleServiceDeclaration[] {
  if (!isRecord(manifest) || manifest.schemaVersion !== 3 || !isRecord(manifest.openopc)) return [];
  if (manifest.openopc.sdkApiVersion !== 'v1' || !isRecord(manifest.openopc.services)) return [];

  const declarations: ModuleServiceDeclaration[] = [];
  for (const service of ['ai', 'payment'] as const) {
    const raw = manifest.openopc.services[service];
    if (!isRecord(raw) || !Array.isArray(raw.operations) || raw.operations.length === 0) continue;
    const allowed = new Set(SERVICE_OPERATIONS[service]);
    const operations = raw.operations.filter(
      (operation): operation is OpenOpcServiceOperation =>
        typeof operation === 'string' && allowed.has(operation as never),
    );
    if (operations.length !== raw.operations.length) continue;
    const unique = [...new Set(operations)];
    if (unique.length !== operations.length) continue;
    declarations.push({ service, operations: [...unique] });
  }
  return declarations;
}

async function unwrapBackend<T>(
  response: Awaited<ReturnType<typeof backendApi.get<T>>>,
  message: string,
): Promise<T> {
  if (!response.success || response.data === undefined) {
    throw response.error ?? new Error(message);
  }
  return response.data;
}

export interface PublishedProjectModuleRelease {
  release_id: string;
  module_id: string;
  module_version: string;
  item_name: string;
  publisher_id: string;
  signature_key_id: string | null;
  signed_at: string | null;
  published_at: string | null;
  manifest?: Record<string, unknown>;
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
    manifest: isRecord(value.manifest) ? structuredClone(value.manifest) : undefined,
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

function moduleServicePath(projectId: string, installationId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/modules/${encodeURIComponent(installationId)}`;
}

export async function listProjectModuleServiceConsents(
  projectId: string,
  installationId: string,
): Promise<ModuleServiceConsent[]> {
  const response = await backendApi.get<ModuleServiceConsentsResponse>(
    `${moduleServicePath(projectId, installationId)}/service-consents`,
  );
  return (await unwrapBackend(response, 'Failed to list module service consents')).consents;
}

export async function grantProjectModuleServiceConsent(
  projectId: string,
  installationId: string,
  service: OpenOpcServiceName,
  input: ModuleServiceConsentMutationInput,
): Promise<ModuleServiceConsent> {
  const response = await backendApi.put<{ consent: ModuleServiceConsent }>(
    `${moduleServicePath(projectId, installationId)}/service-consents/${service}`,
    input,
  );
  return (await unwrapBackend(response, 'Failed to grant module service consent')).consent;
}

export async function revokeProjectModuleServiceConsent(
  projectId: string,
  installationId: string,
  service: OpenOpcServiceName,
  expectedInstallRevision: number,
): Promise<void> {
  const response = await backendApi.delete<{ ok: true }>(
    `${moduleServicePath(projectId, installationId)}/service-consents/${service}`,
    {
      body: JSON.stringify({ expected_install_revision: expectedInstallRevision }),
    } as RequestInit,
  );
  await unwrapBackend(response, 'Failed to revoke module service consent');
}

export async function issueProjectModuleServiceCapability(
  projectId: string,
  installationId: string,
  input: ModuleServiceCapabilityTokenRequest,
): Promise<ModuleServiceCapabilityTokenResponse> {
  const response = await backendApi.post<ModuleServiceCapabilityTokenResponse>(
    `${moduleServicePath(projectId, installationId)}/service-capabilities`,
    input,
  );
  return unwrapBackend(response, 'Failed to issue module service capability');
}
