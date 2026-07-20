import { describe, expect, test } from 'bun:test';
import type { CapabilityDescriptor } from '@kortix/intelligence-contracts';
import {
  createExecutorCatalogSource,
  createProjectCapabilityCatalog,
} from './capability-catalog';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '22000000-0000-4000-a000-000000000001';
const USER_ID = '13000000-0000-4000-a000-000000000001';
const ACTOR = {
  accountId: ACCOUNT_ID,
  userId: USER_ID,
  actorType: 'user' as const,
  actingTokenId: null,
};

const imageCapability: CapabilityDescriptor = {
  id: 'studio.image.generate',
  version: '1.0.0',
  modality: 'image',
  operation: 'generate',
  input_schema: { type: 'object', properties: { prompt: { type: 'string' } } },
  output_schema: { type: 'array' },
  execution: 'async',
  risk: 'write',
  provenance_required: true,
};

function createCatalog() {
  const actors: unknown[] = [];
  const catalog = createProjectCapabilityCatalog({
    capabilityRegistry: {
      async list(projectId, actor) {
        actors.push(actor ?? null);
        return projectId === PROJECT_ID
          ? ([null, { id: 'malformed' }, imageCapability] as unknown as CapabilityDescriptor[])
          : [];
      },
    },
    executorSource: {
      async list(projectId) {
        return [
          null as unknown as {
            projectId: string;
            connectorSlug: string;
            source: 'mcp';
            action: null;
          },
          {
            projectId,
            connectorSlug: 'slack',
            source: 'mcp',
            action: {
              path: 'messages.search',
              name: 'Search Slack messages',
              description: 'Search project Slack messages.',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
              outputSchema: null,
              risk: 'read',
              binding: { kind: 'mcp', tool: 'messages.search' },
            },
          },
          {
            projectId,
            connectorSlug: 'slack',
            source: 'mcp',
            action: {
              path: 'files.list',
              name: 'List Slack files',
              description: 'List project Slack files.',
              inputSchema: { type: 'object', properties: { api_key: { type: 'string' } } },
              outputSchema: null,
              risk: 'read',
              binding: { kind: 'mcp', tool: 'files.list' },
            },
          },
          {
            projectId: OTHER_PROJECT_ID,
            connectorSlug: 'foreign',
            source: 'mcp',
            action: {
              path: 'secrets.read',
              name: 'Foreign secret',
              description: 'api_key=should-not-appear',
              inputSchema: null,
              outputSchema: null,
              risk: 'read',
              binding: { kind: 'mcp', tool: 'secrets.read' },
            },
          },
          { projectId, connectorSlug: 'invalid', source: 'executor', action: null },
        ];
      },
    },
  });
  return { catalog, actors };
}

describe('project capability catalog', () => {
  test('searches project-scoped sources deterministically without exposing source secrets', async () => {
    const { catalog } = createCatalog();

    const result = await catalog.search({
      projectId: PROJECT_ID,
      query: 'search',
      limit: 20,
      cursor: null,
      actor: ACTOR,
    });

    expect(result).toEqual({
      items: [
        {
          ref: { kind: 'tool', id: 'slack.messages.search', version: '1.0.0' },
          title: 'Slack Messages Search',
          summary: 'Run the slack.messages.search tool.',
          risk: 'read',
          availability: 'available',
          capability_id: null,
          executable: true,
          source: 'mcp',
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/api_key|foreign|secret/i);
  });

  test('paginates stable merged items and only describes an exact project-scoped reference', async () => {
    const { catalog } = createCatalog();
    const first = await catalog.search({
      projectId: PROJECT_ID,
      query: '',
      limit: 1,
      cursor: null,
      actor: ACTOR,
    });

    expect(first.items[0]?.ref).toEqual({
      kind: 'capability',
      id: 'studio.image.generate',
      version: '1.0.0',
    });
    expect(first.next_cursor).toBe(1);
    expect(
      await catalog.describe({ projectId: PROJECT_ID, ref: first.items[0]!.ref, actor: ACTOR }),
    ).toEqual(imageCapability.input_schema);
    expect(
      await catalog.describe({
        projectId: OTHER_PROJECT_ID,
        ref: first.items[0]!.ref,
        actor: ACTOR,
      }),
    ).toBeNull();
  });

  test('forwards the actor only to local sources and redacts unsafe describe schemas', async () => {
    const { catalog, actors } = createCatalog();
    const actor = ACTOR;

    await catalog.search({ projectId: PROJECT_ID, query: '', limit: 20, cursor: null, actor });
    expect(actors).toContainEqual(actor);
    expect(
      await catalog.describe({
        projectId: PROJECT_ID,
        ref: { kind: 'tool', id: 'slack.files.list', version: '1.0.0' },
        actor,
      }),
    ).toEqual({ type: 'object' });
  });

  test('redacts camelCase credential metadata from describe schemas', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'upload',
                name: 'Upload file',
                inputSchema: {
                  type: 'object',
                  credentialBinding: { identifier: 'IMAGE_API_KEY' },
                },
                risk: 'write',
              },
            },
          ];
        },
      },
    });

    expect(
      await catalog.describe({
        projectId: PROJECT_ID,
        ref: { kind: 'tool', id: 'storage.upload', version: '1.0.0' },
        actor: ACTOR,
      }),
    ).toEqual({ type: 'object' });
  });

  test('redacts camelCase raw provider bodies from describe schemas', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'upload',
                name: 'Upload file',
                inputSchema: {
                  type: 'object',
                  rawProviderBody: { opaque: 'provider trace' },
                },
                risk: 'write',
              },
            },
          ];
        },
      },
    });

    expect(
      await catalog.describe({
        projectId: PROJECT_ID,
        ref: { kind: 'tool', id: 'storage.upload', version: '1.0.0' },
        actor: ACTOR,
      }),
    ).toEqual({ type: 'object' });
  });

  test('redacts alternate raw provider response metadata from describe schemas', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'upload',
                name: 'Upload file',
                inputSchema: {
                  type: 'object',
                  rawProviderResponse: { opaque: 'provider trace' },
                },
                risk: 'write',
              },
            },
          ];
        },
      },
    });

    expect(
      await catalog.describe({
        projectId: PROJECT_ID,
        ref: { kind: 'tool', id: 'storage.upload', version: '1.0.0' },
        actor: ACTOR,
      }),
    ).toEqual({ type: 'object' });
  });

  test('maps only the authenticated catalog actor executor catalog into safe tool entries', async () => {
    const requestContext = { requestId: 'catalog-request' };
    const source = createExecutorCatalogSource({
      async resolveProjectPrincipal(actor, projectId) {
        expect(actor).toBe(ACTOR);
        return {
          accountId: ACCOUNT_ID,
          userId: USER_ID,
          projectId,
        };
      },
      async listCatalog() {
        return [
          {
            slug: 'slack',
            provider: 'mcp',
            actions: [
              {
                path: 'messages.search',
                name: 'Search messages',
                description: 'External description is never public catalog text.',
                inputSchema: { type: 'object' },
                risk: 'read',
              },
            ],
          },
        ];
      },
    });

    await expect(source.list(PROJECT_ID, ACTOR, requestContext)).resolves.toEqual([
      {
        projectId: PROJECT_ID,
        connectorSlug: 'slack',
        source: 'mcp',
        action: {
          path: 'messages.search',
          name: 'Search messages',
          description: 'External description is never public catalog text.',
          inputSchema: { type: 'object' },
          risk: 'read',
        },
      },
    ]);
  });

  test('resolves the Executor principal from the catalog actor, not a Supabase login session', async () => {
    const supabaseRequestContext = {
      get: (key: string) => (key === 'sessionId' ? 'supabase-login-session' : undefined),
    };
    const sessionActor = {
      ...ACTOR,
      sessionId: 'project-session-123',
      agentGrant: { agent: 'content-planner', connectors: ['slack'], kortixCli: [] },
    };
    let receivedPrincipalInput: unknown;
    const source = createExecutorCatalogSource({
      async resolveProjectPrincipal(input, projectId) {
        receivedPrincipalInput = input;
        return { accountId: ACCOUNT_ID, userId: USER_ID, projectId };
      },
      async listCatalog() {
        return [];
      },
    });

    await source.list(PROJECT_ID, sessionActor, supabaseRequestContext);

    expect(receivedPrincipalInput).toBe(sessionActor);
  });

  test('projects external tool schemas without returning credential-like literal values', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'upload',
                name: 'Upload file',
                inputSchema: {
                  type: 'object',
                  properties: {
                    query: {
                      type: 'string',
                      'x-in': 'query',
                      default: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
                    },
                    'team-id': { type: 'string', 'x-in': 'path' },
                    sk_live_abcdefghijklmnopqrstuvwxyz012345: { type: 'string' },
                    AIzaabcdefghijklmnopqrstuvwxyz012345678: { type: 'string' },
                    item: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { limit: { type: 'integer', minimum: 1 } },
                      },
                    },
                  },
                  required: ['query', 'query', 'toString', 'team-id'],
                  examples: [
                    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                    'AKIA1234567890ABCDEF',
                    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature',
                  ],
                },
                risk: 'write',
              },
            },
          ];
        },
      },
    });

    const detail = await catalog.describe({
      projectId: PROJECT_ID,
      ref: { kind: 'tool', id: 'storage.upload', version: '1.0.0' },
      actor: ACTOR,
    });

    expect(detail).toEqual({
      type: 'object',
      properties: {
        query: { type: 'string', 'x-in': 'query' },
        'team-id': { type: 'string', 'x-in': 'path' },
        item: {
          type: 'array',
          items: {
            type: 'object',
            properties: { limit: { type: 'integer', minimum: 1 } },
          },
        },
      },
      required: ['query', 'team-id'],
    });
    expect(JSON.stringify(detail)).not.toContain('sk-proj-');
    expect(JSON.stringify(detail)).not.toContain('sk_live_');
    expect(JSON.stringify(detail)).not.toContain('AIza');
    expect(JSON.stringify(detail)).not.toContain('ghp_');
    expect(JSON.stringify(detail)).not.toContain('AKIA');
    expect(JSON.stringify(detail)).not.toContain('eyJhbGci');
  });

  test('does not leak credential-like values from a public source summary', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'unsafe',
              source: 'executor',
              action: {
                path: 'read',
                name: 'Unsafe source',
                description: '{"token":"private-value"}',
                risk: 'read',
              },
            },
            {
              projectId,
              connectorSlug: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
              source: 'executor',
              action: { path: 'read', name: 'Unsafe literal connector', risk: 'read' },
            },
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
                name: 'Unsafe literal action',
                risk: 'read',
              },
            },
          ];
        },
      },
    });

    const result = await catalog.search({
      projectId: PROJECT_ID,
      query: '',
      limit: 20,
      cursor: null,
      actor: ACTOR,
    });
    expect(result).toEqual({
      items: [
        {
          ref: { kind: 'tool', id: 'unsafe.read', version: '1.0.0' },
          title: 'Unsafe Read',
          summary: 'Run the unsafe.read tool.',
          risk: 'read',
          availability: 'available',
          capability_id: null,
          executable: true,
          source: 'executor',
        },
      ],
      next_cursor: null,
    });
    expect(JSON.stringify(result)).not.toContain('private-value');
  });

  test('drops credential-bearing connector and action identifiers', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'api_key_private-value',
              source: 'executor',
              action: { path: 'read', name: 'Unsafe connector', risk: 'read' },
            },
            {
              projectId,
              connectorSlug: 'storage',
              source: 'executor',
              action: {
                path: 'bearer_private-value',
                name: 'Unsafe action',
                risk: 'read',
              },
            },
          ];
        },
      },
    });

    await expect(
      catalog.search({
        projectId: PROJECT_ID,
        query: '',
        limit: 20,
        cursor: null,
        actor: ACTOR,
      }),
    ).resolves.toEqual({ items: [], next_cursor: null });
  });

  test('requires an actor and deduplicates a repeated source reference', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'slack',
              source: 'mcp',
              action: { path: 'messages.search', name: 'ignored', risk: 'read' },
            },
            {
              projectId,
              connectorSlug: 'slack',
              source: 'mcp',
              action: { path: 'messages.search', name: 'ignored twice', risk: 'read' },
            },
          ];
        },
      },
    });

    await expect(
      catalog.search({ projectId: PROJECT_ID, query: '', limit: 20, cursor: null } as never),
    ).rejects.toThrow('catalog actor is required');
    await expect(
      catalog.search({ projectId: PROJECT_ID, query: '', limit: 20, cursor: null, actor: ACTOR }),
    ).resolves.toMatchObject({
      items: [{ ref: { kind: 'tool', id: 'slack.messages.search', version: '1.0.0' } }],
    });
  });

  test('fails closed when an agent catalog actor has no valid grant', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
    });

    await expect(
      catalog.search({
        projectId: PROJECT_ID,
        query: '',
        limit: 20,
        cursor: null,
        actor: { ...ACTOR, actorType: 'agent' },
      }),
    ).rejects.toThrow('catalog actor is required');
    await expect(
      catalog.search({
        projectId: PROJECT_ID,
        query: '',
        limit: 20,
        cursor: null,
        actor: {
          ...ACTOR,
          actorType: 'agent',
          agentGrant: { agent: 'content-planner', connectors: ['slack'], kortixCli: [] },
        },
      }),
    ).resolves.toEqual({ items: [], next_cursor: null });
  });
});
