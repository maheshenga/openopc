import { unzipSync, zipSync } from 'fflate';

import type { CanvasNode, CanvasProject } from './types';

export interface CanvasTransferAsset {
  id: string;
  name: string;
  mimeType: string;
  blob: Blob;
}

export interface CanvasExportAsset {
  storageKey: string;
  path: string;
  mimeType: string;
  bytes: number;
}

export interface CanvasExportFile {
  app: 'infinite-canvas';
  version: 3;
  exportedAt: string;
  projects: Array<{ project: CanvasProject; files: CanvasExportAsset[] }>;
}

export interface DecodedCanvasZip {
  data: CanvasExportFile;
  files: Map<string, Blob>;
}

const MAX_PROJECTS = 200;
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 500 * 1024 * 1024;

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'asset';
}

function extension(mimeType: string, name: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('mp4')) return 'mp4';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mpeg')) return 'mp3';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  const suffix = name.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return suffix?.toLowerCase() ?? 'bin';
}

function storageKeyFor(asset: CanvasTransferAsset): string {
  return `${asset.mimeType.startsWith('image/') ? 'image' : 'media'}:${asset.id}`;
}

function cloneProjectForTransfer(
  project: CanvasProject,
  assets: ReadonlyMap<string, CanvasTransferAsset>,
): CanvasProject {
  const cloned = structuredClone(project);
  for (const node of cloned.nodes) {
    if (!node.assetId) {
      node.assetUrl = undefined;
      continue;
    }
    const asset = assets.get(node.assetId);
    const storageKey = asset ? storageKeyFor(asset) : `media:${node.assetId}`;
    const metadata = (node as CanvasNode & { metadata?: Record<string, unknown> }).metadata ?? {};
    metadata.storageKey = storageKey;
    metadata.mimeType = node.mimeType ?? asset?.mimeType;
    metadata.bytes = node.bytes ?? asset?.blob.size;
    metadata.assetName = node.assetName ?? asset?.name;
    (node as CanvasNode & { metadata?: Record<string, unknown> }).metadata = metadata;
    node.assetId = undefined;
    node.assetUrl = undefined;
  }
  // Preserve assistant references/images using the same storage-key convention.
  for (const session of cloned.chatSessions) {
    for (const message of session.messages) {
      for (const reference of message.references ?? []) {
        if (!reference.assetId) continue;
        const asset = assets.get(reference.assetId);
        reference.storageKey = asset ? storageKeyFor(asset) : `media:${reference.assetId}`;
        reference.assetId = undefined;
        reference.assetUrl = undefined;
      }
      for (const image of message.images ?? []) {
        if (!image.assetId) continue;
        const asset = assets.get(image.assetId);
        image.storageKey = asset ? storageKeyFor(asset) : `image:${image.assetId}`;
        image.assetId = undefined;
        image.assetUrl = '';
      }
    }
  }
  return cloned;
}

function collectAssetIds(project: CanvasProject): string[] {
  const ids = new Set<string>();
  for (const node of project.nodes) if (node.assetId) ids.add(node.assetId);
  for (const session of project.chatSessions) {
    for (const message of session.messages) {
      for (const reference of message.references ?? [])
        if (reference.assetId) ids.add(reference.assetId);
      for (const image of message.images ?? []) if (image.assetId) ids.add(image.assetId);
    }
  }
  return [...ids];
}

export async function encodeCanvasZip(
  projects: readonly CanvasProject[],
  assets: ReadonlyMap<string, CanvasTransferAsset>,
): Promise<Blob> {
  if (projects.length > MAX_PROJECTS) throw new Error('Too many projects to export');
  const entries: Record<string, Uint8Array> = {};
  const exportedProjects: CanvasExportFile['projects'] = [];
  let totalBytes = 0;
  for (const project of projects) {
    const files: CanvasExportAsset[] = [];
    const transferProject = cloneProjectForTransfer(project, assets);
    for (const assetId of collectAssetIds(project)) {
      const asset = assets.get(assetId);
      if (!asset) continue;
      if (asset.blob.size > MAX_FILE_BYTES || totalBytes + asset.blob.size > MAX_TOTAL_BYTES) {
        throw new Error('Exported media exceeds the safe ZIP size limit');
      }
      const storageKey = storageKeyFor(asset);
      const path = `projects/${safeFileName(project.id)}/files/${safeFileName(asset.id)}.${extension(asset.mimeType, asset.name)}`;
      entries[path] = new Uint8Array(await asset.blob.arrayBuffer());
      files.push({
        storageKey,
        path,
        mimeType: asset.mimeType || asset.blob.type || 'application/octet-stream',
        bytes: asset.blob.size,
      });
      totalBytes += asset.blob.size;
    }
    exportedProjects.push({ project: transferProject, files });
  }
  const data: CanvasExportFile = {
    app: 'infinite-canvas',
    version: 3,
    exportedAt: new Date().toISOString(),
    projects: exportedProjects,
  };
  entries['projects.json'] = new TextEncoder().encode(JSON.stringify(data, null, 2));
  return new Blob([zipSync(entries, { level: 0 })], { type: 'application/zip' });
}

function isSafeZipPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 300 &&
    !path.startsWith('/') &&
    !path.includes('..') &&
    !path.includes('\\')
  );
}

export async function readCanvasZip(file: Blob): Promise<DecodedCanvasZip> {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const projectBytes = entries['projects.json'];
  if (!projectBytes) throw new Error('画布压缩包缺少 projects.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(projectBytes));
  } catch {
    throw new Error('画布压缩包的 projects.json 无效');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('画布压缩包清单无效');
  }
  const data = parsed as Partial<CanvasExportFile>;
  if (
    data.app !== 'infinite-canvas' ||
    data.version !== 3 ||
    !Array.isArray(data.projects) ||
    data.projects.length > MAX_PROJECTS
  ) {
    throw new Error('不支持的画布压缩包版本');
  }
  const referenced = new Set<string>();
  let totalBytes = 0;
  for (const entry of data.projects) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.files))
      throw new Error('画布压缩包清单损坏');
    for (const item of entry.files) {
      if (
        !item ||
        typeof item !== 'object' ||
        typeof item.path !== 'string' ||
        typeof item.storageKey !== 'string' ||
        !isSafeZipPath(item.path)
      ) {
        throw new Error('画布压缩包包含不安全路径');
      }
      if (referenced.has(item.path)) throw new Error('画布压缩包包含重复文件');
      referenced.add(item.path);
      if (referenced.size > MAX_FILES) throw new Error('画布压缩包文件数量过多');
      const bytes = entries[item.path];
      if (
        !bytes ||
        bytes.byteLength > MAX_FILE_BYTES ||
        totalBytes + bytes.byteLength > MAX_TOTAL_BYTES
      ) {
        throw new Error('画布压缩包媒体大小超出限制');
      }
      totalBytes += bytes.byteLength;
    }
  }
  const files = new Map<string, Blob>();
  for (const entry of data.projects) {
    for (const item of entry.files) {
      const bytes = entries[item.path];
      if (!bytes) continue;
      files.set(
        item.path,
        new Blob([bytes], { type: item.mimeType || 'application/octet-stream' }),
      );
    }
  }
  return { data: data as CanvasExportFile, files };
}
