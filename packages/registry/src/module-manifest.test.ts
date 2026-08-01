import { describe, expect, test } from 'bun:test';

import {
  moduleCatalogLabels,
  moduleServiceOperations,
  readRegistryModuleManifest,
  validateRegistryModuleManifest,
} from './module-manifest';
import type { RegistryModuleManifest } from './schema';
import { validateRegistry } from './validate';

const validModuleItem = () => ({
  name: 'recruiting-workbench',
  type: 'registry:module',
  title: 'Recruiting Workbench',
  module: {
    schemaVersion: 2,
    id: 'acme.recruiting',
    version: '1.2.0',
    publisher: { id: 'acme', displayName: 'Acme' },
    category: 'industry',
    locales: ['en', 'zh-CN'],
    compatibility: { platform: '^1.0.0' },
    execution: { mode: 'declarative' },
    capabilities: [
      {
        id: 'acme.recruiting.candidate-score',
        kind: 'task',
        inputSchema: { type: 'object', required: ['candidateId'] },
        outputSchema: { type: 'object', required: ['score'] },
        assetKinds: ['application/json'],
      },
    ],
    permissions: {
      actions: ['project.intelligence.tasks.create'],
      secrets: ['RECRUITING_MODEL_API_KEY'],
      connectors: ['ats'],
      network: ['https://api.example.com'],
      tools: ['web_search'],
      writes: ['artifacts/recruiting/*'],
    },
    ui: [{ id: 'candidate-review', surface: 'page' }],
  },
});

const validV3Module = () => ({
  schemaVersion: 3,
  id: 'example.weather-station',
  version: '1.2.3',
  publisher: { id: 'example-publisher' },
  locales: ['zh-CN'],
  compatibility: { platform: '>=1.0.0', registry: '>=3.0.0' },
  execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
  verification: { profile: 'sandboxed-web' },
  capabilities: [{ id: 'example.weather-station.forecast', kind: 'ui' }],
  openopc: {
    sdkApiVersion: 'v1',
    catalog: { labels: ['h5', 'weather'] },
    services: {
      ai: { operations: ['models.read', 'text.generate', 'text.stream'] },
      payment: { operations: ['orders.create', 'orders.read', 'refunds.create'] },
    },
  },
});

describe('registry module manifest', () => {
  test('accepts v3 services without changing capability ownership and exposes catalog helpers', () => {
    const module = validV3Module();

    expect(validateRegistryModuleManifest(module)).toEqual({ valid: true, issues: [] });
    expect(module.capabilities).toEqual([{ id: 'example.weather-station.forecast', kind: 'ui' }]);
    const typedModule = module as unknown as RegistryModuleManifest;
    expect(moduleCatalogLabels(typedModule)).toEqual(['h5', 'weather']);
    expect(moduleServiceOperations(typedModule, 'payment')).toEqual([
      'orders.create',
      'orders.read',
      'refunds.create',
    ]);
    expect(moduleServiceOperations(typedModule, 'ai')).toEqual([
      'models.read',
      'text.generate',
      'text.stream',
    ]);

    const labels = moduleCatalogLabels(typedModule);
    labels.push('mutated');
    const operations = moduleServiceOperations(typedModule, 'payment');
    expect(Object.isFrozen(operations)).toBe(true);
    expect(operations).toEqual(['orders.create', 'orders.read', 'refunds.create']);
  });

  test('returns v2 category and no platform service operations for v2 manifests', () => {
    const module = validModuleItem().module;
    const typedModule = module as unknown as RegistryModuleManifest;
    expect(moduleCatalogLabels(typedModule)).toEqual(['industry']);
    expect(moduleServiceOperations(typedModule, 'ai')).toEqual([]);
  });

  test.each([
    [
      'category',
      (module: Record<string, unknown>) => Object.assign(module, { category: 'industry' }),
    ],
    [
      'duplicate labels',
      (module: Record<string, unknown>) => {
        (module.openopc as { catalog: { labels: string[] } }).catalog.labels = ['h5', 'h5'];
      },
    ],
    [
      'unsorted labels',
      (module: Record<string, unknown>) => {
        (module.openopc as { catalog: { labels: string[] } }).catalog.labels = ['weather', 'h5'];
      },
    ],
    [
      'duplicate operations',
      (module: Record<string, unknown>) => {
        (
          module.openopc as { services: { payment: { operations: string[] } } }
        ).services.payment.operations = ['orders.create', 'orders.create'];
      },
    ],
    [
      'empty operation list',
      (module: Record<string, unknown>) => {
        (
          module.openopc as { services: { payment: { operations: string[] } } }
        ).services.payment.operations = [];
      },
    ],
    [
      'undeclared operation',
      (module: Record<string, unknown>) => {
        (
          module.openopc as { services: { payment: { operations: string[] } } }
        ).services.payment.operations = ['text.generate'];
      },
    ],
    [
      'unknown openopc field',
      (module: Record<string, unknown>) => {
        Object.assign(module.openopc as Record<string, unknown>, {
          providerUrl: 'https://provider.example',
        });
      },
    ],
    [
      'provider URL in catalog',
      (module: Record<string, unknown>) => {
        Object.assign((module.openopc as { catalog: Record<string, unknown> }).catalog, {
          providerUrl: 'https://provider.example',
        });
      },
    ],
    [
      'provider key in service',
      (module: Record<string, unknown>) => {
        Object.assign(
          (module.openopc as { services: { ai: Record<string, unknown> } }).services.ai,
          {
            apiKey: 'secret',
          },
        );
      },
    ],
  ] as const)('rejects v3 %s', (_label, mutate) => {
    const module = validV3Module() as Record<string, unknown>;
    mutate(module);
    expect(validateRegistryModuleManifest(module).valid).toBe(false);
  });

  test('rejects openopc on a v2 manifest', () => {
    const module = validModuleItem().module as Record<string, unknown>;
    Object.assign(module, { openopc: { sdkApiVersion: 'v1' } });
    const result = validateRegistryModuleManifest(module);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      severity: 'error',
      path: 'module.openopc',
      message: 'unknown field',
    });
  });

  test('rejects prototype-named services without throwing', () => {
    const module = validV3Module() as Record<string, unknown>;
    const services = module.openopc as { services: Record<string, unknown> };
    Object.assign(services.services, { toString: { operations: ['models.read'] } });

    expect(validateRegistryModuleManifest(module).valid).toBe(false);
  });

  test('accepts schema version 2 and rejects schema version 1 without fallback', () => {
    const current = validModuleItem().module;
    const legacy = { ...current, schemaVersion: 1 };

    expect(validateRegistryModuleManifest(current)).toEqual({ valid: true, issues: [] });
    expect(validateRegistryModuleManifest(legacy)).toEqual({
      valid: false,
      issues: [
        {
          severity: 'error',
          path: 'module.schemaVersion',
          message: 'schemaVersion must be 2',
        },
      ],
    });
  });

  test.each([
    ['agent', 'agent-project', undefined],
    ['sandboxed-web', 'sandboxed-web', 'dist/index.html'],
    ['server-adapter', 'server-conformance', 'dist/server.js'],
    ['desktop-native', 'desktop-package', 'dist/desktop.zip'],
  ] as const)(
    'requires execution mode %s to use verification profile %s',
    (mode, profile, entry) => {
      const module = validModuleItem().module as Record<string, unknown>;
      module.execution = { mode, ...(entry ? { entry } : {}) };
      module.verification = { profile };

      expect(validateRegistryModuleManifest(module).valid).toBe(true);

      module.verification = { profile: 'declarative' };
      const mismatched = validateRegistryModuleManifest(module);
      expect(mismatched.valid).toBe(false);
      expect(mismatched.issues).toContainEqual({
        severity: 'error',
        path: 'module.verification.profile',
        message: `verification.profile must be ${profile} for ${mode}`,
      });
    },
  );

  test('allows declarative verification to be omitted and rejects a foreign profile', () => {
    const module = validModuleItem().module as Record<string, unknown>;
    expect(validateRegistryModuleManifest(module).valid).toBe(true);

    module.verification = { profile: 'server-conformance' };
    const result = validateRegistryModuleManifest(module);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      severity: 'error',
      path: 'module.verification.profile',
      message: 'verification.profile must be declarative for declarative',
    });
  });

  test('accepts a versioned declarative module with scoped capabilities', () => {
    const item = validModuleItem();
    const result = validateRegistry({ name: 'acme', items: [item] });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(readRegistryModuleManifest(item)?.id).toBe('acme.recruiting');
  });

  test('requires the module block only for registry:module items', () => {
    const missing = validateRegistry({
      name: 'acme',
      items: [{ name: 'empty-module', type: 'registry:module' }],
    });
    const misplaced = validateRegistry({
      name: 'acme',
      items: [{ ...validModuleItem(), type: 'registry:skill' }],
    });

    expect(missing.valid).toBe(false);
    expect(missing.issues.some((issue) => issue.path.endsWith('.module'))).toBe(true);
    expect(misplaced.valid).toBe(false);
    expect(misplaced.issues.some((issue) => issue.message.includes('registry:module'))).toBe(true);
  });

  test('fails closed on unknown fields, unsafe entries, credentials, and foreign capability ids', () => {
    const item = validModuleItem();
    Object.assign(item.module, { runtimeUrl: 'https://unreviewed.example.com' });
    item.module.version = 'latest';
    item.module.execution = {
      mode: 'sandboxed-web',
      entry: 'https://evil.example/app.js',
    } as typeof item.module.execution;
    const capability = item.module.capabilities[0];
    if (!capability) throw new Error('fixture capability is required');
    capability.id = 'foreign.candidate-score';
    item.module.permissions.secrets = ['API_KEY=plaintext'];
    item.module.permissions.network = ['https://user:pass@example.com'];

    const result = validateRegistry({ name: 'acme', items: [item] });

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'items[0].module.runtimeUrl',
        'items[0].module.version',
        'items[0].module.execution.entry',
        'items[0].module.capabilities[0].id',
        'items[0].module.permissions.secrets[0]',
        'items[0].module.permissions.network[0]',
      ]),
    );
    expect(readRegistryModuleManifest(item)).toBeNull();
  });

  test('requires unique locales, capability ids, and UI surface ids', () => {
    const item = validModuleItem();
    item.module.locales.push('zh-CN');
    const capability = item.module.capabilities[0];
    const surface = item.module.ui[0];
    if (!capability || !surface) throw new Error('fixture declarations are required');
    item.module.capabilities.push({ ...capability });
    item.module.ui.push({ ...surface });

    const result = validateRegistry({ name: 'acme', items: [item] });

    expect(result.valid).toBe(false);
    expect(result.issues.filter((issue) => issue.message.includes('duplicate')).length).toBe(3);
  });
});
