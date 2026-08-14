import {
  type ModuleServiceCapabilityClaimsV1,
  type ModuleServiceErrorCode,
  OpenOpcEffectiveModuleSettingsSchema,
  OpenOpcModuleSettingKeySchema,
  type OpenOpcModuleSettingValue,
  OpenOpcModuleSettingValuesSchema,
  OpenOpcModuleSettingsPutInputSchema,
} from '@kortix/api-contract';
import type {
  RegistryOpenOpcSettingField,
  RegistryOpenOpcSettingsDeclaration,
} from '@kortix/registry';
import type { Context } from 'hono';

import { PROJECT_ACTIONS } from '../iam/actions';
import { makeOpenApiApp } from '../openapi';
import type { AppEnv } from '../types';
import { ModuleServiceCapabilityError } from './capability-grants';
import { requireModuleServiceOperation } from './service-auth';

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 503;
type SettingsClaims = Extract<ModuleServiceCapabilityClaimsV1, { service: 'settings' }>;
type SettingsValues = Record<string, OpenOpcModuleSettingValue>;
type Scope = { accountId: string; projectId: string; installationId: string };

export interface ModuleSettingsRepository {
  loadDefinition(scope: Scope): Promise<RegistryOpenOpcSettingsDeclaration | null>;
  readValues(scope: Scope): Promise<{ revision: number; values: Record<string, unknown> }>;
  replaceValues(
    input: Scope & {
      actorUserId: string;
      expectedRevision: number;
      values: SettingsValues;
    },
  ): Promise<{ revision: number; values: Record<string, unknown> }>;
}

export class ModuleSettingsError extends Error {
  readonly name = 'ModuleSettingsError';

  constructor(
    readonly code: Extract<
      ModuleServiceErrorCode,
      'MODULE_SETTINGS_INVALID' | 'MODULE_SETTINGS_STORAGE_UNAVAILABLE' | 'MODULE_SERVICE_CONFLICT'
    >,
    readonly status: ErrorStatus,
  ) {
    super(code);
  }
}

export interface ModuleSettingsScope extends Scope {}

export interface ModuleSettingsServiceDependencies {
  repository: ModuleSettingsRepository;
  now?: () => Date;
}

function scopeFromClaims(claims: SettingsClaims): Scope {
  return {
    accountId: claims.accountId,
    projectId: claims.projectId,
    installationId: claims.installationId,
  };
}

function fieldMap(
  definition: RegistryOpenOpcSettingsDeclaration,
): Map<string, RegistryOpenOpcSettingField> {
  return new Map(definition.fields.map((field) => [field.key, field]));
}

function valueMatchesField(
  field: RegistryOpenOpcSettingField,
  value: unknown,
): value is OpenOpcModuleSettingValue {
  if (!OpenOpcModuleSettingKeySchema.safeParse(field.key).success) return false;
  if (value === null) return true;
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (field.min === undefined || value >= field.min) &&
        (field.max === undefined || value <= field.max)
      );
    case 'select':
    case 'model-select':
      return (
        typeof value === 'string' &&
        field.options?.some((option) => option.value === value) === true
      );
    case 'text':
    case 'textarea':
      return typeof value === 'string';
    default:
      return false;
  }
}

function validateValues(
  definition: RegistryOpenOpcSettingsDeclaration,
  values: Record<string, unknown>,
): SettingsValues {
  const parsed = OpenOpcModuleSettingValuesSchema.safeParse(values);
  if (!parsed.success) throw new ModuleSettingsError('MODULE_SETTINGS_INVALID', 400);
  const fields = fieldMap(definition);
  const output: SettingsValues = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    const field = fields.get(key);
    if (!field || !valueMatchesField(field, value)) {
      throw new ModuleSettingsError('MODULE_SETTINGS_INVALID', 400);
    }
    output[key] = value;
  }
  for (const field of definition.fields) {
    if (field.required && output[field.key] === undefined && field.default === undefined) {
      throw new ModuleSettingsError('MODULE_SETTINGS_INVALID', 400);
    }
  }
  return output;
}

function effectiveValues(
  definition: RegistryOpenOpcSettingsDeclaration,
  stored: Record<string, unknown>,
): SettingsValues {
  const values: SettingsValues = {};
  const fields = fieldMap(definition);
  for (const field of definition.fields) {
    const candidate = stored[field.key];
    if (candidate !== undefined && valueMatchesField(field, candidate)) {
      values[field.key] = candidate;
    } else if (field.default !== undefined && valueMatchesField(field, field.default)) {
      values[field.key] = field.default;
    }
  }
  // The map lookup above intentionally filters any stale or undeclared row.
  void fields;
  return values;
}

export class ModuleSettingsService {
  private readonly repository: ModuleSettingsRepository;
  private readonly now: () => Date;

  constructor(dependencies: ModuleSettingsServiceDependencies) {
    this.repository = dependencies.repository;
    this.now = dependencies.now ?? (() => new Date());
  }

  async read(scope: ModuleSettingsScope) {
    const definition = await this.repository.loadDefinition(scope);
    if (!definition) throw new ModuleSettingsError('MODULE_SETTINGS_INVALID', 404);
    const stored = await this.repository.readValues(scope);
    const values = effectiveValues(definition, stored.values);
    return OpenOpcEffectiveModuleSettingsSchema.parse({
      schema_version: 1,
      revision: stored.revision,
      values,
      loaded_at: this.now().toISOString(),
    });
  }

  async replace(
    input: ModuleSettingsScope & {
      actorUserId: string;
      expectedRevision: number;
      values: Record<string, unknown>;
    },
  ) {
    const definition = await this.repository.loadDefinition(input);
    if (!definition) throw new ModuleSettingsError('MODULE_SETTINGS_INVALID', 404);
    const values = validateValues(definition, input.values);
    const stored = await this.repository.replaceValues({ ...input, values });
    return OpenOpcEffectiveModuleSettingsSchema.parse({
      schema_version: 1,
      revision: stored.revision,
      values: effectiveValues(definition, stored.values),
      loaded_at: this.now().toISOString(),
    });
  }
}

export interface ModuleSettingsRouteDependencies {
  requireCapability(
    authorization: string | undefined,
    operation: 'settings.read',
  ): Promise<SettingsClaims>;
  service: Pick<ModuleSettingsService, 'read'>;
}

function errorResponse(
  context: { json(payload: { error: string }, status: ErrorStatus): Response },
  error: unknown,
) {
  if (error instanceof ModuleSettingsError || error instanceof ModuleServiceCapabilityError) {
    return context.json({ error: error.code }, error.status as ErrorStatus);
  }
  return context.json({ error: 'MODULE_SETTINGS_STORAGE_UNAVAILABLE' }, 503);
}

export function createModuleSettingsRoutes(dependencies: ModuleSettingsRouteDependencies) {
  const app = makeOpenApiApp<AppEnv>();
  app.get('/', async (context) => {
    try {
      const claims = await dependencies.requireCapability(
        context.req.header('authorization'),
        'settings.read',
      );
      return context.json(await dependencies.service.read(scopeFromClaims(claims)), 200);
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  return app;
}

type LoadedProject = { row: { accountId: string; projectId: string }; userId: string };
type LoadProjectForUser = (
  context: Context<AppEnv>,
  projectId: string,
  action: 'read' | 'write' | 'session' | 'manage',
) => Promise<LoadedProject | null>;
type AssertProjectCapability = (
  context: Context<AppEnv>,
  userId: string,
  accountId: string,
  projectId: string,
  action: string,
) => Promise<void>;

export interface ModuleSettingsProjectRouteDependencies {
  loadProjectForUser: LoadProjectForUser;
  assertProjectCapability: AssertProjectCapability;
  service: Pick<ModuleSettingsService, 'read' | 'replace'>;
}

export function createModuleSettingsProjectRoutes(
  dependencies: ModuleSettingsProjectRouteDependencies,
) {
  const app = makeOpenApiApp<AppEnv>();
  const params = (context: Context<AppEnv>) => ({
    projectId: context.req.param('projectId') ?? '',
    installationId: context.req.param('installationId') ?? '',
  });

  async function load(context: Context<AppEnv>) {
    const { projectId } = params(context);
    const loaded = await dependencies.loadProjectForUser(context, projectId, 'read');
    if (!loaded) return context.json({ error: 'Not found' }, 404) as Response;
    await dependencies.assertProjectCapability(
      context,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_READ,
    );
    return loaded;
  }

  app.get('/:projectId/modules/:installationId/settings', async (context) => {
    const loaded = await load(context);
    if (loaded instanceof Response) return loaded;
    const { projectId, installationId } = params(context);
    try {
      return context.json(
        await dependencies.service.read({
          accountId: loaded.row.accountId,
          projectId,
          installationId,
        }),
        200,
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  app.put('/:projectId/modules/:installationId/settings', async (context) => {
    const { projectId, installationId } = params(context);
    const loaded = await dependencies.loadProjectForUser(context, projectId, 'read');
    if (!loaded) return context.json({ error: 'Not found' }, 404);
    await dependencies.assertProjectCapability(
      context,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE,
    );
    let body: unknown;
    try {
      const raw = await context.req.text();
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = null;
    }
    const parsed = OpenOpcModuleSettingsPutInputSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'MODULE_SETTINGS_INVALID' }, 400);
    try {
      return context.json(
        await dependencies.service.replace({
          accountId: loaded.row.accountId,
          projectId,
          installationId,
          actorUserId: loaded.userId,
          expectedRevision: parsed.data.expected_revision,
          values: parsed.data.values,
        }),
        200,
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });

  return app;
}
