import type { AssistantMessage, AssistantSession, CanvasNode, CanvasProject } from './types';

export const ASSISTANT_ACTION_NAMES = [
  'create_text_node',
  'update_text_node',
  'create_connection',
  'create_group',
  'arrange_nodes',
  'generate_image',
] as const;

export type AssistantActionName = (typeof ASSISTANT_ACTION_NAMES)[number];
export interface AssistantAction {
  name: AssistantActionName;
  arguments: Record<string, unknown>;
}

export interface AssistantEnvelope {
  reply: string;
  actions: AssistantAction[];
}

let assistantIdCounter = 0;

function id(prefix: string): string {
  let uuid = '';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      uuid = crypto.randomUUID();
    }
  } catch {
    // Fall through to the secure-bytes fallback.
  }
  if (!uuid) {
    try {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      uuid = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      uuid = `${Date.now().toString(36)}-${(assistantIdCounter++).toString(36)}`;
    }
  }
  return `${prefix}-${uuid}`;
}

export function createAssistantSession(title = '新会话', now = new Date()): AssistantSession {
  const timestamp = now.toISOString();
  return {
    id: id('chat'),
    title: title.trim().slice(0, 80) || '新会话',
    mode: 'ask',
    messages: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function appendAssistantMessage(
  session: AssistantSession,
  message: AssistantMessage,
): AssistantSession {
  return {
    ...session,
    messages: [...session.messages, message].slice(-200),
    updatedAt: message.createdAt,
  };
}

function nodeSummary(node: CanvasNode): string {
  const text = node.content || node.prompt || node.assetName || '';
  return `${node.id} | ${node.kind} | ${node.title}${text ? ` | ${text.slice(0, 600)}` : ''}`;
}

export function buildAssistantContext(project: CanvasProject, selectedIds: readonly string[]) {
  const selectedSet = new Set(selectedIds);
  const selected = project.nodes.filter((node) => selectedSet.has(node.id));
  const upstreamIds = new Set(
    project.connections
      .filter((connection) => selectedSet.has(connection.target))
      .map((connection) => connection.source),
  );
  const upstream = project.nodes.filter(
    (node) => upstreamIds.has(node.id) && !selectedSet.has(node.id),
  );
  const sections = [
    `画布：${project.title}`,
    `节点：${project.nodes.length}，连线：${project.connections.length}`,
    selected.length ? `选中节点：\n${selected.map(nodeSummary).join('\n')}` : '选中节点：无',
    upstream.length ? `直接上游：\n${upstream.map(nodeSummary).join('\n')}` : '直接上游：无',
  ];
  return { selected, upstream, prompt: sections.join('\n\n') };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanArguments(value: unknown): Record<string, unknown> {
  const input = record(value);
  if (!input) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input).slice(0, 32)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)) continue;
    if (typeof item === 'string') output[key] = item.slice(0, 50_000);
    else if (typeof item === 'number' && Number.isFinite(item)) output[key] = item;
    else if (typeof item === 'boolean') output[key] = item;
    else if (Array.isArray(item)) {
      output[key] = item
        .filter((entry): entry is string => typeof entry === 'string')
        .slice(0, 50)
        .map((entry) => entry.slice(0, 200));
    }
  }
  return output;
}

export function parseAssistantEnvelope(content: string): AssistantEnvelope {
  const trimmed = content.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return { reply: trimmed, actions: [] };
  try {
    const value = record(JSON.parse(trimmed.slice(start, end + 1)));
    if (!value) return { reply: trimmed, actions: [] };
    const allowed = new Set<string>(ASSISTANT_ACTION_NAMES);
    const actions = Array.isArray(value.actions)
      ? value.actions.slice(0, 12).flatMap((candidate) => {
          const action = record(candidate);
          const name = action?.name;
          if (typeof name !== 'string' || !allowed.has(name)) return [];
          return [
            {
              name: name as AssistantActionName,
              arguments: cleanArguments(action?.arguments),
            },
          ];
        })
      : [];
    return {
      reply: typeof value.reply === 'string' ? value.reply.trim().slice(0, 100_000) : '',
      actions,
    };
  } catch {
    return { reply: trimmed, actions: [] };
  }
}
