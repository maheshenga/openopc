import { describe, expect, test } from 'bun:test';

import { composeGenerationInput } from './generation';
import { createNode, createProject } from './project-state';

describe('generation input composition', () => {
  test('combines direct upstream text, references, and camera settings without credentials', () => {
    const text = { ...createNode('text', 0, 0), id: 'text-1', content: '轻量、防水、耐磨' };
    const reference = {
      ...createNode('image', 0, 300),
      id: 'image-1',
      assetId: 'asset-local-1',
      assetUrl: 'blob:reference',
      assetName: '参考图.png',
      status: 'ready' as const,
    };
    const target = {
      ...createNode('image', 500, 0),
      id: 'target',
      prompt: '制作电商主图',
      negativePrompt: '模糊，文字错误',
      cameraControl: {
        enabled: true,
        camera: 'cinema',
        lens: 'macro',
        focalLength: 85,
        aperture: 2.8,
      },
    };
    const project = {
      ...createProject(),
      nodes: [text, reference, target],
      connections: [
        { id: 'edge-1', source: text.id, target: target.id },
        { id: 'edge-2', source: reference.id, target: target.id },
      ],
    };

    const input = composeGenerationInput(project, target);
    expect(input.prompt).toContain('制作电商主图');
    expect(input.prompt).toContain('轻量、防水、耐磨');
    expect(input.prompt).toContain('85mm');
    expect(input.negativePrompt).toBe('模糊，文字错误');
    expect(input.referenceAssetIds).toEqual(['asset-local-1']);
    expect(JSON.stringify(input)).not.toContain('apiKey');
  });

  test('marks panorama generation as unavailable until the SDK exposes strict 2:1 output', () => {
    const panorama = { ...createNode('panorama', 0, 0), prompt: '海边日落环境' };
    const input = composeGenerationInput({ ...createProject(), nodes: [panorama] }, panorama);

    expect(input.requiredAspectRatio).toBe('2:1');
    expect(input.capabilityGap).toContain('2:1');
  });
});
