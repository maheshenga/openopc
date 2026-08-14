import { describe, expect, test } from 'bun:test';

import {
  createEditorState,
  createNode,
  createProject,
  editorReducer,
  isCanvasProject,
  migrateImportedProject,
  normalizeCanvasProject,
} from './project-state';

describe('Infinite Canvas editor state', () => {
  test('adds, connects, deletes, and restores nodes without dangling connections', () => {
    const first = createNode('text', 10, 20);
    const second = createNode('image', 400, 20);
    let state = createEditorState(createProject(new Date('2026-08-11T00:00:00.000Z')));
    state = editorReducer(state, { type: 'add', node: first });
    state = editorReducer(state, { type: 'add', node: second });
    state = editorReducer(state, { type: 'start-connection', id: first.id });
    state = editorReducer(state, { type: 'finish-connection', id: second.id });
    expect(state.project.connections).toHaveLength(1);

    state = editorReducer(state, { type: 'select', ids: [first.id] });
    state = editorReducer(state, { type: 'delete-selected' });
    expect(state.project.nodes.map((node) => node.id)).toEqual([second.id]);
    expect(state.project.connections).toEqual([]);

    state = editorReducer(state, { type: 'undo' });
    expect(state.project.nodes).toHaveLength(2);
    expect(state.project.connections).toHaveLength(1);
  });

  test('does not duplicate a connection and keeps transient movement out of undo history', () => {
    const first = createNode('text', 0, 0);
    const second = createNode('image', 300, 0);
    let state = createEditorState();
    state = editorReducer(state, { type: 'add', node: first });
    state = editorReducer(state, { type: 'add', node: second });
    const historyLength = state.past.length;
    state = editorReducer(state, {
      type: 'patch-node',
      id: first.id,
      patch: { x: 40 },
      transient: true,
    });
    expect(state.past).toHaveLength(historyLength);
    state = editorReducer(state, { type: 'start-connection', id: first.id });
    state = editorReducer(state, { type: 'finish-connection', id: second.id });
    state = editorReducer(state, { type: 'start-connection', id: first.id });
    state = editorReducer(state, { type: 'finish-connection', id: second.id });
    expect(state.project.connections).toHaveLength(1);
  });

  test('rejects malformed imports', () => {
    expect(isCanvasProject({ schemaVersion: 1, id: 'x', title: 'x', nodes: 'bad' })).toBe(false);
    expect(isCanvasProject(createProject())).toBe(true);
  });

  test('supports multi-selection duplication and grouping without invalid links', () => {
    const first = createNode('image', 0, 0);
    const second = createNode('text', 360, 0);
    let state = createEditorState();
    state = editorReducer(state, { type: 'add', node: first });
    state = editorReducer(state, { type: 'add', node: second });
    state = editorReducer(state, { type: 'add-connection', source: first.id, target: second.id });
    state = editorReducer(state, { type: 'select', ids: [first.id, second.id] });
    state = editorReducer(state, { type: 'duplicate-selected' });
    expect(state.project.nodes).toHaveLength(4);
    expect(state.project.connections).toHaveLength(2);
    state = editorReducer(state, { type: 'group-selected' });
    expect(state.project.nodes.some((node) => node.kind === 'group')).toBe(true);
    expect(isCanvasProject(state.project)).toBe(true);
  });

  test('normalizes legacy projects with durable assistant and generation collections', () => {
    const legacy = createProject(new Date('2026-08-11T00:00:00.000Z'));
    const normalized = normalizeCanvasProject({
      ...legacy,
      chatSessions: undefined,
      activeChatId: undefined,
      generationHistory: undefined,
      workflowRuns: undefined,
    });

    expect(normalized.chatSessions).toEqual([]);
    expect(normalized.activeChatId).toBeNull();
    expect(normalized.generationHistory).toEqual([]);
    expect(normalized.workflowRuns).toEqual([]);
    expect(isCanvasProject(normalized)).toBe(true);
  });

  test('tracks assistant sessions and generation records in undo history', () => {
    let state = createEditorState();
    state = editorReducer(state, {
      type: 'upsert-chat-session',
      session: {
        id: 'chat-1',
        title: '商品主图策划',
        mode: 'ask',
        messages: [],
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    });
    state = editorReducer(state, {
      type: 'add-generation-record',
      record: {
        id: 'generation-1',
        nodeId: 'node-1',
        kind: 'image',
        prompt: '白色背景商品图',
        status: 'running',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z',
      },
    });

    expect(state.project.activeChatId).toBe('chat-1');
    expect(state.project.generationHistory).toHaveLength(1);
    state = editorReducer(state, { type: 'undo' });
    expect(state.project.generationHistory).toEqual([]);
    expect(state.project.chatSessions).toHaveLength(1);
  });

  test('deletes batch children with their root and repairs a root after child deletion', () => {
    const root = {
      ...createNode('image', 0, 0),
      id: 'root',
      isBatchRoot: true,
      batchChildIds: ['child-a', 'child-b'],
      primaryImageId: 'child-a',
    };
    const childA = { ...createNode('image', 20, 20), id: 'child-a', batchRootId: root.id };
    const childB = { ...createNode('image', 40, 40), id: 'child-b', batchRootId: root.id };
    let state = createEditorState({ ...createProject(), nodes: [root, childA, childB] });
    state = editorReducer(state, { type: 'select', ids: [childA.id] });
    state = editorReducer(state, { type: 'delete-selected' });
    expect(state.project.nodes.find((node) => node.id === root.id)?.batchChildIds).toEqual([
      'child-b',
    ]);
    expect(state.project.nodes.find((node) => node.id === root.id)?.primaryImageId).toBe('root');

    state = editorReducer(state, { type: 'select', ids: [root.id] });
    state = editorReducer(state, { type: 'delete-selected' });
    expect(state.project.nodes).toEqual([]);
  });

  test('migrates the upstream infinite-canvas project shape and remaps stored media', () => {
    const migrated = migrateImportedProject(
      {
        id: 'upstream-nanoid',
        title: '商品主视觉',
        createdAt: '2026-08-10T00:00:00.000Z',
        backgroundMode: 'lines',
        viewport: { x: 12, y: -8, k: 1.5 },
        nodes: [
          {
            id: 'text-1',
            type: 'text',
            title: '商品卖点',
            position: { x: 10, y: 20 },
            width: 240,
            height: 180,
            metadata: { content: '轻盈透气', prompt: '提炼卖点' },
          },
          {
            id: 'image-1',
            type: 'image',
            title: '主图',
            position: { x: 400, y: 20 },
            width: 340,
            height: 360,
            metadata: {
              storageKey: 'image:hero',
              mimeType: 'image/png',
              bytes: 128,
              naturalWidth: 1200,
              naturalHeight: 1200,
              status: 'success',
            },
          },
        ],
        connections: [{ id: 'edge-1', fromNodeId: 'text-1', toNodeId: 'image-1' }],
      },
      { assetIdByStorageKey: new Map([['image:hero', 'asset-local']]) },
    );

    expect(migrated).not.toBeNull();
    expect(migrated?.id).toMatch(/^project-[0-9a-f-]{36}$/i);
    expect(migrated?.background).toBe('lines');
    expect(migrated?.viewport).toEqual({ x: 12, y: -8, scale: 1.5 });
    expect(migrated?.nodes[0]?.content).toBe('轻盈透气');
    expect(migrated?.nodes[1]?.assetId).toBe('asset-local');
    expect(migrated?.nodes[1]?.status).toBe('ready');
    expect(migrated?.connections).toEqual([
      expect.objectContaining({ source: migrated?.nodes[0]?.id, target: migrated?.nodes[1]?.id }),
    ]);
    expect(isCanvasProject(migrated)).toBe(true);
  });
});
