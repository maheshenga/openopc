import {
  type ProjectModuleInstallation,
  type ProjectModuleInstallationEvent,
  type ProjectModuleInstallationTransition,
  type ProjectModuleLaunchDescriptor,
  type ProjectModuleMutationOptions,
  backendApi,
  getMarketplaceCatalogItem,
  getProjectModuleLaunch,
  installProjectModule,
  listMarketplaceCatalogItems,
  listProjectModuleInstallationHistory,
  listProjectModules,
  rollbackProjectModule,
  updateProjectModule,
} from '@kortix/sdk';
import {
  OPENOPC_AI_SERVICE_OPERATIONS,
  OPENOPC_DATA_SERVICE_OPERATIONS,
  OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  OPENOPC_SETTINGS_SERVICE_OPERATIONS,
  type OpenOpcAiServiceOperation as SdkOpenOpcAiServiceOperation,
  type OpenOpcDataServiceOperation as SdkOpenOpcDataServiceOperation,
  type OpenOpcPaymentServiceOperation as SdkOpenOpcPaymentServiceOperation,
  type OpenOpcServiceName as SdkOpenOpcServiceName,
  type OpenOpcServiceOperation as SdkOpenOpcServiceOperation,
  type OpenOpcSettingsServiceOperation as SdkOpenOpcSettingsServiceOperation,
} from '@openopc/developer-sdk';

export type OpenOpcServiceName = SdkOpenOpcServiceName;
export type OpenOpcAiServiceOperation = SdkOpenOpcAiServiceOperation;
export type OpenOpcPaymentServiceOperation = SdkOpenOpcPaymentServiceOperation;
export type OpenOpcDataServiceOperation = SdkOpenOpcDataServiceOperation;
export type OpenOpcSettingsServiceOperation = SdkOpenOpcSettingsServiceOperation;
export type OpenOpcServiceOperation = SdkOpenOpcServiceOperation;

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

export type ModuleSettingValue = string | number | boolean | null;
export type ModuleSettingFieldType =
  | 'boolean'
  | 'number'
  | 'select'
  | 'model-select'
  | 'text'
  | 'textarea';

export interface ModuleSettingOption {
  value: string;
  label: string;
}

export interface ModuleSettingField {
  key: string;
  label: string;
  type: ModuleSettingFieldType;
  description?: string;
  default?: ModuleSettingValue;
  required?: boolean;
  min?: number;
  max?: number;
  options?: ModuleSettingOption[];
}

export interface ModuleSettingsDefinition {
  fields: ModuleSettingField[];
}

export interface EffectiveModuleSettings {
  schema_version: 1;
  revision: number;
  values: Record<string, ModuleSettingValue>;
  loaded_at: string;
}

const SERVICE_OPERATIONS: Record<OpenOpcServiceName, readonly OpenOpcServiceOperation[]> = {
  ai: OPENOPC_AI_SERVICE_OPERATIONS,
  payment: OPENOPC_PAYMENT_SERVICE_OPERATIONS,
  data: OPENOPC_DATA_SERVICE_OPERATIONS,
  settings: OPENOPC_SETTINGS_SERVICE_OPERATIONS,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSandboxedWebModuleManifest(manifest: unknown): boolean {
  return (
    isRecord(manifest) &&
    manifest.schemaVersion === 3 &&
    isRecord(manifest.execution) &&
    manifest.execution.mode === 'sandboxed-web' &&
    typeof manifest.execution.entry === 'string'
  );
}

/** Read only the signed v3 service declarations; malformed or legacy manifests fail closed. */
export function moduleServiceDeclarations(manifest: unknown): ModuleServiceDeclaration[] {
  if (!isRecord(manifest) || manifest.schemaVersion !== 3 || !isRecord(manifest.openopc)) return [];
  if (manifest.openopc.sdkApiVersion !== 'v1' || !isRecord(manifest.openopc.services)) return [];

  const declarations: ModuleServiceDeclaration[] = [];
  for (const service of ['ai', 'payment', 'data', 'settings'] as const) {
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

const MODULE_SETTING_TYPES = new Set<ModuleSettingFieldType>([
  'boolean',
  'number',
  'select',
  'model-select',
  'text',
  'textarea',
]);
const SENSITIVE_SETTING_KEY =
  /(^|[._-])(api[_-]?key|token|secret|password|credential|authorization|cookie|provider|base[_-]?url|endpoint)([._-]|$)/i;

function settingField(value: unknown): ModuleSettingField | null {
  if (!isRecord(value)) return null;
  const allowedKeys = new Set([
    'key',
    'label',
    'type',
    'description',
    'default',
    'required',
    'min',
    'max',
    'options',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return null;
  const key = value.key;
  const label = value.label;
  const type = value.type;
  if (
    typeof key !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,63}$/.test(key) ||
    SENSITIVE_SETTING_KEY.test(key) ||
    typeof label !== 'string' ||
    label.trim().length === 0 ||
    label.length > 120 ||
    typeof type !== 'string' ||
    !MODULE_SETTING_TYPES.has(type as ModuleSettingFieldType)
  ) {
    return null;
  }
  if (
    value.description !== undefined &&
    (typeof value.description !== 'string' || value.description.length > 500)
  ) {
    return null;
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    return null;
  }
  const defaultValue = value.default;
  if (
    defaultValue !== undefined &&
    defaultValue !== null &&
    !['string', 'number', 'boolean'].includes(typeof defaultValue)
  ) {
    return null;
  }
  if (
    (value.min !== undefined && (typeof value.min !== 'number' || !Number.isFinite(value.min))) ||
    (value.max !== undefined && (typeof value.max !== 'number' || !Number.isFinite(value.max))) ||
    (typeof value.min === 'number' && typeof value.max === 'number' && value.min > value.max)
  ) {
    return null;
  }
  const fieldType = type as ModuleSettingFieldType;
  let options: ModuleSettingOption[] | undefined;
  if (fieldType === 'select' || fieldType === 'model-select') {
    if (!Array.isArray(value.options) || value.options.length === 0 || value.options.length > 128) {
      return null;
    }
    options = [];
    const seen = new Set<string>();
    for (const option of value.options) {
      if (
        !isRecord(option) ||
        Object.keys(option).sort().join(',') !== 'label,value' ||
        typeof option.value !== 'string' ||
        !option.value ||
        option.value.length > 256 ||
        typeof option.label !== 'string' ||
        !option.label ||
        option.label.length > 120 ||
        seen.has(option.value)
      ) {
        return null;
      }
      seen.add(option.value);
      options.push({ value: option.value, label: option.label });
    }
    if (defaultValue !== undefined && defaultValue !== null && !seen.has(String(defaultValue))) {
      return null;
    }
  } else if (value.options !== undefined) {
    return null;
  }
  if (fieldType === 'boolean' && defaultValue !== undefined && typeof defaultValue !== 'boolean') {
    return null;
  }
  if (
    fieldType === 'number' &&
    defaultValue !== undefined &&
    (typeof defaultValue !== 'number' ||
      !Number.isFinite(defaultValue) ||
      (typeof value.min === 'number' && defaultValue < value.min) ||
      (typeof value.max === 'number' && defaultValue > value.max))
  ) {
    return null;
  }
  if (
    (fieldType === 'text' || fieldType === 'textarea') &&
    defaultValue !== undefined &&
    defaultValue !== null &&
    typeof defaultValue !== 'string'
  ) {
    return null;
  }
  return {
    key,
    label,
    type: fieldType,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue as ModuleSettingValue } : {}),
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
    ...(typeof value.min === 'number' ? { min: value.min } : {}),
    ...(typeof value.max === 'number' ? { max: value.max } : {}),
    ...(options ? { options } : {}),
  };
}

/** Read only non-sensitive settings declared by the signed v3 manifest. */
export function moduleSettingsDefinition(manifest: unknown): ModuleSettingsDefinition | null {
  if (!isRecord(manifest) || manifest.schemaVersion !== 3 || !isRecord(manifest.openopc)) {
    return null;
  }
  if (manifest.openopc.sdkApiVersion !== 'v1' || !isRecord(manifest.openopc.settings)) {
    return null;
  }
  const rawFields = manifest.openopc.settings.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0 || rawFields.length > 128) return null;
  const fields = rawFields.map(settingField);
  if (fields.some((field) => field === null)) return null;
  const typed = fields as ModuleSettingField[];
  const keys = typed.map((field) => field.key);
  if (new Set(keys).size !== keys.length || [...keys].sort().join('\0') !== keys.join('\0')) {
    return null;
  }
  return { fields: structuredClone(typed) };
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

export function getProjectModuleLaunchDescriptor(
  projectId: string,
  installationId: string,
): Promise<ProjectModuleLaunchDescriptor> {
  return getProjectModuleLaunch(projectId, installationId);
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

export async function getPublishedProjectModuleRelease(
  releaseId: string,
): Promise<PublishedProjectModuleRelease> {
  const release = asPublishedRelease(
    await getMarketplaceCatalogItem(`openopc-module:${releaseId}`),
  );
  if (!release || release.release_id !== releaseId) {
    throw new Error('Published project module release is unavailable');
  }
  return release;
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

function isEffectiveModuleSettings(value: unknown): value is EffectiveModuleSettings {
  if (!isRecord(value) || value.schema_version !== 1 || !Number.isSafeInteger(value.revision)) {
    return false;
  }
  if (typeof value.loaded_at !== 'string' || !Number.isFinite(Date.parse(value.loaded_at))) {
    return false;
  }
  if (!isRecord(value.values) || Object.keys(value.values).length > 128) return false;
  return Object.entries(value.values).every(
    ([key, settingValue]) =>
      /^[a-z][a-z0-9_.-]{0,63}$/.test(key) &&
      !SENSITIVE_SETTING_KEY.test(key) &&
      (settingValue === null || ['string', 'number', 'boolean'].includes(typeof settingValue)),
  );
}

export async function getProjectModuleSettings(
  projectId: string,
  installationId: string,
  signal?: AbortSignal,
): Promise<EffectiveModuleSettings> {
  const response = await backendApi.get<EffectiveModuleSettings>(
    `${moduleServicePath(projectId, installationId)}/settings`,
    { signal },
  );
  const value = await unwrapBackend(response, 'Failed to read module settings');
  if (!isEffectiveModuleSettings(value)) throw new Error('Module settings response is invalid');
  return value;
}

export async function updateProjectModuleSettings(
  projectId: string,
  installationId: string,
  input: { expected_revision: number; values: Record<string, ModuleSettingValue> },
  signal?: AbortSignal,
): Promise<EffectiveModuleSettings> {
  const response = await backendApi.put<EffectiveModuleSettings>(
    `${moduleServicePath(projectId, installationId)}/settings`,
    input,
    { signal },
  );
  const value = await unwrapBackend(response, 'Failed to update module settings');
  if (!isEffectiveModuleSettings(value)) throw new Error('Module settings response is invalid');
  return value;
}
