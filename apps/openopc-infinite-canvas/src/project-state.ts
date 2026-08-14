import {
  type CanvasNode,
  type CanvasProject,
  type EditorState,
  type AssistantSession,
  type AssistantMessageStatus,
  type GenerationRecord,
  NODE_KINDS,
  type NodeKind,
} from './types';

const NODE_SIZE: Record<NodeKind, { width: number; height: number }> = {
  text: { width: 320, height: 260 },
  image: { width: 340, height: 360 },
  video: { width: 380, height: 360 },
  audio: { width: 340, height: 230 },
  panorama: { width: 420, height: 310 },
  director: { width: 620, height: 460 },
  config: { width: 330, height: 300 },
  group: { width: 600, height: 420 },
};

const NODE_TITLES: Record<NodeKind, string> = {
  text: '文本生成',
  image: '图片生成',
  video: '视频',
  audio: '音频',
  panorama: '全景图',
  director: '3D 导演台',
  config: '生成配置',
  group: '节点分组',
};

let fallbackIdCounter = 0;
let entityIdCounter = 0;

function randomUuid(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to a standards-shaped, collision-resistant fallback.
  }
  const timestamp = Date.now().toString(16).padStart(12, '0').slice(-12);
  const counter = (fallbackIdCounter++ & 0xffff).toString(16).padStart(4, '0');
  const entropyBytes = new Uint32Array(1);
  try {
    crypto.getRandomValues(entropyBytes);
  } catch {
    // Deterministic monotonic fallback; entity ids are not security tokens.
    entropyBytes[0] = (fallbackIdCounter * 2654435761) >>> 0;
  }
  const entropy = (entropyBytes[0] >>> 0).toString(16).padStart(8, '0');
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-4${counter.slice(0, 3)}-8${counter.slice(3)}-${entropy}${timestamp.slice(0, 4)}`;
}

function id(prefix: string): string {
  entityIdCounter = (entityIdCounter + 1) % 0x1000000;
  return `${prefix}-${randomUuid()}-${entityIdCounter.toString(36)}`;
}

export function createProject(now = new Date(), projectId?: string): CanvasProject {
  const timestamp = now.toISOString();
  return {
    schemaVersion: 1,
    id: projectId ?? `project-${randomUuid()}`,
    title: '未命名画布',
    createdAt: timestamp,
    updatedAt: timestamp,
    background: 'dots',
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, scale: 1 },
    chatSessions: [],
    activeChatId: null,
    generationHistory: [],
    workflowRuns: [],
  };
}

export function createNode(kind: NodeKind, x: number, y: number): CanvasNode {
  if (!NODE_KINDS.includes(kind)) throw new Error('Unsupported canvas node kind');
  const size = NODE_SIZE[kind];
  return {
    id: id(kind),
    kind,
    title: NODE_TITLES[kind],
    x,
    y,
    width: size.width,
    height: size.height,
    prompt: '',
    content: '',
    status: 'idle',
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    locked: false,
  };
}

type ImportedProjectOptions = {
  assetIdByStorageKey?: ReadonlyMap<string, string>;
  projectId?: string;
  now?: Date;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finiteNumber(value, fallback)));
}

function importedBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

function importedKind(value: unknown): NodeKind | null {
  if (typeof value !== 'string') return null;
  return NODE_KINDS.includes(value as NodeKind) ? (value as NodeKind) : null;
}

function importedStatus(value: unknown): CanvasNode['status'] {
  if (value === 'success' || value === 'ready') return 'ready';
  if (value === 'loading' || value === 'working') return 'working';
  if (value === 'error') return 'error';
  return 'idle';
}

function importedId(prefix: string, sourceId: unknown): string {
  const safe = typeof sourceId === 'string' ? sourceId.replace(/[^a-zA-Z0-9_-]/g, '_') : '';
  return safe && safe.length <= 60 ? `${prefix}-${safe}` : id(prefix);
}

function importedText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Convert the upstream infinite-canvas JSON shape into the module's durable
 * provider-neutral project contract. Binary storage keys are resolved by the
 * caller after ZIP assets have been written to the module's IndexedDB store.
 */
export function migrateImportedProject(
  value: unknown,
  options: ImportedProjectOptions = {},
): CanvasProject | null {
  const source = asRecord(value);
  if (!source) return null;
  const now = options.now ?? new Date();
  const sourceNodes = Array.isArray(source.nodes) ? source.nodes : null;
  if (!sourceNodes || sourceNodes.length > 2_000) return null;

  // Native module exports already have the durable shape. Normalize them while
  // assigning a fresh project id so importing cannot overwrite another project.
  if (source.schemaVersion === 1 && isCanvasProject(source)) {
    const normalized = normalizeCanvasProject(source as Partial<CanvasProject>);
    for (const node of normalized.nodes) {
      const metadata = asRecord((node as CanvasNode & { metadata?: unknown }).metadata);
      const storageKey = importedText(metadata?.storageKey);
      const mapped = storageKey ? options.assetIdByStorageKey?.get(storageKey) : undefined;
      if (mapped) node.assetId = mapped;
      node.assetUrl = undefined;
    }
    for (const session of normalized.chatSessions) {
      for (const message of session.messages) {
        for (const reference of message.references ?? []) {
          const mapped = reference.storageKey
            ? options.assetIdByStorageKey?.get(reference.storageKey)
            : undefined;
          if (mapped) reference.assetId = mapped;
          reference.assetUrl = undefined;
        }
        for (const image of message.images ?? []) {
          const mapped = image.storageKey
            ? options.assetIdByStorageKey?.get(image.storageKey)
            : undefined;
          if (mapped) image.assetId = mapped;
          image.assetUrl = undefined;
        }
      }
    }
    const imported = normalizeCanvasProject({
      ...normalized,
      id: options.projectId ?? `project-${randomUuid()}`,
      updatedAt: now.toISOString(),
    });
    return isCanvasProject(imported) ? imported : null;
  }

  const project = createProject(now, options.projectId);
  project.title = importedText(source.title, project.title).trim().slice(0, 120) || project.title;
  project.background =
    source.backgroundMode === 'dots' || source.background === 'dots'
      ? 'dots'
      : source.backgroundMode === 'plain' || source.background === 'plain'
        ? 'plain'
        : 'lines';
  const viewport = asRecord(source.viewport);
  project.viewport = {
    x: boundedNumber(viewport?.x, 0, -100_000, 100_000),
    y: boundedNumber(viewport?.y, 0, -100_000, 100_000),
    scale: boundedNumber(viewport?.k ?? viewport?.scale, 1, 0.1, 4),
  };
  if (typeof source.createdAt === 'string' && Number.isFinite(Date.parse(source.createdAt))) {
    project.createdAt = source.createdAt;
  }

  const sourceIdToNodeId = new Map<string, string>();
  const pendingGroupIds = new Map<string, string | undefined>();
  const pendingBatchRoots = new Map<string, string | undefined>();
  const pendingBatchChildren = new Map<string, string[] | undefined>();
  const pendingPrimaryImages = new Map<string, string | undefined>();

  for (const candidate of sourceNodes) {
    const record = asRecord(candidate);
    if (!record) return null;
    const kind = importedKind(record.type ?? record.kind);
    const position = asRecord(record.position);
    if (!kind || !position) return null;
    const sourceId = typeof record.id === 'string' ? record.id : null;
    if (!sourceId || sourceIdToNodeId.has(sourceId)) return null;
    const node = createNode(
      kind,
      boundedNumber(position.x, 0, -100_000, 100_000),
      boundedNumber(position.y, 0, -100_000, 100_000),
    );
    node.id = importedId(kind, sourceId);
    sourceIdToNodeId.set(sourceId, node.id);
    node.title = importedText(record.title, node.title).slice(0, 80) || node.title;
    node.width = boundedNumber(record.width, node.width, 80, 2_000);
    node.height = boundedNumber(record.height, node.height, 80, 2_000);

    const metadata = asRecord(record.metadata) ?? record;
    node.content = importedText(metadata.content ?? metadata.composerContent);
    node.prompt = importedText(metadata.prompt ?? metadata.panoramaFinalPrompt);
    node.status = importedStatus(metadata.status);
    node.error = importedText(metadata.errorDetails) || undefined;
    node.rotation = boundedNumber(metadata.rotation, 0, -360, 360);
    node.scaleX = boundedNumber(metadata.scaleX, 1, -4, 4) || 1;
    node.scaleY = boundedNumber(metadata.scaleY, 1, -4, 4) || 1;
    node.locked = importedBoolean(metadata.locked) ?? false;
    node.generationMode =
      typeof metadata.generationMode === 'string' &&
      ['text', 'image', 'video', 'audio'].includes(metadata.generationMode)
        ? (metadata.generationMode as CanvasNode['generationMode'])
        : undefined;
    node.model = importedText(metadata.model) || undefined;
    node.size = importedText(metadata.size) || undefined;
    node.quality = importedText(metadata.quality ?? metadata.vquality) || undefined;
    node.count = metadata.count === undefined ? undefined : boundedNumber(metadata.count, 1, 1, 16);
    node.seconds =
      metadata.seconds === undefined ? undefined : boundedNumber(metadata.seconds, 5, 1, 60);
    node.generateAudio = importedBoolean(metadata.generateAudio);
    node.audioVoice = importedText(metadata.audioVoice) || undefined;
    node.audioFormat = importedText(metadata.audioFormat) || undefined;
    node.audioSpeed =
      metadata.audioSpeed === undefined
        ? undefined
        : boundedNumber(metadata.audioSpeed, 1, 0.25, 4);
    node.audioInstructions = importedText(metadata.audioInstructions) || undefined;
    node.negativePrompt = importedText(metadata.negativePrompt) || undefined;
    node.references = Array.isArray(metadata.references)
      ? metadata.references.filter((item): item is string => typeof item === 'string').slice(0, 32)
      : undefined;
    node.naturalWidth =
      metadata.naturalWidth === undefined
        ? undefined
        : boundedNumber(metadata.naturalWidth, 1, 1, 20_000);
    node.naturalHeight =
      metadata.naturalHeight === undefined
        ? undefined
        : boundedNumber(metadata.naturalHeight, 1, 1, 20_000);
    node.bytes =
      metadata.bytes === undefined
        ? undefined
        : boundedNumber(metadata.bytes, 0, 0, 100 * 1024 * 1024);
    node.mimeType = importedText(metadata.mimeType) || undefined;
    node.durationMs =
      metadata.durationMs === undefined
        ? undefined
        : boundedNumber(metadata.durationMs, 0, 0, 24 * 60 * 60 * 1000);
    node.progress =
      metadata.progress === undefined ? undefined : boundedNumber(metadata.progress, 0, 0, 1);
    node.taskId =
      importedText(metadata.imageTaskId ?? metadata.videoTaskId ?? metadata.audioTaskId) ||
      undefined;
    const cameraControl = asRecord(metadata.cameraControl);
    if (cameraControl) {
      node.cameraControl = {
        enabled: importedBoolean(cameraControl.enabled) ?? true,
        camera: importedText(cameraControl.camera, 'standard').slice(0, 80),
        lens: importedText(cameraControl.lens, 'normal').slice(0, 80),
        focalLength: boundedNumber(cameraControl.focalLength, 50, 1, 400),
        aperture: boundedNumber(cameraControl.aperture, 4, 0.7, 32),
      };
    }
    node.panoramaProjection =
      metadata.panoramaProjection === 'equirectangular' ? 'equirectangular' : undefined;
    if (
      metadata.directorProject &&
      typeof metadata.directorProject === 'object' &&
      !Array.isArray(metadata.directorProject)
    ) {
      node.directorProject = metadata.directorProject as Record<string, unknown>;
    }

    const storageKey = importedText(metadata.storageKey);
    const mappedAssetId = storageKey ? options.assetIdByStorageKey?.get(storageKey) : undefined;
    node.assetId = mappedAssetId;
    node.assetName = importedText(metadata.fileName ?? metadata.assetName) || undefined;
    if (typeof metadata.dataUrl === 'string' && metadata.dataUrl.startsWith('data:image/')) {
      node.assetUrl = metadata.dataUrl;
    }
    pendingGroupIds.set(sourceId, importedText(metadata.groupId) || undefined);
    pendingBatchRoots.set(sourceId, importedText(metadata.batchRootId) || undefined);
    pendingBatchChildren.set(
      sourceId,
      Array.isArray(metadata.batchChildIds)
        ? metadata.batchChildIds.filter((item): item is string => typeof item === 'string')
        : undefined,
    );
    pendingPrimaryImages.set(sourceId, importedText(metadata.primaryImageId) || undefined);
    project.nodes.push(node);
  }

  for (const node of project.nodes) {
    const sourceId = [...sourceIdToNodeId.entries()].find(
      ([, idValue]) => idValue === node.id,
    )?.[0];
    if (!sourceId) continue;
    const groupId = pendingGroupIds.get(sourceId);
    const batchRootId = pendingBatchRoots.get(sourceId);
    const batchChildren = pendingBatchChildren.get(sourceId);
    const primaryImageId = pendingPrimaryImages.get(sourceId);
    node.groupId = groupId ? sourceIdToNodeId.get(groupId) : undefined;
    node.batchRootId = batchRootId ? sourceIdToNodeId.get(batchRootId) : undefined;
    node.batchChildIds = batchChildren
      ?.map((childId) => sourceIdToNodeId.get(childId))
      .filter((childId): childId is string => Boolean(childId));
    node.primaryImageId = primaryImageId ? sourceIdToNodeId.get(primaryImageId) : undefined;
  }

  const sourceConnections = Array.isArray(source.connections) ? source.connections : [];
  if (sourceConnections.length > 10_000) return null;
  for (const candidate of sourceConnections) {
    const record = asRecord(candidate);
    const sourceId = importedText(record?.fromNodeId ?? record?.source);
    const targetId = importedText(record?.toNodeId ?? record?.target);
    const sourceNode = sourceIdToNodeId.get(sourceId);
    const targetNode = sourceIdToNodeId.get(targetId);
    if (!record || !sourceNode || !targetNode || sourceNode === targetNode) return null;
    if (
      project.connections.some(
        (connection) => connection.source === sourceNode && connection.target === targetNode,
      )
    )
      continue;
    project.connections.push({
      id: importedId('connection', record.id),
      source: sourceNode,
      target: targetNode,
    });
  }

  const sourceSessions = Array.isArray(source.chatSessions) ? source.chatSessions : [];
  project.chatSessions = sourceSessions.slice(0, 100).flatMap((candidate) => {
    const session = asRecord(candidate);
    if (!session) return [];
    const sessionId = importedText(session.id) || id('chat');
    const messages = Array.isArray(session.messages)
      ? session.messages.slice(-200).flatMap((candidateMessage) => {
          const message = asRecord(candidateMessage);
          if (!message) return [];
          const role: 'user' | 'assistant' = message.role === 'assistant' ? 'assistant' : 'user';
          const status: AssistantMessageStatus =
            message.status === 'error'
              ? 'error'
              : message.status === 'thinking' || message.status === 'running'
                ? 'running'
                : 'success';
          const references = Array.isArray(message.references)
            ? message.references.slice(0, 32).flatMap((candidateReference) => {
                const reference = asRecord(candidateReference);
                if (!reference) return [];
                const storageKey = importedText(reference.storageKey) || undefined;
                const assetId = storageKey
                  ? options.assetIdByStorageKey?.get(storageKey)
                  : importedText(reference.assetId) || undefined;
                return [
                  {
                    id: importedText(reference.id) || id('reference'),
                    kind: importedKind(reference.type ?? reference.kind) ?? 'text',
                    title: importedText(reference.title, '参考节点').slice(0, 120),
                    text: importedText(reference.text) || undefined,
                    assetId,
                    assetUrl:
                      typeof reference.dataUrl === 'string' && reference.dataUrl.startsWith('data:')
                        ? reference.dataUrl
                        : undefined,
                    storageKey,
                  },
                ];
              })
            : undefined;
          const images = Array.isArray(message.images)
            ? message.images.slice(0, 32).flatMap((candidateImage) => {
                const image = asRecord(candidateImage);
                if (!image) return [];
                const storageKey = importedText(image.storageKey) || undefined;
                const assetId = storageKey
                  ? options.assetIdByStorageKey?.get(storageKey)
                  : importedText(image.assetId) || undefined;
                return [
                  {
                    id: importedText(image.id) || id('assistant-image'),
                    assetId,
                    assetUrl:
                      typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:')
                        ? image.dataUrl
                        : undefined,
                    storageKey,
                    prompt: importedText(image.prompt),
                  },
                ];
              })
            : undefined;
          return [
            {
              id: importedText(message.id) || id('message'),
              role,
              mode: 'ask' as const,
              text: importedText(message.text),
              status,
              error: importedText(message.error) || undefined,
              references,
              images,
              createdAt: importedText(message.createdAt, now.toISOString()),
            },
          ];
        })
      : [];
    return [
      {
        id: sessionId,
        title: importedText(session.title, '画布助手').slice(0, 120),
        mode: 'ask' as const,
        messages,
        createdAt: importedText(session.createdAt, now.toISOString()),
        updatedAt: importedText(session.updatedAt, now.toISOString()),
      },
    ];
  });
  const activeChatId = importedText(source.activeChatId) || null;
  project.activeChatId = project.chatSessions.some((session) => session.id === activeChatId)
    ? activeChatId
    : (project.chatSessions[0]?.id ?? null);

  const normalized = normalizeCanvasProject(project);
  return isCanvasProject(normalized) ? normalized : null;
}

export type EditorAction =
  | { type: 'hydrate'; project: CanvasProject }
  | { type: 'select'; ids: string[] }
  | { type: 'add'; node: CanvasNode }
  | { type: 'patch-node'; id: string; patch: Partial<CanvasNode>; transient?: boolean }
  | {
      type: 'patch-nodes';
      patches: readonly { id: string; patch: Partial<CanvasNode> }[];
      transient?: boolean;
    }
  | { type: 'duplicate-selected' }
  | { type: 'group-selected' }
  | { type: 'ungroup-selected' }
  | { type: 'delete-selected' }
  | { type: 'start-connection'; id: string | null }
  | { type: 'finish-connection'; id: string }
  | { type: 'add-connection'; source: string; target: string }
  | { type: 'remove-connection'; id: string }
  | { type: 'rename'; title: string }
  | { type: 'set-background'; background: CanvasProject['background'] }
  | { type: 'set-viewport'; viewport: CanvasProject['viewport']; transient?: boolean }
  | { type: 'commit-transient'; previous: CanvasProject }
  | { type: 'replace-project'; project: CanvasProject }
  | { type: 'upsert-chat-session'; session: AssistantSession }
  | { type: 'delete-chat-session'; id: string }
  | { type: 'set-active-chat'; id: string | null }
  | { type: 'add-generation-record'; record: GenerationRecord }
  | { type: 'patch-generation-record'; id: string; patch: Partial<GenerationRecord> }
  | { type: 'record-workflow-run'; workflowId: string; nodeIds: string[] }
  | { type: 'undo' }
  | { type: 'redo' };

function committed(state: EditorState, project: CanvasProject): EditorState {
  const updated = { ...project, updatedAt: new Date().toISOString() };
  return {
    ...state,
    project: updated,
    past: [...state.past.slice(-99), state.project],
    future: [],
  };
}

export function createEditorState(project = createProject()): EditorState {
  return { project, selectedIds: [], connectionSource: null, past: [], future: [] };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'hydrate':
      return createEditorState(normalizeCanvasProject(action.project));
    case 'select':
      return { ...state, selectedIds: [...new Set(action.ids)] };
    case 'add': {
      const existingIds = new Set(state.project.nodes.map((node) => node.id));
      const node = existingIds.has(action.node.id)
        ? { ...action.node, id: id(action.node.kind) }
        : action.node;
      return {
        ...committed(state, { ...state.project, nodes: [...state.project.nodes, node] }),
        selectedIds: [node.id],
      };
    }
    case 'patch-node': {
      const project = {
        ...state.project,
        nodes: state.project.nodes.map((node) =>
          node.id === action.id ? { ...node, ...action.patch, id: node.id } : node,
        ),
      };
      return action.transient ? { ...state, project } : committed(state, project);
    }
    case 'patch-nodes': {
      const patches = new Map(action.patches.map((item) => [item.id, item.patch]));
      const project = {
        ...state.project,
        nodes: state.project.nodes.map((node) => {
          const patch = patches.get(node.id);
          return patch ? { ...node, ...patch, id: node.id } : node;
        }),
      };
      return action.transient ? { ...state, project } : committed(state, project);
    }
    case 'duplicate-selected': {
      const selected = new Set(state.selectedIds);
      if (selected.size === 0) return state;
      const idMap = new Map<string, string>();
      const copies = state.project.nodes
        .filter((node) => selected.has(node.id))
        .map((node) => {
          const nextId = id(node.kind);
          idMap.set(node.id, nextId);
          return {
            ...structuredClone(node),
            id: nextId,
            x: node.x + 32,
            y: node.y + 32,
            title: `${node.title} 副本`,
            groupId: undefined,
          };
        });
      const connections = state.project.connections
        .filter((connection) => selected.has(connection.source) && selected.has(connection.target))
        .map((connection) => ({
          id: id('connection'),
          source: idMap.get(connection.source) ?? connection.source,
          target: idMap.get(connection.target) ?? connection.target,
        }));
      const next = committed(state, {
        ...state.project,
        nodes: [...state.project.nodes, ...copies],
        connections: [...state.project.connections, ...connections],
      });
      return { ...next, selectedIds: copies.map((node) => node.id) };
    }
    case 'group-selected': {
      const selected = state.project.nodes.filter((node) => state.selectedIds.includes(node.id));
      if (selected.length < 2) return state;
      const minX = Math.min(...selected.map((node) => node.x));
      const minY = Math.min(...selected.map((node) => node.y));
      const maxX = Math.max(...selected.map((node) => node.x + node.width));
      const maxY = Math.max(...selected.map((node) => node.y + node.height));
      const group = {
        ...createNode('group', minX - 24, minY - 56),
        width: maxX - minX + 48,
        height: maxY - minY + 80,
      };
      const selectedIds = new Set(state.selectedIds);
      const next = committed(state, {
        ...state.project,
        nodes: [
          group,
          ...state.project.nodes.map((node) =>
            selectedIds.has(node.id) ? { ...node, groupId: group.id } : node,
          ),
        ],
      });
      return { ...next, selectedIds: [group.id] };
    }
    case 'ungroup-selected': {
      const groups = new Set(
        state.project.nodes
          .filter((node) => node.kind === 'group' && state.selectedIds.includes(node.id))
          .map((node) => node.id),
      );
      if (groups.size === 0) return state;
      const next = committed(state, {
        ...state.project,
        nodes: state.project.nodes
          .filter((node) => !groups.has(node.id))
          .map((node) =>
            node.groupId && groups.has(node.groupId) ? { ...node, groupId: undefined } : node,
          ),
      });
      return { ...next, selectedIds: [] };
    }
    case 'delete-selected': {
      const selected = new Set(state.selectedIds);
      if (selected.size === 0) return state;
      const selectedBatchRoots = new Set(
        state.project.nodes
          .filter((node) => selected.has(node.id) && node.isBatchRoot)
          .map((node) => node.id),
      );
      for (const node of state.project.nodes) {
        if (node.batchRootId && selectedBatchRoots.has(node.batchRootId)) selected.add(node.id);
      }
      const next = committed(state, {
        ...state.project,
        nodes: state.project.nodes
          .filter((node) => !selected.has(node.id))
          .map((node) => {
            if (!node.batchChildIds?.some((childId) => selected.has(childId))) return node;
            const batchChildIds = node.batchChildIds.filter((childId) => !selected.has(childId));
            return {
              ...node,
              batchChildIds,
              isBatchRoot: batchChildIds.length > 0,
              primaryImageId:
                node.primaryImageId && selected.has(node.primaryImageId)
                  ? node.id
                  : node.primaryImageId,
            };
          }),
        connections: state.project.connections.filter(
          (connection) => !selected.has(connection.source) && !selected.has(connection.target),
        ),
      });
      return { ...next, selectedIds: [], connectionSource: null };
    }
    case 'start-connection':
      return { ...state, connectionSource: action.id };
    case 'finish-connection': {
      const source = state.connectionSource;
      if (!source || source === action.id) return { ...state, connectionSource: null };
      if (!state.project.nodes.some((node) => node.id === source)) {
        return { ...state, connectionSource: null };
      }
      const duplicate = state.project.connections.some(
        (connection) => connection.source === source && connection.target === action.id,
      );
      if (duplicate) return { ...state, connectionSource: null };
      const next = committed(state, {
        ...state.project,
        connections: [
          ...state.project.connections,
          { id: id('connection'), source, target: action.id },
        ],
      });
      return { ...next, connectionSource: null };
    }
    case 'add-connection': {
      if (
        action.source === action.target ||
        !state.project.nodes.some((node) => node.id === action.source) ||
        !state.project.nodes.some((node) => node.id === action.target) ||
        state.project.connections.some(
          (connection) =>
            connection.source === action.source && connection.target === action.target,
        )
      ) {
        return state;
      }
      return committed(state, {
        ...state.project,
        connections: [
          ...state.project.connections,
          { id: id('connection'), source: action.source, target: action.target },
        ],
      });
    }
    case 'remove-connection':
      return committed(state, {
        ...state.project,
        connections: state.project.connections.filter((connection) => connection.id !== action.id),
      });
    case 'rename':
      return committed(state, { ...state.project, title: action.title.slice(0, 120) });
    case 'set-background':
      return committed(state, { ...state.project, background: action.background });
    case 'set-viewport': {
      const project = { ...state.project, viewport: action.viewport };
      return action.transient ? { ...state, project } : committed(state, project);
    }
    case 'commit-transient':
      return {
        ...state,
        project: { ...state.project, updatedAt: new Date().toISOString() },
        past: [...state.past.slice(-99), action.previous],
        future: [],
      };
    case 'replace-project':
      return committed(state, normalizeCanvasProject(action.project));
    case 'upsert-chat-session': {
      const sessions = state.project.chatSessions.some(
        (session) => session.id === action.session.id,
      )
        ? state.project.chatSessions.map((session) =>
            session.id === action.session.id ? action.session : session,
          )
        : [action.session, ...state.project.chatSessions];
      return committed(state, {
        ...state.project,
        chatSessions: sessions.slice(0, 100),
        activeChatId: action.session.id,
      });
    }
    case 'delete-chat-session': {
      const chatSessions = state.project.chatSessions.filter((session) => session.id !== action.id);
      return committed(state, {
        ...state.project,
        chatSessions,
        activeChatId:
          state.project.activeChatId === action.id
            ? (chatSessions[0]?.id ?? null)
            : state.project.activeChatId,
      });
    }
    case 'set-active-chat':
      return committed(state, {
        ...state.project,
        activeChatId:
          action.id === null ||
          state.project.chatSessions.some((session) => session.id === action.id)
            ? action.id
            : state.project.activeChatId,
      });
    case 'add-generation-record':
      return committed(state, {
        ...state.project,
        generationHistory: [action.record, ...state.project.generationHistory].slice(0, 500),
      });
    case 'patch-generation-record':
      return committed(state, {
        ...state.project,
        generationHistory: state.project.generationHistory.map((record) =>
          record.id === action.id ? { ...record, ...action.patch, id: record.id } : record,
        ),
      });
    case 'record-workflow-run':
      return committed(state, {
        ...state.project,
        workflowRuns: [
          {
            id: `workflow-run-${randomUuid()}`,
            workflowId: action.workflowId,
            nodeIds: [...new Set(action.nodeIds)],
            createdAt: new Date().toISOString(),
          },
          ...state.project.workflowRuns,
        ].slice(0, 200),
      });
    case 'undo': {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future].slice(0, 100),
        selectedIds: [],
        connectionSource: null,
      };
    }
    case 'redo': {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        project: next,
        past: [...state.past, state.project].slice(-100),
        future: state.future.slice(1),
        selectedIds: [],
        connectionSource: null,
      };
    }
  }
}

export function normalizeCanvasProject(project: Partial<CanvasProject>): CanvasProject {
  return {
    ...project,
    schemaVersion: project.schemaVersion === 1 ? 1 : 1,
    id: typeof project.id === 'string' ? project.id : `project-${randomUuid()}`,
    title: typeof project.title === 'string' && project.title.trim() ? project.title : '未命名画布',
    createdAt: typeof project.createdAt === 'string' ? project.createdAt : new Date().toISOString(),
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : new Date().toISOString(),
    background:
      project.background === 'lines' || project.background === 'plain'
        ? project.background
        : 'dots',
    nodes: Array.isArray(project.nodes) ? project.nodes : [],
    connections: Array.isArray(project.connections) ? project.connections : [],
    viewport:
      project.viewport &&
      Number.isFinite(project.viewport.x) &&
      Number.isFinite(project.viewport.y) &&
      Number.isFinite(project.viewport.scale)
        ? project.viewport
        : { x: 0, y: 0, scale: 1 },
    chatSessions: Array.isArray(project.chatSessions) ? project.chatSessions : [],
    activeChatId: typeof project.activeChatId === 'string' ? project.activeChatId : null,
    generationHistory: Array.isArray(project.generationHistory) ? project.generationHistory : [],
    workflowRuns: Array.isArray(project.workflowRuns) ? project.workflowRuns : [],
  };
}

export function isCanvasProject(value: unknown): value is CanvasProject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const project = value as Partial<CanvasProject>;
  if (
    project.schemaVersion !== 1 ||
    typeof project.id !== 'string' ||
    !/^project-[0-9a-f-]{36}$/i.test(project.id) ||
    typeof project.title !== 'string' ||
    project.title.length === 0 ||
    project.title.length > 120 ||
    typeof project.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(project.createdAt)) ||
    typeof project.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(project.updatedAt)) ||
    !['dots', 'lines', 'plain'].includes(project.background ?? '') ||
    !Array.isArray(project.nodes) ||
    project.nodes.length > 2_000 ||
    !Array.isArray(project.connections) ||
    project.connections.length > 10_000 ||
    !project.viewport ||
    !Number.isFinite(project.viewport.x) ||
    !Number.isFinite(project.viewport.y) ||
    !Number.isFinite(project.viewport.scale) ||
    project.viewport.scale < 0.1 ||
    project.viewport.scale > 4
  ) {
    return false;
  }

  const nodeIds = new Set<string>();
  for (const candidate of project.nodes) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const node = candidate as CanvasNode;
    if (
      typeof node.id !== 'string' ||
      node.id.length > 80 ||
      nodeIds.has(node.id) ||
      !NODE_KINDS.includes(node.kind) ||
      typeof node.title !== 'string' ||
      node.title.length > 80 ||
      typeof node.prompt !== 'string' ||
      node.prompt.length > 50_000 ||
      typeof node.content !== 'string' ||
      node.content.length > 1_000_000 ||
      !Number.isFinite(node.x) ||
      !Number.isFinite(node.y) ||
      Math.abs(node.x) > 100_000 ||
      Math.abs(node.y) > 100_000 ||
      !Number.isFinite(node.width) ||
      !Number.isFinite(node.height) ||
      node.width < 80 ||
      node.width > 2_000 ||
      node.height < 80 ||
      node.height > 2_000 ||
      !['idle', 'working', 'ready', 'error'].includes(node.status) ||
      (node.rotation !== undefined &&
        (!Number.isFinite(node.rotation) || Math.abs(node.rotation) > 360)) ||
      (node.scaleX !== undefined &&
        (!Number.isFinite(node.scaleX) ||
          Math.abs(node.scaleX) < 0.1 ||
          Math.abs(node.scaleX) > 4)) ||
      (node.scaleY !== undefined &&
        (!Number.isFinite(node.scaleY) ||
          Math.abs(node.scaleY) < 0.1 ||
          Math.abs(node.scaleY) > 4)) ||
      (node.locked !== undefined && typeof node.locked !== 'boolean') ||
      (node.assetUrl !== undefined &&
        (typeof node.assetUrl !== 'string' ||
          (!node.assetUrl.startsWith('blob:') && !node.assetUrl.startsWith('data:image/')))) ||
      (node.crop !== undefined &&
        (!node.crop ||
          !Number.isFinite(node.crop.x) ||
          !Number.isFinite(node.crop.y) ||
          !Number.isFinite(node.crop.width) ||
          !Number.isFinite(node.crop.height) ||
          node.crop.x < 0 ||
          node.crop.y < 0 ||
          node.crop.width <= 0 ||
          node.crop.height <= 0 ||
          node.crop.x + node.crop.width > 100 ||
          node.crop.y + node.crop.height > 100)) ||
      (node.directorProject !== undefined &&
        (!node.directorProject ||
          typeof node.directorProject !== 'object' ||
          Array.isArray(node.directorProject)))
    ) {
      return false;
    }
    nodeIds.add(node.id);
  }

  const connectionIds = new Set<string>();
  for (const candidate of project.connections) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const connection = candidate as CanvasProject['connections'][number];
    if (
      typeof connection.id !== 'string' ||
      connectionIds.has(connection.id) ||
      typeof connection.source !== 'string' ||
      typeof connection.target !== 'string' ||
      connection.source === connection.target ||
      !nodeIds.has(connection.source) ||
      !nodeIds.has(connection.target)
    ) {
      return false;
    }
    connectionIds.add(connection.id);
  }

  try {
    if (new TextEncoder().encode(JSON.stringify(project)).byteLength > 1_800_000) return false;
  } catch {
    return false;
  }

  if (project.chatSessions !== undefined && !Array.isArray(project.chatSessions)) return false;
  if (project.generationHistory !== undefined && !Array.isArray(project.generationHistory)) {
    return false;
  }
  if (project.workflowRuns !== undefined && !Array.isArray(project.workflowRuns)) return false;
  if (
    project.activeChatId !== undefined &&
    project.activeChatId !== null &&
    typeof project.activeChatId !== 'string'
  ) {
    return false;
  }

  return project.schemaVersion === 1 && typeof project.id === 'string';
}
