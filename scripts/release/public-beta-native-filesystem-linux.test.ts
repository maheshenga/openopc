import { afterEach, describe, expect, it } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPublicBetaNativeFilesystem } from './public-beta-native-filesystem';

const linuxDescribe = process.platform === 'linux' ? describe : describe.skip;
const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openopc-native-linux-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

linuxDescribe('public beta native filesystem (Linux)', () => {
  it('uses owner-only directory/file modes and exact regular-file membership', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const privateDirectory = filesystem.createPrivateDirectory(root, 'verification-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) return;
    const bytes = new TextEncoder().encode('linux bytes');
    const file = filesystem.writeExclusiveFile(privateDirectory, 'payload.bin', bytes);
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.readFile(file, 1024)).toEqual(bytes);
    const payloadPath = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(payloadPath).not.toBe(false);
    if (payloadPath !== false) {
      const privatePath = payloadPath.slice(0, payloadPath.lastIndexOf('/'));
      expect(lstatSync(privatePath).mode & 0o777).toBe(0o700);
      expect(lstatSync(payloadPath).mode & 0o777).toBe(0o600);
      expect(new Uint8Array(readFileSync(payloadPath))).toEqual(bytes);
    }
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(true);
    const extra = filesystem.writeExclusiveFile(
      privateDirectory,
      'extra.bin',
      new TextEncoder().encode('extra'),
    );
    expect(extra).not.toBe(false);
    if (extra !== false) expect(filesystem.closeFile(extra)).toBe(true);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(false);
    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin', 'extra.bin'])).toBe(
      'retained',
    );
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('anchors creation to the retained dirfd when the root spelling is replaced', () => {
    const rootPath = makeRoot();
    const movedPath = `${rootPath}-moved`;
    const outsidePath = `${rootPath}-outside`;
    mkdirSync(outsidePath);
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    renameSync(rootPath, movedPath);
    symlinkSync(outsidePath, rootPath);
    const privateDirectory = filesystem.createPrivateDirectory(root, 'anchored-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory !== false) {
      const file = filesystem.writeExclusiveFile(privateDirectory, 'payload.bin', new TextEncoder().encode('anchored'));
      expect(file).not.toBe(false);
      if (file !== false) expect(filesystem.closeFile(file)).toBe(true);
      expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(true);
      expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin'])).toBe('retained');
      expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    }
    expect(lstatSync(outsidePath).isDirectory()).toBe(true);
    unlinkSync(rootPath);
    expect(filesystem.closeDirectory(root)).toBe(true);
    rmSync(movedPath, { recursive: true, force: true });
    rmSync(outsidePath, { recursive: true, force: true });
  });

  it('uses no-replace publication and retains an orphan when a file is replaced', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const existingPath = join(rootPath, 'collision');
    writeFileSync(existingPath, 'existing', 'utf8');
    const source = filesystem.createPrivateDirectory(root, 'stage-');
    expect(source).not.toBe(false);
    if (source === false) return;
    const file = filesystem.writeExclusiveFile(source, 'payload.bin', new TextEncoder().encode('new'));
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);
    expect(filesystem.publishNoReplace(source, root, 'collision', () => true)).toBe(false);
    expect(readFileSync(existingPath, 'utf8')).toBe('existing');
    const path = filesystem.childPath(source, 'payload.bin');
    expect(path).not.toBe(false);
    if (path !== false) {
      unlinkSync(path);
      symlinkSync(existingPath, path);
      expect(filesystem.exactRegularFiles(source, ['payload.bin'])).toBe(false);
      expect(filesystem.disposeUnpublished(source, ['payload.bin'])).toBe('retained');
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    }
    expect(filesystem.closeDirectory(source)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('rejects a same-name source-directory replacement before renameat2 publication', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;

    const source = filesystem.createPrivateDirectory(root, 'stage-');
    expect(source).not.toBe(false);
    if (source === false) return;
    const file = filesystem.writeExclusiveFile(
      source,
      'payload.bin',
      new TextEncoder().encode('retained payload'),
    );
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);
    const payloadPath = filesystem.childPath(source, 'payload.bin');
    expect(payloadPath).not.toBe(false);
    if (payloadPath === false) return;

    const sourcePath = dirname(payloadPath);
    const movedSourcePath = `${sourcePath}-moved`;
    renameSync(sourcePath, movedSourcePath);
    mkdirSync(sourcePath, { mode: 0o700 });
    writeFileSync(join(sourcePath, 'attacker.bin'), 'replacement', { mode: 0o600 });

    expect(filesystem.publishNoReplace(source, root, 'published', () => true)).toBe(false);
    expect(lstatSync(sourcePath).isDirectory()).toBe(true);
    expect(lstatSync(movedSourcePath).isDirectory()).toBe(true);
    expect(() => lstatSync(join(rootPath, 'published'))).toThrow();
    expect(filesystem.closeDirectory(source)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });
});
