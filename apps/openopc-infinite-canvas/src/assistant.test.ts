import { describe, expect, test } from 'bun:test';

import {
  appendAssistantMessage,
  buildAssistantContext,
  createAssistantSession,
  parseAssistantEnvelope,
} from './assistant';
import { createNode, createProject } from './project-state';

describe('canvas assistant domain', () => {
  test('keeps a bounded, retryable session transcript', () => {
    const session = createAssistantSession('商品主图策划', new Date('2026-08-11T00:00:00.000Z'));
    const next = appendAssistantMessage(session, {
      id: 'message-1',
      role: 'user',
      mode: 'ask',
      text: '整理卖点',
      status: 'success',
      createdAt: '2026-08-11T00:00:01.000Z',
    });

    expect(next.messages).toHaveLength(1);
    expect(next.updatedAt).toBe('2026-08-11T00:00:01.000Z');
    expect(next.title).toBe('商品主图策划');
  });

  test('builds context from selected nodes and their direct upstream nodes', () => {
    const source = { ...createNode('text', 0, 0), id: 'source', content: '核心卖点' };
    const selected = { ...createNode('image', 400, 0), id: 'selected', prompt: '主图' };
    const project = {
      ...createProject(),
      nodes: [source, selected],
      connections: [{ id: 'edge-1', source: source.id, target: selected.id }],
    };

    const context = buildAssistantContext(project, [selected.id]);
    expect(context.selected.map((node) => node.id)).toEqual(['selected']);
    expect(context.upstream.map((node) => node.id)).toEqual(['source']);
    expect(context.prompt).toContain('核心卖点');
  });

  test('accepts only supported structured assistant actions', () => {
    const parsed = parseAssistantEnvelope(
      JSON.stringify({
        reply: '已创建结构。',
        actions: [
          { name: 'create_text_node', arguments: { title: '卖点', content: '轻量耐用' } },
          { name: 'run_shell', arguments: { command: 'nope' } },
        ],
      }),
    );

    expect(parsed.reply).toBe('已创建结构。');
    expect(parsed.actions).toEqual([
      { name: 'create_text_node', arguments: { title: '卖点', content: '轻量耐用' } },
    ]);
  });
});
