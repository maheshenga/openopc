import {
  type OpenOpcModuleServiceName,
  type OpenOpcModuleServiceOperation,
  REGISTRY_MODULE_CAPABILITY_KINDS,
  REGISTRY_MODULE_CATEGORIES,
  REGISTRY_MODULE_EXECUTION_MODES,
  REGISTRY_MODULE_SCHEMA_VERSION,
  REGISTRY_MODULE_UI_SURFACES,
  REGISTRY_MODULE_VERIFICATION_PROFILES,
  type RegistryItem,
  type RegistryModuleManifest,
} from './schema';

export interface ModuleManifestValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ModuleManifestValidationResult {
  valid: boolean;
  issues: ModuleManifestValidationIssue[];
}

const MODULE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const PUBLISHER_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const DECLARATION_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@*-]{0,127}$/;
const SURFACE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'version',
  'publisher',
  'category',
  'locales',
  'compatibility',
  'execution',
  'verification',
  'capabilities',
  'permissions',
  'ui',
]);
const V3_TOP_LEVEL_KEYS = new Set([
  'schemaVersion',
  'id',
  'version',
  'publisher',
  'locales',
  'compatibility',
  'execution',
  'verification',
  'capabilities',
  'permissions',
  'ui',
  'openopc',
]);
const PUBLISHER_KEYS = new Set(['id', 'displayName']);
const COMPATIBILITY_KEYS = new Set(['platform', 'registry']);
const EXECUTION_KEYS = new Set(['mode', 'entry']);
const VERIFICATION_KEYS = new Set(['profile']);
const CAPABILITY_KEYS = new Set(['id', 'kind', 'inputSchema', 'outputSchema', 'assetKinds']);
const PERMISSION_KEYS = new Set([
  'actions',
  'secrets',
  'connectors',
  'network',
  'tools',
  'writes',
  'desktop',
]);
const UI_KEYS = new Set(['id', 'surface', 'entry']);
const OPENOPC_KEYS = new Set(['sdkApiVersion', 'catalog', 'services']);
const OPENOPC_CATALOG_KEYS = new Set(['labels']);
const OPENOPC_SERVICE_KEYS = new Set(['operations']);
const OPENOPC_LABEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const OPENOPC_SERVICE_OPERATIONS: Record<
  OpenOpcModuleServiceName,
  readonly OpenOpcModuleServiceOperation[]
> = {
  ai: ['models.read', 'text.generate', 'text.stream', 'image.generate'],
  payment: ['orders.create', 'orders.read', 'refunds.create'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function hasDuplicate(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

function isSafeRelativeEntry(value: string): boolean {
  if (!value || value.length > 256 || value.startsWith('/') || value.includes('\\')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  return !value.split('/').includes('..');
}

function isSafeNetworkOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return false;
    return (
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      value === url.origin
    );
  } catch {
    return false;
  }
}

export function validateRegistryModuleManifest(
  value: unknown,
  basePath = 'module',
): ModuleManifestValidationResult {
  const issues: ModuleManifestValidationIssue[] = [];
  const error = (path: string, message: string) =>
    issues.push({ severity: 'error', path, message });
  const rejectUnknownKeys = (
    record: Record<string, unknown>,
    allowed: Set<string>,
    path: string,
  ) => {
    for (const key of Object.keys(record)) {
      if (!allowed.has(key)) error(`${path}.${key}`, 'unknown field');
    }
  };

  if (!isRecord(value)) {
    error(basePath, 'module manifest must be an object');
    return { valid: false, issues };
  }
  const isV3 = value.schemaVersion === 3;
  rejectUnknownKeys(value, isV3 ? V3_TOP_LEVEL_KEYS : TOP_LEVEL_KEYS, basePath);

  if (value.schemaVersion !== REGISTRY_MODULE_SCHEMA_VERSION && value.schemaVersion !== 3) {
    error(`${basePath}.schemaVersion`, `schemaVersion must be ${REGISTRY_MODULE_SCHEMA_VERSION}`);
  }

  const moduleId = typeof value.id === 'string' ? value.id : '';
  if (!MODULE_ID_RE.test(moduleId) || moduleId.length > 128) {
    error(`${basePath}.id`, 'id must be a namespaced lowercase module identifier');
  }
  if (typeof value.version !== 'string' || !SEMVER_RE.test(value.version)) {
    error(`${basePath}.version`, 'version must be a semantic version');
  }
  if (!isV3 && !isOneOf(REGISTRY_MODULE_CATEGORIES, value.category)) {
    error(
      `${basePath}.category`,
      `category must be one of: ${REGISTRY_MODULE_CATEGORIES.join(', ')}`,
    );
  }

  if (!isRecord(value.publisher)) {
    error(`${basePath}.publisher`, 'publisher must be an object');
  } else {
    rejectUnknownKeys(value.publisher, PUBLISHER_KEYS, `${basePath}.publisher`);
    if (typeof value.publisher.id !== 'string' || !PUBLISHER_ID_RE.test(value.publisher.id)) {
      error(`${basePath}.publisher.id`, 'publisher.id must be a lowercase slug');
    }
    if (
      value.publisher.displayName !== undefined &&
      (typeof value.publisher.displayName !== 'string' || !value.publisher.displayName.trim())
    ) {
      error(
        `${basePath}.publisher.displayName`,
        'publisher.displayName must be a non-empty string',
      );
    }
  }

  if (!Array.isArray(value.locales) || value.locales.length === 0) {
    error(`${basePath}.locales`, 'locales must be a non-empty array');
  } else {
    const locales: string[] = [];
    value.locales.forEach((locale, index) => {
      if (typeof locale !== 'string' || !LOCALE_RE.test(locale)) {
        error(`${basePath}.locales[${index}]`, 'locale must be a BCP 47 language tag');
      } else {
        locales.push(locale);
      }
    });
    if (hasDuplicate(locales)) error(`${basePath}.locales`, 'duplicate locale');
  }

  if (!isRecord(value.compatibility)) {
    error(`${basePath}.compatibility`, 'compatibility must be an object');
  } else {
    rejectUnknownKeys(value.compatibility, COMPATIBILITY_KEYS, `${basePath}.compatibility`);
    for (const key of ['platform', 'registry'] as const) {
      const range = value.compatibility[key];
      if (key === 'registry' && range === undefined) continue;
      if (typeof range !== 'string' || !range.trim() || range.length > 128) {
        error(`${basePath}.compatibility.${key}`, `${key} compatibility must be a bounded range`);
      }
    }
  }

  let executionMode = '';
  if (!isRecord(value.execution)) {
    error(`${basePath}.execution`, 'execution must be an object');
  } else {
    rejectUnknownKeys(value.execution, EXECUTION_KEYS, `${basePath}.execution`);
    executionMode = typeof value.execution.mode === 'string' ? value.execution.mode : '';
    if (!isOneOf(REGISTRY_MODULE_EXECUTION_MODES, executionMode)) {
      error(
        `${basePath}.execution.mode`,
        `execution.mode must be one of: ${REGISTRY_MODULE_EXECUTION_MODES.join(', ')}`,
      );
    }
    const entry = value.execution.entry;
    const entryRequired = ['sandboxed-web', 'server-adapter', 'desktop-native'].includes(
      executionMode,
    );
    if (entryRequired && typeof entry !== 'string') {
      error(`${basePath}.execution.entry`, `execution.entry is required for ${executionMode}`);
    } else if (entry !== undefined && (typeof entry !== 'string' || !isSafeRelativeEntry(entry))) {
      error(`${basePath}.execution.entry`, 'execution.entry must be a safe relative package path');
    }
  }

  const requiredVerificationProfile = {
    declarative: 'declarative',
    agent: 'agent-project',
    'sandboxed-web': 'sandboxed-web',
    'server-adapter': 'server-conformance',
    'desktop-native': 'desktop-package',
  }[executionMode];
  if (value.verification === undefined && executionMode !== 'declarative') {
    error(
      `${basePath}.verification`,
      `verification is required for ${executionMode || 'an executable module'}`,
    );
  } else if (value.verification !== undefined) {
    if (!isRecord(value.verification)) {
      error(`${basePath}.verification`, 'verification must be an object');
    } else {
      rejectUnknownKeys(value.verification, VERIFICATION_KEYS, `${basePath}.verification`);
      if (!isOneOf(REGISTRY_MODULE_VERIFICATION_PROFILES, value.verification.profile)) {
        error(
          `${basePath}.verification.profile`,
          `verification.profile must be one of: ${REGISTRY_MODULE_VERIFICATION_PROFILES.join(', ')}`,
        );
      } else if (
        requiredVerificationProfile &&
        value.verification.profile !== requiredVerificationProfile
      ) {
        error(
          `${basePath}.verification.profile`,
          `verification.profile must be ${requiredVerificationProfile} for ${executionMode}`,
        );
      }
    }
  }

  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities)) {
      error(`${basePath}.capabilities`, 'capabilities must be an array');
    } else {
      const ids: string[] = [];
      value.capabilities.forEach((capability, index) => {
        const path = `${basePath}.capabilities[${index}]`;
        if (!isRecord(capability)) {
          error(path, 'capability must be an object');
          return;
        }
        rejectUnknownKeys(capability, CAPABILITY_KEYS, path);
        const id = typeof capability.id === 'string' ? capability.id : '';
        if (!moduleId || !id.startsWith(`${moduleId}.`) || !MODULE_ID_RE.test(id)) {
          error(`${path}.id`, 'capability id must use the module-owned namespace');
        } else {
          ids.push(id);
        }
        if (!isOneOf(REGISTRY_MODULE_CAPABILITY_KINDS, capability.kind)) {
          error(
            `${path}.kind`,
            `capability kind must be one of: ${REGISTRY_MODULE_CAPABILITY_KINDS.join(', ')}`,
          );
        }
        for (const key of ['inputSchema', 'outputSchema'] as const) {
          if (capability[key] !== undefined && !isRecord(capability[key])) {
            error(`${path}.${key}`, `${key} must be a JSON Schema object`);
          }
        }
        if (capability.assetKinds !== undefined) {
          if (!Array.isArray(capability.assetKinds)) {
            error(`${path}.assetKinds`, 'assetKinds must be an array');
          } else {
            const kinds = capability.assetKinds.filter(
              (kind): kind is string => typeof kind === 'string',
            );
            capability.assetKinds.forEach((kind, kindIndex) => {
              if (typeof kind !== 'string' || !kind.trim() || kind.length > 128) {
                error(`${path}.assetKinds[${kindIndex}]`, 'asset kind must be a bounded string');
              }
            });
            if (hasDuplicate(kinds)) error(`${path}.assetKinds`, 'duplicate asset kind');
          }
        }
      });
      if (hasDuplicate(ids)) error(`${basePath}.capabilities`, 'duplicate capability id');
    }
  }

  if (value.permissions !== undefined) {
    if (!isRecord(value.permissions)) {
      error(`${basePath}.permissions`, 'permissions must be an object');
    } else {
      rejectUnknownKeys(value.permissions, PERMISSION_KEYS, `${basePath}.permissions`);
      for (const key of PERMISSION_KEYS) {
        const list = value.permissions[key];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          error(`${basePath}.permissions.${key}`, `${key} must be an array`);
          continue;
        }
        const validValues: string[] = [];
        list.forEach((entry, index) => {
          const valid =
            typeof entry === 'string' &&
            (key === 'network' ? isSafeNetworkOrigin(entry) : DECLARATION_TOKEN_RE.test(entry));
          if (!valid) {
            error(
              `${basePath}.permissions.${key}[${index}]`,
              key === 'network'
                ? 'network permission must be a credential-free HTTPS origin'
                : 'permission must be a bounded declaration token, never a value',
            );
          } else {
            validValues.push(entry as string);
          }
        });
        if (hasDuplicate(validValues)) {
          error(`${basePath}.permissions.${key}`, `duplicate ${key} permission`);
        }
      }
    }
  }

  if (value.ui !== undefined) {
    if (!Array.isArray(value.ui)) {
      error(`${basePath}.ui`, 'ui must be an array');
    } else {
      const ids: string[] = [];
      value.ui.forEach((surface, index) => {
        const path = `${basePath}.ui[${index}]`;
        if (!isRecord(surface)) {
          error(path, 'UI surface must be an object');
          return;
        }
        rejectUnknownKeys(surface, UI_KEYS, path);
        if (typeof surface.id !== 'string' || !SURFACE_ID_RE.test(surface.id)) {
          error(`${path}.id`, 'UI surface id must be a lowercase slug');
        } else {
          ids.push(surface.id);
        }
        if (!isOneOf(REGISTRY_MODULE_UI_SURFACES, surface.surface)) {
          error(
            `${path}.surface`,
            `surface must be one of: ${REGISTRY_MODULE_UI_SURFACES.join(', ')}`,
          );
        }
        if (
          surface.entry !== undefined &&
          (typeof surface.entry !== 'string' || !isSafeRelativeEntry(surface.entry))
        ) {
          error(`${path}.entry`, 'UI entry must be a safe relative package path');
        }
      });
      if (hasDuplicate(ids)) error(`${basePath}.ui`, 'duplicate UI surface id');
    }
  }

  if (isV3) {
    const openopc = value.openopc;
    if (!isRecord(openopc)) {
      error(`${basePath}.openopc`, 'openopc must be an object');
    } else {
      rejectUnknownKeys(openopc, OPENOPC_KEYS, `${basePath}.openopc`);
      if (openopc.sdkApiVersion !== 'v1') {
        error(`${basePath}.openopc.sdkApiVersion`, 'sdkApiVersion must be v1');
      }

      if (openopc.catalog !== undefined) {
        if (!isRecord(openopc.catalog)) {
          error(`${basePath}.openopc.catalog`, 'catalog must be an object');
        } else {
          rejectUnknownKeys(openopc.catalog, OPENOPC_CATALOG_KEYS, `${basePath}.openopc.catalog`);
          const labels = openopc.catalog.labels;
          if (!Array.isArray(labels)) {
            error(`${basePath}.openopc.catalog.labels`, 'labels must be an array');
          } else {
            const validLabels: string[] = [];
            labels.forEach((label, index) => {
              if (typeof label !== 'string' || !OPENOPC_LABEL_RE.test(label)) {
                error(
                  `${basePath}.openopc.catalog.labels[${index}]`,
                  'label must be lowercase ASCII slug',
                );
              } else {
                validLabels.push(label);
              }
            });
            if (labels.length > 12) {
              error(`${basePath}.openopc.catalog.labels`, 'labels must contain at most 12 values');
            }
            if (hasDuplicate(validLabels)) {
              error(`${basePath}.openopc.catalog.labels`, 'duplicate label');
            }
            if (
              validLabels.some((label, index) => {
                const previous = validLabels[index - 1];
                return previous !== undefined && label < previous;
              })
            ) {
              error(`${basePath}.openopc.catalog.labels`, 'labels must be sorted');
            }
          }
        }
      }

      if (openopc.services !== undefined) {
        if (!isRecord(openopc.services)) {
          error(`${basePath}.openopc.services`, 'services must be an object');
        } else {
          for (const serviceName of Object.keys(openopc.services)) {
            if (!Object.hasOwn(OPENOPC_SERVICE_OPERATIONS, serviceName)) {
              error(`${basePath}.openopc.services.${serviceName}`, 'unknown field');
              continue;
            }
            const declaration = openopc.services[serviceName];
            const servicePath = `${basePath}.openopc.services.${serviceName}`;
            if (!isRecord(declaration)) {
              error(servicePath, 'service declaration must be an object');
              continue;
            }
            rejectUnknownKeys(declaration, OPENOPC_SERVICE_KEYS, servicePath);
            const operations = declaration.operations;
            if (!Array.isArray(operations) || operations.length === 0) {
              error(`${servicePath}.operations`, 'operations must be a non-empty array');
              continue;
            }
            const validOperations: string[] = [];
            const allowed = OPENOPC_SERVICE_OPERATIONS[serviceName as OpenOpcModuleServiceName];
            operations.forEach((operation, index) => {
              if (
                typeof operation !== 'string' ||
                !allowed.includes(operation as OpenOpcModuleServiceOperation)
              ) {
                error(
                  `${servicePath}.operations[${index}]`,
                  'operation is not allowed for service',
                );
              } else {
                validOperations.push(operation);
              }
            });
            if (hasDuplicate(validOperations)) {
              error(`${servicePath}.operations`, 'duplicate operation');
            }
            if (
              validOperations.some((operation, index) => {
                const previous = validOperations[index - 1];
                return previous !== undefined && operation < previous;
              })
            ) {
              error(`${servicePath}.operations`, 'operations must be sorted');
            }
          }
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function moduleCatalogLabels(manifest: RegistryModuleManifest): string[] {
  if (manifest.schemaVersion === REGISTRY_MODULE_SCHEMA_VERSION) return [manifest.category];
  return [...(manifest.openopc.catalog?.labels ?? [])];
}

export function moduleServiceOperations(
  manifest: RegistryModuleManifest,
  service: OpenOpcModuleServiceName,
): readonly OpenOpcModuleServiceOperation[] {
  if (manifest.schemaVersion === REGISTRY_MODULE_SCHEMA_VERSION) return [];
  const operations = manifest.openopc.services?.[service]?.operations;
  return operations ? Object.freeze([...operations]) : [];
}

export function readRegistryModuleManifest(item: unknown): RegistryModuleManifest | null {
  if (!isRecord(item) || item.type !== 'registry:module') return null;
  const result = validateRegistryModuleManifest(item.module);
  return result.valid ? (item.module as RegistryModuleManifest) : null;
}

export function hasRegistryModuleManifest(item: RegistryItem): boolean {
  return readRegistryModuleManifest(item) !== null;
}
