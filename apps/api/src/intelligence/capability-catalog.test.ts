import { describe, expect, test } from 'bun:test';
import type { CapabilityDescriptor } from '@kortix/intelligence-contracts';
import { createProjectCapabilityCatalog } from './capability-catalog';

const ACCOUNT_ID = '11000000-0000-4000-a000-000000000001';
const PROJECT_ID = '12000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '22000000-0000-4000-a000-000000000001';

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
          null as unknown as { projectId: string; connectorSlug: string; action: null },
          {
            projectId,
            connectorSlug: 'slack',
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
          { projectId, connectorSlug: 'invalid', action: null },
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
    });

    expect(result).toEqual({
      items: [
        {
          ref: { kind: 'tool', id: 'slack.messages.search', version: '1.0.0' },
          title: 'Search Slack messages',
          summary: 'Search project Slack messages.',
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
    const first = await catalog.search({ projectId: PROJECT_ID, query: '', limit: 1, cursor: null });

    expect(first.items[0]?.ref).toEqual({
      kind: 'capability',
      id: 'studio.image.generate',
      version: '1.0.0',
    });
    expect(first.next_cursor).toBe(1);
    expect(
      await catalog.describe({ projectId: PROJECT_ID, ref: first.items[0]!.ref }),
    ).toEqual(imageCapability.input_schema);
    expect(
      await catalog.describe({
        projectId: OTHER_PROJECT_ID,
        ref: first.items[0]!.ref,
      }),
    ).toBeNull();
  });

  test('forwards the actor only to local sources and redacts unsafe describe schemas', async () => {
    const { catalog, actors } = createCatalog();
    const actor = { accountId: ACCOUNT_ID, userId: 'user-1', actorType: 'user' as const };

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

  test('does not leak credential-like values from a public source summary', async () => {
    const catalog = createProjectCapabilityCatalog({
      capabilityRegistry: { async list() { return []; } },
      executorSource: {
        async list(projectId) {
          return [
            {
              projectId,
              connectorSlug: 'unsafe',
              action: {
                path: 'read',
                name: 'Unsafe source',
                description: '{"token":"private-value"}',
                risk: 'read',
              },
            },
          ];
        },
      },
    });

    expect(
      await catalog.search({ projectId: PROJECT_ID, query: '', limit: 20, cursor: null }),
    ).toEqual({ items: [], next_cursor: null });
  });
});
