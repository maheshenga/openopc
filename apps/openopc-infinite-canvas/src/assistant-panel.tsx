import {
  Bot,
  ChevronDown,
  Image as ImageIcon,
  MessageSquareText,
  Plus,
  RotateCcw,
  Send,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import {
  type AssistantAction,
  appendAssistantMessage,
  buildAssistantContext,
  createAssistantSession,
  parseAssistantEnvelope,
} from './assistant';
import type {
  AssistantImage,
  AssistantMessage,
  AssistantMode,
  AssistantReference,
  AssistantSession,
  CanvasProject,
} from './types';

interface AssistantPanelProps {
  open: boolean;
  project: CanvasProject;
  selectedIds: readonly string[];
  platformReady: boolean;
  onClose(): void;
  onUpsertSession(session: AssistantSession): void;
  onDeleteSession(id: string): void;
  onSetActiveSession(id: string | null): void;
  onGenerateText(
    prompt: string,
    signal: AbortSignal,
    references?: readonly AssistantReference[],
  ): Promise<string>;
  onGenerateImage(
    prompt: string,
    signal: AbortSignal,
    references?: readonly AssistantReference[],
  ): Promise<AssistantImage[]>;
  onPasteImage(file: File): Promise<AssistantReference>;
  onExecuteActions(actions: readonly AssistantAction[]): Promise<string[]>;
  onNotice(message: string): void;
}

function id(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sessionTitle(text: string): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, 24) || '新会话';
}

function message(
  role: AssistantMessage['role'],
  mode: AssistantMode,
  text: string,
  status: AssistantMessage['status'],
): AssistantMessage {
  return {
    id: id('message'),
    role,
    mode,
    text,
    status,
    createdAt: new Date().toISOString(),
  };
}

export function AssistantPanel({
  open,
  project,
  selectedIds,
  platformReady,
  onClose,
  onUpsertSession,
  onDeleteSession,
  onSetActiveSession,
  onGenerateText,
  onGenerateImage,
  onPasteImage,
  onExecuteActions,
  onNotice,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<AssistantMode>('ask');
  const [running, setRunning] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [pastedReferences, setPastedReferences] = useState<AssistantReference[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const active = useMemo(
    () => project.chatSessions.find((session) => session.id === project.activeChatId) ?? null,
    [project.activeChatId, project.chatSessions],
  );
  const context = useMemo(
    () => buildAssistantContext(project, selectedIds),
    [project, selectedIds],
  );

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [active?.messages.length, open]);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const update = (session: AssistantSession, next: AssistantMessage) => {
    const updated = appendAssistantMessage(session, next);
    onUpsertSession(updated);
    return updated;
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || running) return;
    if (!platformReady) {
      onNotice('助手需要在 OpenOPC 平台中使用；本地画布仍可继续编辑');
      return;
    }

    const session = active ?? createAssistantSession(sessionTitle(prompt));
    const references = [
      ...[...context.selected, ...context.upstream].map((node) => ({
        id: node.id,
        kind: node.kind,
        title: node.title,
        text: node.content || node.prompt || undefined,
        assetId: node.assetId,
        assetUrl: node.assetUrl,
      })),
      ...pastedReferences,
    ].filter(
      (reference, index, all) => all.findIndex((item) => item.id === reference.id) === index,
    );
    let nextSession = update(session, {
      ...message('user', mode, prompt, 'success'),
      references,
    });
    const pending = message('assistant', mode, '', 'thinking');
    nextSession = update(nextSession, pending);
    setDraft('');
    setPastedReferences([]);
    setRunning(true);
    const controller = new AbortController();
    controllerRef.current = controller;

    try {
      if (mode === 'image') {
        const images = await onGenerateImage(prompt, controller.signal, references);
        nextSession = {
          ...nextSession,
          messages: nextSession.messages.map((item) =>
            item.id === pending.id
              ? {
                  ...item,
                  text: `已生成 ${images.length} 张图片并插入画布。`,
                  images,
                  status: 'success' as const,
                  createdAt: new Date().toISOString(),
                }
              : item,
          ),
          updatedAt: new Date().toISOString(),
        };
      } else {
        const systemPrompt = [
          '你是 Infinite Canvas 创作助手。回答用户问题；需要修改画布时，只能返回以下 JSON 动作：',
          'create_text_node, update_text_node, create_connection, create_group, arrange_nodes, generate_image。',
          '格式：{"reply":"给用户的回答","actions":[{"name":"create_text_node","arguments":{...}}]}。',
          '不要请求、输出或保存 provider 凭据。',
          context.prompt,
          `用户请求：${prompt}`,
        ].join('\n\n');
        const history = nextSession.messages
          .slice(0, -1)
          .slice(-20)
          .map((item) => `${item.role === 'user' ? '用户' : '助手'}：${item.text}`)
          .join('\n');
        const response = await onGenerateText(
          history ? `${systemPrompt}\n\n最近会话：\n${history}` : systemPrompt,
          controller.signal,
          references,
        );
        const envelope = parseAssistantEnvelope(response);
        const actionMessages = envelope.actions.length
          ? await onExecuteActions(envelope.actions)
          : [];
        nextSession = {
          ...nextSession,
          messages: nextSession.messages.map((item) =>
            item.id === pending.id
              ? {
                  ...item,
                  text: [envelope.reply || response, ...actionMessages]
                    .filter(Boolean)
                    .join('\n\n'),
                  status: 'success' as const,
                  createdAt: new Date().toISOString(),
                }
              : item,
          ),
          updatedAt: new Date().toISOString(),
        };
      }
      onUpsertSession(nextSession);
    } catch (error) {
      const stopped = controller.signal.aborted;
      nextSession = {
        ...nextSession,
        messages: nextSession.messages.map((item) =>
          item.id === pending.id
            ? {
                ...item,
                text: stopped ? '已停止本次请求。' : '',
                error: stopped
                  ? undefined
                  : error instanceof Error
                    ? error.message
                    : '助手请求失败',
                status: stopped ? ('stopped' as const) : ('error' as const),
                createdAt: new Date().toISOString(),
              }
            : item,
        ),
        updatedAt: new Date().toISOString(),
      };
      onUpsertSession(nextSession);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setRunning(false);
    }
  };

  return (
    <aside className={`assistant-panel${open ? ' is-open' : ''}`} aria-label="画布助手">
      <div className="assistant-header">
        <div>
          <Bot aria-hidden="true" />
          <span>
            <strong>Canvas Agent</strong>
            <small>
              {selectedIds.length ? `引用 ${selectedIds.length} 个选中节点` : '创作与画布编排'}
            </small>
          </span>
        </div>
        <button type="button" className="icon-button" aria-label="关闭画布助手" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </div>

      <div className="assistant-session-bar">
        <button
          type="button"
          className="assistant-session-trigger"
          aria-expanded={sessionsOpen}
          onClick={() => setSessionsOpen((value) => !value)}
        >
          <MessageSquareText aria-hidden="true" />
          <span>{active?.title ?? '新会话'}</span>
          <ChevronDown aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="新建会话"
          aria-label="新建助手会话"
          onClick={() => {
            onSetActiveSession(null);
            setSessionsOpen(false);
          }}
        >
          <Plus aria-hidden="true" />
        </button>
        {active ? (
          <button
            type="button"
            className="icon-button"
            title="删除会话"
            aria-label="删除当前助手会话"
            onClick={() => onDeleteSession(active.id)}
          >
            <Trash2 aria-hidden="true" />
          </button>
        ) : null}
        {sessionsOpen ? (
          <div className="assistant-session-menu">
            {project.chatSessions.length ? (
              project.chatSessions.map((session) => (
                <button
                  type="button"
                  key={session.id}
                  aria-current={session.id === project.activeChatId}
                  onClick={() => {
                    onSetActiveSession(session.id);
                    setSessionsOpen(false);
                  }}
                >
                  <strong>{session.title}</strong>
                  <small>{session.messages.length} 条消息</small>
                </button>
              ))
            ) : (
              <p>暂无历史会话</p>
            )}
          </div>
        ) : null}
      </div>

      <div className="assistant-messages" aria-live="polite">
        {active?.messages.length ? (
          active.messages.map((item) => (
            <article className={`assistant-message is-${item.role}`} key={item.id}>
              <span>{item.role === 'user' ? '你' : 'Agent'}</span>
              <div>
                {item.references?.length ? (
                  <div className="assistant-references">
                    {item.references.map((reference) => (
                      <span key={`${item.id}-${reference.id}`}>{reference.title}</span>
                    ))}
                  </div>
                ) : null}
                {item.status === 'thinking' || item.status === 'running' ? (
                  <p className="assistant-thinking">正在处理...</p>
                ) : null}
                {item.text ? <p>{item.text}</p> : null}
                {item.images?.length ? (
                  <div className="assistant-images">
                    {item.images.map((image) =>
                      image.assetUrl ? (
                        <img key={image.id} src={image.assetUrl} alt={image.prompt} />
                      ) : (
                        <span key={image.id} className="assistant-image-placeholder">
                          本地素材将在打开项目后恢复
                        </span>
                      ),
                    )}
                  </div>
                ) : null}
                {item.error ? <p className="assistant-error">{item.error}</p> : null}
                {item.role === 'assistant' && item.status !== 'thinking' ? (
                  <button
                    type="button"
                    className="assistant-retry"
                    onClick={() => {
                      const index = active.messages.findIndex(
                        (candidate) => candidate.id === item.id,
                      );
                      const previous = active.messages
                        .slice(0, index)
                        .reverse()
                        .find((candidate) => candidate.role === 'user');
                      if (previous) {
                        setMode(previous.mode);
                        setDraft(previous.text);
                      }
                    }}
                  >
                    <RotateCcw aria-hidden="true" />
                    重试
                  </button>
                ) : null}
              </div>
            </article>
          ))
        ) : (
          <div className="assistant-empty">
            <Bot aria-hidden="true" />
            <strong>从画布上下文开始</strong>
            <span>选中节点后提问，助手会同时读取它们的直接上游。</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form className="assistant-composer" onSubmit={(event) => void submit(event)}>
        <div className="segmented" role="group" aria-label="助手模式">
          <button type="button" aria-pressed={mode === 'ask'} onClick={() => setMode('ask')}>
            <MessageSquareText aria-hidden="true" />
            问答
          </button>
          <button type="button" aria-pressed={mode === 'image'} onClick={() => setMode('image')}>
            <ImageIcon aria-hidden="true" />
            生图
          </button>
        </div>
        {pastedReferences.length ? (
          <div className="assistant-pasted-references">
            {pastedReferences.map((reference) => (
              <button
                type="button"
                key={reference.id}
                title="移除粘贴图片"
                onClick={() =>
                  setPastedReferences((current) =>
                    current.filter((item) => item.id !== reference.id),
                  )
                }
              >
                {reference.assetUrl ? <img src={reference.assetUrl} alt="" /> : null}
                <span>{reference.title}</span>
                <X aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          aria-label="给画布助手的消息"
          value={draft}
          maxLength={50_000}
          placeholder={
            mode === 'image' ? '描述要生成并插入画布的图片' : '询问、规划或让助手编排画布'
          }
          onChange={(event) => setDraft(event.currentTarget.value)}
          onPaste={(event) => {
            const images = Array.from(event.clipboardData.files)
              .filter((file) => file.type.startsWith('image/'))
              .slice(0, 4);
            if (!images.length) return;
            event.preventDefault();
            void Promise.all(images.map((file) => onPasteImage(file)))
              .then((references) =>
                setPastedReferences((current) => [...current, ...references].slice(-8)),
              )
              .catch((error) => onNotice(error instanceof Error ? error.message : '无法粘贴图片'));
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="assistant-composer-footer">
          <span>{platformReady ? '通过 OpenOPC 平台能力执行' : '本地模式不调用模型'}</span>
          {running ? (
            <button
              type="button"
              className="icon-button assistant-send"
              title="停止"
              aria-label="停止助手请求"
              onClick={() => controllerRef.current?.abort()}
            >
              <Square aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className="icon-button assistant-send"
              disabled={!draft.trim()}
              title="发送"
              aria-label="发送给画布助手"
            >
              <Send aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
