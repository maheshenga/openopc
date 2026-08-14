import type { CanvasNode, CanvasProject, GenerationMode } from './types';

export interface ComposedGenerationInput {
  mode: GenerationMode;
  prompt: string;
  negativePrompt?: string;
  referenceAssetIds: string[];
  quality?: string;
  size?: string;
  outputCount: number;
  requiredAspectRatio?: '2:1';
  capabilityGap?: string;
  advanced?: Record<string, unknown>;
}

function generationMode(node: CanvasNode): GenerationMode {
  if (node.kind === 'config') return node.generationMode ?? 'image';
  if (
    node.kind === 'text' ||
    node.kind === 'image' ||
    node.kind === 'video' ||
    node.kind === 'audio'
  ) {
    return node.kind;
  }
  return 'image';
}

function cameraPrompt(node: CanvasNode): string {
  const camera = node.cameraControl;
  if (!camera?.enabled) return '';
  return [
    `Camera: ${camera.camera}`,
    `lens: ${camera.lens}`,
    `focal length: ${camera.focalLength}mm`,
    `aperture: f/${camera.aperture}`,
  ].join(', ');
}

export function composeGenerationInput(
  project: CanvasProject,
  node: CanvasNode,
): ComposedGenerationInput {
  const nodeById = new Map(project.nodes.map((candidate) => [candidate.id, candidate]));
  const upstream = project.connections.flatMap((connection) => {
    if (connection.target !== node.id) return [];
    const source = nodeById.get(connection.source);
    return source ? [source] : [];
  });
  const upstreamText = upstream
    .filter((source) => source.kind === 'text' || source.kind === 'config')
    .map((source) => source.content || source.prompt)
    .filter(Boolean);
  const references = upstream
    .filter((source) => source.kind === 'image' || source.kind === 'panorama')
    .map((source) => source.assetId)
    .filter((assetId): assetId is string => Boolean(assetId));
  const prompt = [node.prompt, ...upstreamText, cameraPrompt(node)]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8_000);
  const outputCount = Number.isSafeInteger(node.count)
    ? Math.max(1, Math.min(8, node.count ?? 1))
    : 1;
  const panorama = node.kind === 'panorama';
  return {
    mode: generationMode(node),
    prompt,
    negativePrompt: node.negativePrompt?.trim().slice(0, 4_000) || undefined,
    referenceAssetIds: [...new Set(references)].slice(0, 8),
    quality: node.quality,
    size: node.size,
    outputCount,
    requiredAspectRatio: panorama ? '2:1' : undefined,
    capabilityGap: panorama
      ? '当前 OpenOPC image.generate 契约未提供严格 2:1（2048×1024）输出比例'
      : undefined,
    advanced: node.cameraControl?.enabled
      ? {
          camera_control: {
            camera: node.cameraControl.camera,
            lens: node.cameraControl.lens,
            focal_length_mm: node.cameraControl.focalLength,
            aperture: node.cameraControl.aperture,
          },
        }
      : undefined,
  };
}
