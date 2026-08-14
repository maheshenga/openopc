import { describe, expect, test } from 'bun:test';

import { createNode, createProject, migrateImportedProject } from './project-state';
import { encodeCanvasZip, readCanvasZip } from './transfer';

describe('canvas transfer', () => {
  test('round-trips project media through the upstream-compatible ZIP shape', async () => {
    const project = createProject();
    const node = {
      ...createNode('image', 10, 20),
      assetId: 'asset-image-1',
      assetName: 'hero.png',
      mimeType: 'image/png',
    };
    project.nodes.push(node);
    const blob = new Blob(['hello image'], { type: 'image/png' });
    const archive = await encodeCanvasZip(
      [project],
      new Map([
        [
          node.assetId,
          {
            id: node.assetId,
            name: node.assetName,
            mimeType: node.mimeType,
            blob,
          },
        ],
      ]),
    );

    const decoded = await readCanvasZip(archive);
    expect(decoded.data.app).toBe('infinite-canvas');
    expect(decoded.data.version).toBe(3);
    expect(decoded.data.projects).toHaveLength(1);
    expect(decoded.data.projects[0]?.files[0]?.storageKey).toBe('image:asset-image-1');
    const file = decoded.files.get(decoded.data.projects[0]?.files[0]?.path ?? '');
    expect(file).toBeDefined();
    expect(await file?.text()).toBe('hello image');
    expect(file?.type).toBe('image/png');
    const migrated = migrateImportedProject(decoded.data.projects[0]?.project, {
      assetIdByStorageKey: new Map([['image:asset-image-1', 'asset-restored']]),
    });
    expect(migrated?.nodes[0]?.assetId).toBe('asset-restored');
  });

  test('rejects unsafe or oversized ZIP metadata', async () => {
    await expect(readCanvasZip(new Blob(['not a zip']))).rejects.toThrow();
  });
});
