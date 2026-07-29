import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../../..');
const dockerfile = readFileSync(resolve(repoRoot, 'apps/api/Dockerfile'), 'utf8');
const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'apps/api/package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
};

function stageBetween(start: string, end: string): string {
  const startIndex = dockerfile.indexOf(start);
  const endIndex = dockerfile.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing Dockerfile stage boundary: ${start}`);
  return dockerfile.slice(startIndex, endIndex);
}

test('API image carries product-brand through dependency installation and runtime resolution', () => {
  expect(packageJson.dependencies?.['@kortix/product-brand']).toBe('workspace:*');

  const depsStage = stageBetween('# ---- Deps Stage ----', '# ---- Runner Stage ----');
  expect(depsStage).toContain('COPY packages/product-brand ./packages/product-brand');

  const runnerStage = dockerfile.slice(dockerfile.indexOf('# ---- Runner Stage ----'));
  expect(runnerStage).toContain(
    'COPY --from=deps /app/packages/product-brand ./packages/product-brand',
  );
});
