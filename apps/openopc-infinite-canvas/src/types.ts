export const NODE_KINDS = [
  'text',
  'image',
  'video',
  'audio',
  'panorama',
  'director',
  'config',
  'group',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];
export type CanvasBackground = 'dots' | 'lines' | 'plain';
export type NodeStatus = 'idle' | 'working' | 'ready' | 'error';
export type GenerationMode = 'text' | 'image' | 'video' | 'audio';

export interface CameraControlOptions {
  enabled: boolean;
  camera: string;
  lens: string;
  focalLength: number;
  aperture: number;
}

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  prompt: string;
  content: string;
  assetUrl?: string;
  assetId?: string;
  platformAssetId?: string;
  assetName?: string;
  status: NodeStatus;
  error?: string;
  rotation: number;
  scaleX: number;
  scaleY: number;
  locked: boolean;
  groupId?: string;
  crop?: { x: number; y: number; width: number; height: number };
  directorProject?: Record<string, unknown>;
  generationMode?: GenerationMode;
  model?: string;
  size?: string;
  quality?: string;
  count?: number;
  seconds?: number;
  generateAudio?: boolean;
  audioVoice?: string;
  audioFormat?: string;
  audioSpeed?: number;
  audioInstructions?: string;
  negativePrompt?: string;
  references?: string[];
  naturalWidth?: number;
  naturalHeight?: number;
  bytes?: number;
  mimeType?: string;
  durationMs?: number;
  progress?: number;
  taskId?: string;
  cameraControl?: CameraControlOptions;
  isBatchRoot?: boolean;
  batchRootId?: string;
  batchChildIds?: string[];
  primaryImageId?: string;
  imageBatchExpanded?: boolean;
  panoramaProjection?: 'equirectangular';
}

export interface CanvasConnection {
  id: string;
  source: string;
  target: string;
}

export interface CanvasViewport {
  x: number;
  y: number;
  scale: number;
}

export type AssistantMode = 'ask' | 'image';
export type AssistantMessageStatus = 'thinking' | 'running' | 'success' | 'error' | 'stopped';

export interface AssistantReference {
  id: string;
  kind: NodeKind;
  title: string;
  text?: string;
  assetId?: string;
  assetUrl?: string;
  storageKey?: string;
}

export interface AssistantImage {
  id: string;
  assetId?: string;
  assetUrl?: string;
  storageKey?: string;
  prompt: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  mode: AssistantMode;
  text: string;
  status: AssistantMessageStatus;
  error?: string;
  references?: AssistantReference[];
  images?: AssistantImage[];
  createdAt: string;
}

export interface AssistantSession {
  id: string;
  title: string;
  mode: AssistantMode;
  messages: AssistantMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface GenerationRecord {
  id: string;
  nodeId: string;
  kind: NodeKind;
  prompt: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unavailable';
  error?: string;
  assetIds?: string[];
  settings?: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRun {
  id: string;
  workflowId: string;
  nodeIds: string[];
  createdAt: string;
}

export interface PromptRecord {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  coverUrl?: string;
  resultUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowVariable {
  key: string;
  label: string;
  defaultValue: string;
}

export interface WorkflowStep {
  id: string;
  kind: NodeKind;
  title: string;
  prompt: string;
}

export interface WorkflowRecord {
  id: string;
  title: string;
  description: string;
  variables: WorkflowVariable[];
  steps: WorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface CanvasProject {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  background: CanvasBackground;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  chatSessions: AssistantSession[];
  activeChatId: string | null;
  generationHistory: GenerationRecord[];
  workflowRuns: WorkflowRun[];
}

export interface EditorState {
  project: CanvasProject;
  selectedIds: string[];
  connectionSource: string | null;
  past: CanvasProject[];
  future: CanvasProject[];
}
