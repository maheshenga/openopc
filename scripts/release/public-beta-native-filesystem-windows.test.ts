import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type PublicBetaNativeDirectory,
  createPublicBetaNativeFilesystem,
} from './public-beta-native-filesystem';

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip;

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openopc-native-windows-'));
  roots.push(root);
  return root;
}

function closeDirectory(
  filesystem: ReturnType<typeof createPublicBetaNativeFilesystem>,
  directory: PublicBetaNativeDirectory | false,
): void {
  if (directory !== false) filesystem.closeDirectory(directory);
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

windowsDescribe('public beta native filesystem (Windows)', () => {
  it('creates a private directory, writes and rereads a file, and enforces exact membership', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;

    const privateDirectory = filesystem.createPrivateDirectory(root, 'verification-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) {
      closeDirectory(filesystem, root);
      return;
    }

    const bytes = new TextEncoder().encode('retained native bytes');
    const file = filesystem.writeExclusiveFile(privateDirectory, 'payload.bin', bytes);
    expect(file).not.toBe(false);
    if (file === false) {
      closeDirectory(filesystem, privateDirectory);
      closeDirectory(filesystem, root);
      return;
    }

    expect(filesystem.readFile(file, 1024)).toEqual(bytes);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(true);
    const child = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(child).not.toBe(false);
    if (child !== false) expect(new Uint8Array(readFileSync(child))).toEqual(bytes);

    expect(filesystem.closeFile(file)).toBe(true);
    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin'])).toBe('removed');
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('publishes without replacement and preserves a pre-existing target on collision', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;

    const existingPath = join(rootPath, 'collision');
    writeFileSync(existingPath, 'pre-existing target', 'utf8');
    const source = filesystem.createPrivateDirectory(root, 'stage-');
    expect(source).not.toBe(false);
    if (source === false) {
      closeDirectory(filesystem, root);
      return;
    }
    const file = filesystem.writeExclusiveFile(
      source,
      'payload.bin',
      new TextEncoder().encode('new payload'),
    );
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);

    expect(filesystem.publishNoReplace(source, root, 'collision', () => true)).toBe(false);
    expect(readFileSync(existingPath, 'utf8')).toBe('pre-existing target');
    expect(filesystem.disposeUnpublished(source, ['payload.bin'])).toBe('removed');
    expect(filesystem.closeDirectory(source)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('removes an exact retained path-created file without weakening tracked exact membership', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const privateDirectory = filesystem.createPrivateDirectory(root, 'archive-stage-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) {
      closeDirectory(filesystem, root);
      return;
    }

    const payloadPath = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(payloadPath).not.toBe(false);
    if (payloadPath === false) {
      closeDirectory(filesystem, privateDirectory);
      closeDirectory(filesystem, root);
      return;
    }
    writeFileSync(payloadPath, 'path-created payload', 'utf8');

    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(false);
    const retained = filesystem.retainExistingRegularFile(privateDirectory, 'payload.bin');
    expect(retained).not.toBe(false);
    if (retained !== false) expect(filesystem.closeFile(retained)).toBe(true);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(true);
    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin'])).toBe('removed');
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(existsSync(dirname(payloadPath))).toBe(false);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('retains a path-created file when it is replaced after identity registration', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const privateDirectory = filesystem.createPrivateDirectory(root, 'archive-stage-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) {
      closeDirectory(filesystem, root);
      return;
    }

    const payloadPath = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(payloadPath).not.toBe(false);
    if (payloadPath === false) {
      closeDirectory(filesystem, privateDirectory);
      closeDirectory(filesystem, root);
      return;
    }
    writeFileSync(payloadPath, 'original path-created payload', 'utf8');
    const retained = filesystem.retainExistingRegularFile(privateDirectory, 'payload.bin');
    expect(retained).not.toBe(false);
    if (retained !== false) expect(filesystem.closeFile(retained)).toBe(true);

    unlinkSync(payloadPath);
    writeFileSync(payloadPath, 'replacement', 'utf8');

    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin'])).toBe('retained');
    expect(readFileSync(payloadPath, 'utf8')).toBe('replacement');
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('publishes a retained stage when the final name is free', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;

    const source = filesystem.createPrivateDirectory(root, 'stage-');
    expect(source).not.toBe(false);
    if (source === false) {
      closeDirectory(filesystem, root);
      return;
    }
    const bytes = new TextEncoder().encode('published payload');
    const file = filesystem.writeExclusiveFile(source, 'payload.bin', bytes);
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);
    expect(filesystem.exactRegularFiles(source, ['payload.bin'])).toBe(true);

    expect(filesystem.publishNoReplace(source, root, 'published', () => true)).toBe(true);
    expect(new Uint8Array(readFileSync(join(rootPath, 'published', 'payload.bin')))).toEqual(bytes);
    expect(filesystem.closeDirectory(source)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('reauthorizes the source immediately before the native rename fallback', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;

    const source = filesystem.createPrivateDirectory(root, 'fallback-stage-');
    expect(source).not.toBe(false);
    if (source === false) {
      closeDirectory(filesystem, root);
      return;
    }
    const file = filesystem.writeExclusiveFile(
      source,
      'payload.bin',
      new TextEncoder().encode('authorized once'),
    );
    expect(file).not.toBe(false);
    if (file !== false) expect(filesystem.closeFile(file)).toBe(true);

    let authorizationCount = 0;
    expect(
      filesystem.publishNoReplace(source, root, 'fallback-rejected', () => {
        authorizationCount += 1;
        return authorizationCount === 1;
      }),
    ).toBe(false);
    expect(authorizationCount).toBe(2);
    expect(existsSync(join(rootPath, 'fallback-rejected'))).toBe(false);
    expect(filesystem.disposeUnpublished(source, ['payload.bin'])).toBe('removed');
    expect(filesystem.closeDirectory(source)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('rejects same-name replacement in exact membership and retains the replacement', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const privateDirectory = filesystem.createPrivateDirectory(root, 'replace-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) {
      closeDirectory(filesystem, root);
      return;
    }

    const expected = filesystem.writeExclusiveFile(
      privateDirectory,
      'payload.bin',
      new TextEncoder().encode('original'),
    );
    expect(expected).not.toBe(false);
    if (expected !== false) expect(filesystem.closeFile(expected)).toBe(true);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(true);

    const expectedPath = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(expectedPath).not.toBe(false);
    if (expectedPath !== false) {
      unlinkSync(expectedPath);
      writeFileSync(expectedPath, 'replacement', 'utf8');
    }

    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(false);
    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin'])).toBe('retained');
    if (expectedPath !== false) expect(readFileSync(expectedPath, 'utf8')).toBe('replacement');
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('refuses to close a parent directory while a child directory is live', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const child = filesystem.createPrivateDirectory(root, 'child-');
    expect(child).not.toBe(false);
    if (child === false) {
      closeDirectory(filesystem, root);
      return;
    }

    expect(filesystem.closeDirectory(root)).toBe(false);
    expect(filesystem.closeDirectory(child)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });

  it('rejects an extra entry and retains an orphan when the expected file was replaced', () => {
    const rootPath = makeRoot();
    const filesystem = createPublicBetaNativeFilesystem();
    const root = filesystem.openDirectory(rootPath);
    expect(root).not.toBe(false);
    if (root === false) return;
    const privateDirectory = filesystem.createPrivateDirectory(root, 'orphan-');
    expect(privateDirectory).not.toBe(false);
    if (privateDirectory === false) {
      closeDirectory(filesystem, root);
      return;
    }

    const expected = filesystem.writeExclusiveFile(
      privateDirectory,
      'payload.bin',
      new TextEncoder().encode('original'),
    );
    expect(expected).not.toBe(false);
    if (expected !== false) expect(filesystem.closeFile(expected)).toBe(true);
    const extra = filesystem.writeExclusiveFile(
      privateDirectory,
      'extra.bin',
      new TextEncoder().encode('extra'),
    );
    expect(extra).not.toBe(false);
    if (extra !== false) expect(filesystem.closeFile(extra)).toBe(true);
    expect(filesystem.exactRegularFiles(privateDirectory, ['payload.bin'])).toBe(false);

    const expectedPath = filesystem.childPath(privateDirectory, 'payload.bin');
    expect(expectedPath).not.toBe(false);
    if (expectedPath !== false) {
      unlinkSync(expectedPath);
      writeFileSync(expectedPath, 'replacement', 'utf8');
      expect(existsSync(expectedPath)).toBe(true);
    }

    expect(filesystem.disposeUnpublished(privateDirectory, ['payload.bin', 'extra.bin'])).toBe(
      'retained',
    );
    if (expectedPath !== false) expect(readFileSync(expectedPath, 'utf8')).toBe('replacement');
    expect(filesystem.closeDirectory(privateDirectory)).toBe(true);
    expect(filesystem.closeDirectory(root)).toBe(true);
  });
});
