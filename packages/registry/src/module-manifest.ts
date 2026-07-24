import {
  REGISTRY_MODULE_CAPABILITY_KINDS,
  REGISTRY_MODULE_CATEGORIES,
  REGISTRY_MODULE_EXECUTION_MODES,
  REGISTRY_MODULE_SCHEMA_VERSION,
  REGISTRY_MODULE_UI_SURFACES,
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
  'capabilities',
  'permissions',
  'ui',
]);
const PUBLISHER_KEYS = new Set(['id', 'displayName']);
const COMPATIBILITY_KEYS = new Set(['platform', 'registry']);
const EXECUTION_KEYS = new Set(['mode', 'entry']);
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
  rejectUnknownKeys(value, TOP_LEVEL_KEYS, basePath);

  if (value.schemaVersion !== REGISTRY_MODULE_SCHEMA_VERSION) {
    error(`${basePath}.schemaVersion`, `schemaVersion must be ${REGISTRY_MODULE_SCHEMA_VERSION}`);
  }

  const moduleId = typeof value.id === 'string' ? value.id : '';
  if (!MODULE_ID_RE.test(moduleId) || moduleId.length > 128) {
    error(`${basePath}.id`, 'id must be a namespaced lowercase module identifier');
  }
  if (typeof value.version !== 'string' || !SEMVER_RE.test(value.version)) {
    error(`${basePath}.version`, 'version must be a semantic version');
  }
  if (!isOneOf(REGISTRY_MODULE_CATEGORIES, value.category)) {
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

  return { valid: issues.length === 0, issues };
}

export function readRegistryModuleManifest(item: unknown): RegistryModuleManifest | null {
  if (!isRecord(item) || item.type !== 'registry:module') return null;
  const result = validateRegistryModuleManifest(item.module);
  return result.valid ? (item.module as RegistryModuleManifest) : null;
}

export function hasRegistryModuleManifest(item: RegistryItem): boolean {
  return readRegistryModuleManifest(item) !== null;
}
