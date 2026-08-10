/**
 * Guards `apps/web/public/schema/*.json` (the PUBLIC, served copies of the
 * schema) against drifting from the in-code export. Mirrors the same
 * anti-drift pattern as `packages/starter/src/__tests__/embedded.test.ts`
 * for the starter's embedded snapshot: run the generator, diff its output
 * against the committed files, fail loudly on any semantic mismatch instead
 * of silently serving a stale schema. Git may check text files out with CRLF
 * on Windows, so the comparison normalizes worktree newlines first.
 *
 * If this fails after a legitimate schema change: run
 * `bun run generate:schema` (from `packages/manifest-schema`) and commit
 * the result.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_FILES, SCHEMA_OUT_DIR, renderSchemaFile } from '../../scripts/generate-schema';

function normalizeWorktreeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

describe('apps/web/public/schema/*.json — committed files match the generated export', () => {
  test('normalizes Git checkout newlines without changing schema content', () => {
    expect(normalizeWorktreeNewlines('{\r\n  "ok": true\r\n}\r')).toBe('{\n  "ok": true\n}\n');
  });

  for (const [filename, schema] of Object.entries(SCHEMA_FILES)) {
    test(`${filename} is in sync`, () => {
      const path = join(SCHEMA_OUT_DIR, filename);
      expect(existsSync(path)).toBe(true);
      const onDisk = readFileSync(path, 'utf8');
      expect(normalizeWorktreeNewlines(onDisk)).toBe(renderSchemaFile(schema));
    });
  }
});
