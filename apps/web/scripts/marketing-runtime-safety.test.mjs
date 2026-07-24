import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const readSource = (relativePath) =>
  readFile(new URL(`../src/${relativePath}`, import.meta.url), 'utf8');

test('marketing icons use React-compatible SVG gradient attributes', async () => {
  const source = await readSource('features/icon/icon.tsx');

  assert.doesNotMatch(source, /\bstop-(?:color|opacity)=/);
});

test('marketing shaders receive concrete colors instead of CSS variables', async () => {
  const sources = await Promise.all([
    readSource('features/marketing/usp/for-you-panel.tsx'),
    readSource('features/marketing/security/security.tsx'),
  ]);

  for (const source of sources) {
    const colors = source.match(/colors=\{\[([^\]]+)\]\}/)?.[1];
    assert.ok(colors, 'expected a Heatmap colors prop');
    assert.doesNotMatch(colors, /var\(/);
  }
});
