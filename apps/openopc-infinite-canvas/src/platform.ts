import {
  type OpenOpcEffectiveModuleSettings,
  type OpenOpcChatMessage,
  type OpenOpcModel,
  type OpenOpcModuleClient,
  type OpenOpcModuleContext,
  type OpenOpcModuleDocument,
  OpenOpcModuleServiceError,
  type OpenOpcRequestOptions,
  createOpenOpcBrowserModuleClient,
} from '@openopc/developer-sdk';

import { isCanvasProject } from './project-state';
import type { CanvasProject } from './types';

export type PlatformStatus = 'connecting' | 'ready' | 'local-only' | 'error';

export interface RemoteCanvasProject {
  project: CanvasProject;
  revision: number;
}

export class PlatformConflictError extends Error {
  readonly code = 'MODULE_SERVICE_CONFLICT' as const;

  constructor() {
    super('MODULE_SERVICE_CONFLICT');
    this.name = 'PlatformConflictError';
  }
}

export interface PlatformBridge {
  readonly client: OpenOpcModuleClient | null;
  readonly context: OpenOpcModuleContext | null;
  readonly namespace: string;
  readonly status: PlatformStatus;
  readonly settings: OpenOpcEffectiveModuleSettings | null;
  readonly models: readonly OpenOpcModel[];
  readonly errorMessage: string | null;
  readProject(
    projectId: string,
    options?: OpenOpcRequestOptions,
  ): Promise<RemoteCanvasProject | null>;
  listProjects(options?: OpenOpcRequestOptions): Promise<RemoteCanvasProject[]>;
  writeProject(
    project: CanvasProject,
    expectedRevision: number | null,
    options?: OpenOpcRequestOptions,
  ): Promise<OpenOpcModuleDocument | null>;
  deleteProject(projectId: string, options?: OpenOpcRequestOptions): Promise<void>;
  generateText(
    prompt: string,
    options?: OpenOpcRequestOptions,
    input?: { referenceBlobs?: readonly Blob[] },
  ): Promise<string>;
  generateImage(
    prompt: string,
    options?: OpenOpcRequestOptions,
    input?: {
      negativePrompt?: string;
      referenceBlobs?: readonly { blob: Blob; filename: string }[];
      aspectRatio?: '1:1' | '4:3' | '3:4' | '16:9' | '9:16';
      quality?: 'standard' | 'high';
      outputCount?: number;
      advanced?: Record<string, unknown>;
    },
  ): Promise<readonly { assetId: string; url: string; blob: Blob | null }[]>;
  dispose(): void;
}

const FALLBACK_SETTINGS: OpenOpcEffectiveModuleSettings = {
  schema_version: 1,
  revision: 0,
  values: {
    'canvas.autosave': true,
    'canvas.background': 'dots',
    'canvas.snap_size': 8,
    'generation.aspect_ratio': '1:1',
    'generation.image_quality': 'standard',
    'generation.output_count': 1,
    'workspace.compact_mode': false,
    'workspace.show_image_info': false,
  },
  loaded_at: new Date(0).toISOString(),
};

function projectKey(projectId: string): string {
  return `canvas/${projectId}`;
}

function settingString(
  settings: OpenOpcEffectiveModuleSettings | null,
  key: string,
  fallback: string,
): string {
  const value = settings?.values[key];
  return typeof value === 'string' && value ? value : fallback;
}

function settingInteger(
  settings: OpenOpcEffectiveModuleSettings | null,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = settings?.values[key];
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function platformError(error: unknown): Error {
  if (error instanceof OpenOpcModuleServiceError) {
    if (error.status === 409 || error.code === 'MODULE_SERVICE_CONFLICT') {
      return new PlatformConflictError();
    }
    return new Error(`平台服务暂不可用（${error.code}）`);
  }
  if (error instanceof Error && error.message) return error;
  return new Error('平台服务暂不可用');
}

function jsonProject(value: unknown): CanvasProject | null {
  return isCanvasProject(value) ? value : null;
}

function textFromCompletion(value: { choices?: readonly Record<string, unknown>[] }): string {
  const message = value.choices?.[0]?.message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

async function blobDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

export async function createPlatformBridge(signal: AbortSignal): Promise<PlatformBridge> {
  let client: OpenOpcModuleClient | null = null;
  let status: PlatformStatus;
  let settings: OpenOpcEffectiveModuleSettings | null = FALLBACK_SETTINGS;
  let models: readonly OpenOpcModel[] = [];
  let errorMessage: string | null = null;

  try {
    client = await createOpenOpcBrowserModuleClient({ signal });
    try {
      settings = await client.settings.read({ signal });
    } catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      settings = FALLBACK_SETTINGS;
      errorMessage = '平台设置暂不可用，已使用模块默认设置。';
    }
    try {
      models = (await client.ai.models.list({ signal })).data;
    } catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      models = [];
      errorMessage ??= '平台模型目录暂不可用，生成操作会显示明确的降级提示。';
    }
    status = 'ready';
  } catch (error) {
    if (signal.aborted) throw error;
    status = 'local-only';
    settings = FALLBACK_SETTINGS;
    errorMessage = '模块未嵌入平台，已切换到本地画布；平台生成与同步将在嵌入后启用。';
  }

  return {
    client,
    context: client?.context ?? null,
    namespace: client?.context
      ? `${client.context.projectId}:${client.context.installationId}`
      : 'local',
    status,
    settings,
    models,
    errorMessage,
    async readProject(projectId, options) {
      if (!client) return null;
      try {
        const document = await client.data.documents.read(projectKey(projectId), options);
        const project = jsonProject(document.value);
        return project ? { project, revision: document.revision } : null;
      } catch (error) {
        if (error instanceof OpenOpcModuleServiceError && error.status === 404) return null;
        throw platformError(error);
      }
    },
    async listProjects(options) {
      if (!client) return [];
      const projects: RemoteCanvasProject[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page += 1) {
        const response = await client.data.documents.list({ cursor, limit: 100 }, options);
        for (const document of response.data) {
          if (!document.key.startsWith('canvas/')) continue;
          const project = jsonProject(document.value);
          if (project) projects.push({ project, revision: document.revision });
        }
        cursor = response.next_cursor;
        if (!cursor) break;
      }
      return projects;
    },
    async writeProject(project, expectedRevision, options) {
      if (!client) return null;
      try {
        return await client.data.documents.write(
          projectKey(project.id),
          { expected_revision: expectedRevision, value: project },
          options,
        );
      } catch (error) {
        throw platformError(error);
      }
    },
    async deleteProject(projectId, options) {
      if (!client) return;
      try {
        const current = await client.data.documents.read(projectKey(projectId), options);
        await client.data.documents.delete(projectKey(projectId), current.revision, options);
      } catch (error) {
        if (error instanceof OpenOpcModuleServiceError && error.status === 404) return;
        throw platformError(error);
      }
    },
    async generateText(prompt, options, requested) {
      if (!client || models.length === 0) {
        throw new Error('平台没有可用的文本模型');
      }
      const requestedBlobs =
        requested?.referenceBlobs?.filter(
          (blob) => blob.type.startsWith('image/') && blob.size > 0,
        ) ?? [];
      const model = models.find(
        (candidate) =>
          candidate.capabilities?.modalities.includes('text') &&
          (requestedBlobs.length === 0 || candidate.capabilities.modalities.includes('image')),
      );
      if (!model) {
        throw new Error(
          requestedBlobs.length ? '平台没有可用的多模态文本模型' : '平台没有可用的文本模型',
        );
      }
      const imageCapability = model.capabilities?.vision ?? model.capabilities?.attachment;
      const accepted = new Set<string>(imageCapability?.accepted_mime_types ?? []);
      const boundedBlobs: Blob[] = [];
      let totalReferenceBytes = 0;
      for (const blob of requestedBlobs) {
        if (!imageCapability || boundedBlobs.length >= imageCapability.max_images) break;
        if (accepted.size > 0 && !accepted.has(blob.type)) continue;
        if (
          blob.size > imageCapability.max_bytes_per_image ||
          totalReferenceBytes + blob.size > imageCapability.max_total_bytes
        ) {
          continue;
        }
        boundedBlobs.push(blob);
        totalReferenceBytes += blob.size;
      }
      const content: OpenOpcChatMessage['content'] = boundedBlobs.length
        ? [
            { type: 'text', text: prompt.slice(0, 1_000_000) },
            ...(await Promise.all(
              boundedBlobs.map(async (blob) => ({
                type: 'image_url' as const,
                image_url: {
                  url: await blobDataUrl(blob),
                  detail: 'high' as const,
                  size_bytes: blob.size,
                },
              })),
            )),
          ]
        : prompt;
      const completion = await client.ai.chat.create(
        {
          model: model.id,
          messages: [{ role: 'user', content }],
          stream: false,
          max_completion_tokens: 2_000,
        },
        options,
      );
      const text = textFromCompletion(completion);
      if (!text) throw new Error('平台未返回文本结果');
      return text;
    },
    async generateImage(prompt, options, requested) {
      if (!client) throw new Error('模块未嵌入平台');
      const imageModels = (await client.ai.images.models.list(options)).data;
      const configuredAspectRatio = settingString(settings, 'generation.aspect_ratio', '1:1');
      const aspectRatio =
        requested?.aspectRatio ??
        (['1:1', '4:3', '3:4', '16:9', '9:16'].includes(configuredAspectRatio)
          ? (configuredAspectRatio as '1:1' | '4:3' | '3:4' | '16:9' | '9:16')
          : '1:1');
      const configuredQuality = settingString(settings, 'generation.image_quality', 'standard');
      const quality = requested?.quality ?? (configuredQuality === 'high' ? 'high' : 'standard');
      const model =
        imageModels.find(
          (candidate) =>
            candidate.capabilities.output.aspect_ratios.includes(aspectRatio) &&
            candidate.capabilities.output.qualities.includes(quality),
        ) ?? imageModels[0];
      if (!model) throw new Error('平台没有可用的图片模型');
      if (!model.capabilities.output.aspect_ratios.includes(aspectRatio)) {
        throw new Error(`所选图片模型不支持 ${aspectRatio} 比例`);
      }
      if (!model.capabilities.output.qualities.includes(quality)) {
        throw new Error(`所选图片模型不支持 ${quality} 质量`);
      }
      const temporaryReferenceIds: string[] = [];
      try {
        for (const reference of requested?.referenceBlobs?.slice(0, 8) ?? []) {
          const asset = await client.ai.images.assets.create(
            reference.blob,
            {
              filename: reference.filename.slice(0, 255) || 'canvas-reference.png',
              retention: 'temporary',
              metadata: { source: 'openopc.infinite-canvas' },
            },
            options,
          );
          temporaryReferenceIds.push(asset.asset_id);
        }
        const input = {
          prompt: prompt.slice(0, 8_000),
          ...(requested?.negativePrompt
            ? { negative_prompt: requested.negativePrompt.slice(0, 4_000) }
            : {}),
          ...(temporaryReferenceIds.length ? { reference_asset_ids: temporaryReferenceIds } : {}),
          aspect_ratio: aspectRatio,
          quality,
          output_count: Math.min(
            model.capabilities.output.max_images,
            Math.max(
              model.capabilities.output.min_images,
              requested?.outputCount ??
                settingInteger(settings, 'generation.output_count', 1, 1, 8),
            ),
          ),
          ...(requested?.advanced ? { advanced: requested.advanced } : {}),
        };
        const estimate = await client.ai.images.estimates.create(
          { model: model.id, input },
          options,
        );
        const job = await client.ai.images.jobs.create(
          {
            model: model.id,
            input,
            estimate_id: estimate.estimate_id,
            estimate_token: estimate.estimate_token,
            idempotency_key: `canvas-${crypto.randomUUID()}`,
          },
          options,
        );
        const terminal = await client.ai.images.jobs.waitForTerminal(job.job_id, options);
        if (terminal.status !== 'succeeded') throw new Error('图片生成未完成');
        const outputs = await client.ai.images.jobs.outputs(job.job_id, undefined, options);
        if (outputs.items.length === 0) throw new Error('平台未返回图片资源');
        return Promise.all(
          outputs.items.map(async (asset) => {
            const preview = await client.ai.images.assets.preview(asset.asset_id, options);
            try {
              return {
                assetId: asset.asset_id,
                url: preview.url,
                blob: await client.ai.images.assets.download(asset.asset_id, options),
              };
            } catch (error) {
              if (options?.signal?.aborted) throw error;
              return { assetId: asset.asset_id, url: preview.url, blob: null };
            }
          }),
        );
      } finally {
        await Promise.allSettled(
          temporaryReferenceIds.map((assetId) => client.ai.images.assets.delete(assetId, options)),
        );
      }
    },
    dispose() {
      // The caller owns the AbortController; this hook exists for a stable lifecycle contract.
    },
  };
}
