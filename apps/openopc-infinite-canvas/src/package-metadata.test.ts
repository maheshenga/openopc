import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const revision = '6d0bed4eb1ad9f1ec4fe0ec635b267bcb3bc901b';

describe('Infinite Canvas package metadata', () => {
  test('pins upstream provenance and ships the required notices', async () => {
    const [upstream, notices, license, rawRegistryItem] = await Promise.all([
      readFile(resolve(root, 'UPSTREAM.md'), 'utf8'),
      readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
      readFile(resolve(root, 'LICENSE'), 'utf8'),
      readFile(resolve(root, 'registry-item.json'), 'utf8'),
    ]);
    const registryItem = JSON.parse(rawRegistryItem) as {
      files?: readonly { path?: string }[];
      module?: {
        id?: string;
        execution?: { mode?: string; entry?: string };
        openopc?: { settings?: { fields?: readonly { key?: string }[] } };
      };
    };

    expect(upstream).toContain('https://github.com/tigerowo/infinite-canvas');
    expect(upstream).toContain(revision);
    expect(upstream).toContain('AGPL-3.0');
    expect(notices).toContain(revision);
    expect(notices).toContain('ue-mannequin-retopology.license.txt');
    expect(license).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
    expect(registryItem.module).toEqual(
      expect.objectContaining({
        id: 'openopc.infinite-canvas',
        execution: { mode: 'sandboxed-web', entry: 'dist/index.html' },
      }),
    );
    expect(registryItem.files?.map((file) => file.path)).toContain('dist/UPSTREAM.md');
    expect(registryItem.module?.openopc?.settings?.fields?.map((field) => field.key)).toEqual([
      'canvas.autosave',
      'canvas.background',
      'canvas.snap_size',
      'generation.aspect_ratio',
      'generation.image_quality',
      'generation.output_count',
      'workspace.compact_mode',
      'workspace.show_image_info',
    ]);
  });
});
