import { describe, expect, test } from 'bun:test';

import { readRegistryModuleManifest } from './module-manifest';
import { validateRegistry } from './validate';

const validModuleItem = () => ({
  name: 'recruiting-workbench',
  type: 'registry:module',
  title: 'Recruiting Workbench',
  module: {
    schemaVersion: 1,
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

describe('registry module manifest', () => {
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
