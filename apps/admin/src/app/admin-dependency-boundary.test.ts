import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';

const ADMIN_ROOT = resolve(import.meta.dir, '../..');
const ADMIN_SOURCE_ROOT = resolve(ADMIN_ROOT, 'src');
const SOURCE_EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.mtsx', '.js', '.jsx', '.json'] as const;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)
      ? [path]
      : [];
  });
}

function resolvesInsideAdmin(specifier: string, sourceFile: string): boolean {
  const base = specifier.startsWith('@/')
    ? resolve(ADMIN_SOURCE_ROOT, specifier.slice(2))
    : resolve(dirname(sourceFile), specifier);
  const candidates = [
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ];
  return candidates.some((candidate) => existsSync(candidate));
}

test('keeps the Admin production dependency closure independent from Web source', () => {
  const tsconfig = readFileSync(resolve(ADMIN_ROOT, 'tsconfig.json'), 'utf8').replaceAll('\\', '/');
  const globals = readFileSync(resolve(ADMIN_SOURCE_ROOT, 'app/globals.css'), 'utf8').replaceAll(
    '\\',
    '/',
  );
  const unresolvedAliases: Array<{ file: string; specifier: string }> = [];
  const webSourceReferences: string[] = [];

  for (const file of sourceFiles(ADMIN_SOURCE_ROOT)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier?.replaceAll('\\', '/').includes('apps/web')) {
        webSourceReferences.push(`${file}:${specifier}`);
      }
      if (specifier?.startsWith('@/') && !resolvesInsideAdmin(specifier, file)) {
        unresolvedAliases.push({ file, specifier });
      }
    }
  }

  expect(tsconfig).not.toContain('../web');
  expect(tsconfig).not.toContain('@web-translations');
  expect(globals).not.toContain('../web');
  expect(webSourceReferences).toEqual([]);
  expect(unresolvedAliases).toEqual([]);
  expect(extname(resolve(ADMIN_SOURCE_ROOT, 'app/layout.tsx'))).toBe('.tsx');
});
