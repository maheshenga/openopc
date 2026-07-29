import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { computePublicBetaSha256 } from './public-beta-canonical-json';
import {
  type PublicBetaFileReference,
  readPublicBetaVerifiedBytes,
  readPublicBetaVerifiedJson,
  verifyPublicBetaFile,
} from './public-beta-safe-files';

function materializeVerifiedFile(root: string, path: string, contents: Uint8Array | string) {
  const absolute = join(root, ...path.split('/'));
  const bytes = typeof contents === 'string' ? new TextEncoder().encode(contents) : contents;
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, bytes);
  return {
    root,
    path,
    digest: computePublicBetaSha256(bytes),
    sizeBytes: bytes.byteLength,
    maxBytes: 1024,
  } satisfies PublicBetaFileReference;
}

describe('readPublicBetaVerifiedBytes', () => {
  test('accepts a valid file when native realpath canonicalizes the root spelling', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-safe-files-'));
    try {
      const lexicalRoot = resolve(root);
      const canonicalRoot = realpathSync.native(lexicalRoot);
      if (process.platform === 'win32' && lexicalRoot.includes('~')) {
        expect(canonicalRoot).not.toBe(lexicalRoot);
      }

      const reference = materializeVerifiedFile(root, 'verified/evidence.json', '{"ok":true}');
      expect(readPublicBetaVerifiedJson(reference)?.value).toEqual({ ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects size, digest, UTF-8, JSON, symlink, junction, and replacement attacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-safe-files-'));
    try {
      const reference = materializeVerifiedFile(root, 'verified/evidence.json', '{"ok":true}');
      expect(readPublicBetaVerifiedJson(reference)?.value).toEqual({ ok: true });
      expect(readPublicBetaVerifiedJson({ ...reference, sizeBytes: reference.sizeBytes + 1 })).toBe(
        false,
      );
      expect(
        readPublicBetaVerifiedJson({
          ...reference,
          digest: `sha256:${'0'.repeat(64)}`,
        }),
      ).toBe(false);

      const invalidUtf8 = materializeVerifiedFile(
        root,
        'attacks/invalid-utf8.json',
        Uint8Array.of(0xc3, 0x28),
      );
      expect(readPublicBetaVerifiedJson(invalidUtf8)).toBe(false);

      const malformedJson = materializeVerifiedFile(root, 'attacks/malformed-json.json', '{');
      expect(readPublicBetaVerifiedJson(malformedJson)).toBe(false);

      const target = materializeVerifiedFile(root, 'targets/file.json', '{"target":true}');
      const symlinkPath = join(root, 'attacks', 'symlink.json');
      mkdirSync(join(root, 'attacks'), { recursive: true });
      symlinkSync(join(root, 'targets', 'file.json'), symlinkPath, 'file');
      expect(readPublicBetaVerifiedBytes({ ...target, path: 'attacks/symlink.json' })).toBe(false);

      const junctionPath = join(root, 'attacks', 'junction');
      try {
        symlinkSync(join(root, 'targets'), junctionPath, 'junction');
        expect(readPublicBetaVerifiedBytes({ ...target, path: 'attacks/junction/file.json' })).toBe(
          false,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      }

      const replacement = materializeVerifiedFile(root, 'attacks/replacement.json', '{"ok":true}');
      writeFileSync(join(root, 'attacks', 'replacement.json'), '{"changed":true}');
      expect(readPublicBetaVerifiedJson(replacement)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects invalid paths, unsafe limits, and oversized files', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-safe-files-'));
    try {
      const reference = materializeVerifiedFile(root, 'verified/file.json', '{"ok":true}');
      expect(readPublicBetaVerifiedBytes({ ...reference, path: '../outside.json' })).toBe(false);
      expect(readPublicBetaVerifiedBytes({ ...reference, path: `${'a/'.repeat(32)}file.json` })).toBe(
        false,
      );
      expect(readPublicBetaVerifiedBytes({ ...reference, maxBytes: 0 })).toBe(false);
      expect(readPublicBetaVerifiedBytes({ ...reference, maxBytes: reference.sizeBytes - 1 })).toBe(
        false,
      );
      expect(
        readPublicBetaVerifiedBytes({ ...reference, path: `${'a'.repeat(1025)}.json` }),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('streams a local release artifact under the 10 GiB candidate bound', () => {
    const root = mkdtempSync(join(tmpdir(), 'openopc-public-beta-safe-files-'));
    try {
      const reference = materializeVerifiedFile(root, 'artifacts/local-release.bin', 'release');
      expect(
        verifyPublicBetaFile({
          root: reference.root,
          path: reference.path,
          digest: reference.digest,
          maxBytes: 10 * 1024 * 1024 * 1024,
        }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
