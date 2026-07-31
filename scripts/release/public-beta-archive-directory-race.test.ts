import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';

const realFs = await import('node:fs');
const { tmpdir } = await import('node:os');
const { basename, dirname, join } = await import('node:path');
const realNativeFilesystem: typeof import('./public-beta-native-filesystem') =
  await import(
    // @ts-expect-error Bun resolves query-string module specifiers as isolated modules.
    './public-beta-native-filesystem?directory-race-real'
  );

const realOpenSync = realFs.openSync;
const realCloseSync = realFs.closeSync;
const realLstatSync = realFs.lstatSync;
const realReaddirSync = realFs.readdirSync;
const realRenameSync = realFs.renameSync;
const realRealpathSync = realFs.realpathSync;
const realNativeRealpathSync = realFs.realpathSync.native;
let attackDestination = '';
let attackDisplaced = '';
let attackOutside = '';
let attackMode:
  | 'none'
  | 'staging-ancestor'
  | 'file-target-swap'
  | 'destination-root-swap'
  | 'extra-stage-entry'
  | 'published-swap'
  | 'pre-retain-file-swap'
  | 'pre-publish-file-swap'
  | 'cleanup-file-swap'
  | 'cleanup-swap' = 'none';
let attackObserved = false;
let attackReplaced = false;
let outsidePayloadObserved = false;
let failNextDestinationLstat = false;
let preparedTargetCount = 0;
let expectedPreparedTargetCount = 0;
let preparedTargetDescriptors: number[] = [];
let observedStagePath = '';
let stageAnchoredToDisplacedRoot = false;

const mockedRealpathSync = ((...args: Parameters<typeof realRealpathSync>) =>
  realRealpathSync(...args)) as typeof realRealpathSync;
mockedRealpathSync.native = ((...args: unknown[]) => {
  const result = Reflect.apply(realNativeRealpathSync, realRealpathSync, args);
  const path = String(args[0]);
  if (
    attackMode === 'staging-ancestor' &&
    !attackObserved &&
    path.endsWith(join('nested')) &&
    path.includes('archive-stage-')
  ) {
    attackObserved = true;
    const staging = dirname(path);
    realRenameSync(staging, attackDisplaced);
    realFs.symlinkSync(attackOutside, staging, process.platform === 'win32' ? 'junction' : 'dir');
    attackReplaced = true;
  }
  return result;
}) as typeof realNativeRealpathSync;

mock.module('node:fs', () => ({
  ...realFs,
  lstatSync: (...args: Parameters<typeof realLstatSync>) => {
    const path = String(args[0]);
    if (failNextDestinationLstat && path === attackDestination) {
      failNextDestinationLstat = false;
      const error = new Error('INJECTED_DESTINATION_LSTAT_FAILURE') as NodeJS.ErrnoException;
      error.code = 'EIO';
      throw error;
    }
    return realLstatSync(...args);
  },
  readdirSync: (...args: Parameters<typeof realReaddirSync>) => {
    const path = String(args[0]);
    if (attackMode === 'extra-stage-entry' && !attackObserved && path.includes('archive-stage-')) {
      attackObserved = true;
      realFs.writeFileSync(join(path, 'unexpected.bin'), 'extra');
    }
    return realReaddirSync(...args);
  },
  openSync: (...args: Parameters<typeof realOpenSync>) => {
    const path = String(args[0]);
    const flags = Number(args[1]);
    const descriptor = realOpenSync(...args);
    if (
      attackMode === 'file-target-swap' &&
      !attackObserved &&
      path.includes('archive-stage-') &&
      (flags & realFs.constants.O_WRONLY) !== 0 &&
      (flags & realFs.constants.O_CREAT) !== 0 &&
      (flags & realFs.constants.O_EXCL) !== 0
    ) {
      preparedTargetDescriptors.push(descriptor);
      preparedTargetCount += 1;
      if (preparedTargetCount === expectedPreparedTargetCount) {
        attackObserved = true;
        const staging = dirname(dirname(path));
        if (process.platform === 'win32') {
          for (const preparedDescriptor of preparedTargetDescriptors) {
            realCloseSync(preparedDescriptor);
          }
        }
        realRenameSync(staging, attackDisplaced);
        realFs.symlinkSync(attackOutside, staging, process.platform === 'win32' ? 'junction' : 'dir');
        attackReplaced = true;
      }
    }
    return descriptor;
  },
  realpathSync: mockedRealpathSync,
}));

mock.module('./public-beta-native-filesystem', () => ({
  ...realNativeFilesystem,
  createPublicBetaNativeFilesystem: () => {
    const filesystem = realNativeFilesystem.createPublicBetaNativeFilesystem();
    return {
      ...filesystem,
      createPrivateDirectory: (
        parent: Parameters<typeof filesystem.createPrivateDirectory>[0],
        prefix: Parameters<typeof filesystem.createPrivateDirectory>[1],
      ) => {
        if (attackMode === 'destination-root-swap' && !attackObserved) {
          attackObserved = true;
          const destinationRoot = dirname(attackDestination);
          realRenameSync(destinationRoot, attackDisplaced);
          realFs.symlinkSync(
            attackOutside,
            destinationRoot,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          attackReplaced = true;
        }
        const created = filesystem.createPrivateDirectory(parent, prefix);
        if (attackMode === 'destination-root-swap' && created !== false) {
          const stageAnchor = filesystem.childPath(created, 'root-swap-probe.tmp');
          if (stageAnchor !== false) {
            observedStagePath = dirname(stageAnchor);
            const stageName = basename(observedStagePath);
            stageAnchoredToDisplacedRoot =
              realFs.existsSync(join(attackDisplaced, stageName)) &&
              !realFs.existsSync(join(attackOutside, stageName));
          }
        }
        return created;
      },
      retainExistingRegularFile: (
        directory: Parameters<typeof filesystem.retainExistingRegularFile>[0],
        name: Parameters<typeof filesystem.retainExistingRegularFile>[1],
      ) => {
        const payloadPath = filesystem.childPath(directory, name);
        if (
          attackMode === 'pre-retain-file-swap' &&
          !attackObserved &&
          name === 'payload.bin' &&
          payloadPath !== false
        ) {
          attackObserved = true;
          observedStagePath = dirname(payloadPath);
          realFs.unlinkSync(payloadPath);
          realFs.writeFileSync(payloadPath, 'replacement', 'utf8');
          attackReplaced = true;
        }
        return filesystem.retainExistingRegularFile(directory, name);
      },
      publishNoReplace: (
        source: Parameters<typeof filesystem.publishNoReplace>[0],
        destination: Parameters<typeof filesystem.publishNoReplace>[1],
        finalName: Parameters<typeof filesystem.publishNoReplace>[2],
        authorizeSource: Parameters<typeof filesystem.publishNoReplace>[3],
      ) => {
        const stageAnchor = filesystem.childPath(source, 'cleanup-probe.tmp');
        if (stageAnchor !== false) observedStagePath = dirname(stageAnchor);
        if (attackMode === 'pre-publish-file-swap' && !attackObserved) {
          const payloadPath = filesystem.childPath(source, 'payload.bin');
          if (payloadPath !== false) {
            attackObserved = true;
            realFs.unlinkSync(payloadPath);
            realFs.writeFileSync(payloadPath, 'replacement', 'utf8');
            attackReplaced = true;
          }
        }
        if (attackMode === 'published-swap' && !attackObserved) {
          attackObserved = true;
          realFs.mkdirSync(attackDestination);
          realFs.writeFileSync(join(attackDestination, 'attacker-sentinel.txt'), 'keep');
          attackReplaced = true;
        }
        if (attackMode === 'cleanup-file-swap' && !attackObserved) {
          const payloadPath = filesystem.childPath(source, 'payload.bin');
          if (payloadPath !== false) {
            attackObserved = true;
            realFs.unlinkSync(payloadPath);
            realFs.writeFileSync(payloadPath, 'replacement', 'utf8');
            realFs.mkdirSync(attackDestination);
            realFs.writeFileSync(join(attackDestination, 'attacker-sentinel.txt'), 'keep');
            attackReplaced = true;
          }
        }
        const result = filesystem.publishNoReplace(
          source,
          destination,
          finalName,
          authorizeSource,
        );
        if (attackMode === 'cleanup-swap' && result && !attackObserved) {
          attackObserved = true;
          realRenameSync(attackDestination, attackDisplaced);
          realFs.mkdirSync(attackDestination);
          realFs.writeFileSync(join(attackDestination, 'attacker-sentinel.txt'), 'keep');
          attackReplaced = true;
          failNextDestinationLstat = true;
        }
        return result;
      },
    };
  },
}));

const { authenticateAndExtractPublicBetaArchive }: typeof import('./public-beta-archive') =
  await import(
    // @ts-expect-error Bun resolves query-string module specifiers as isolated modules.
    './public-beta-archive?directory-race'
  );

function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value & 0xffff, 0);
  return result;
}

function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value >>> 0, 0);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 0 ? value >>> 1 : (value >>> 1) ^ 0xedb88320;
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function storedZip(entries: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const fileName = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.data);
    const checksum = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(fileName.length),
      u16(0),
      fileName,
      data,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16((3 << 8) | 20),
      u16(20),
      u16(0x800),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(data.length),
      u32(data.length),
      u16(fileName.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0o100644 << 16),
      u32(localOffset),
      fileName,
    ]);
    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }
  const local = Buffer.concat(localParts);
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(central.length),
    u32(local.length),
    u16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function singleFileZip(name: string, data: Uint8Array): Uint8Array {
  return storedZip([{ name, data }]);
}

describe('public beta archive destination race', () => {
  test('does not write through a staging ancestor replaced after validation', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const displaced = join(root, 'displaced');
    const outside = join(root, 'outside');
    const outsideSentinel = join(outside, 'sentinel.txt');
    const payload = new TextEncoder().encode('outside-write');
    const archive = storedZip([
      { name: 'nested/first.bin', data: new TextEncoder().encode('first') },
      { name: 'nested/payload.bin', data: payload },
    ]);
    realFs.mkdirSync(join(outside, 'nested'), { recursive: true });
    realFs.writeFileSync(outsideSentinel, 'keep');
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'staging-ancestor';
    attackDestination = destination;
    attackDisplaced = displaced;
    attackOutside = outside;
    attackObserved = false;
    attackReplaced = false;
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.existsSync(join(outside, 'nested', 'payload.bin'))).toBe(false);
      expect(realFs.existsSync(join(displaced, 'nested', 'payload.bin'))).toBe(false);
      expect(realFs.readFileSync(outsideSentinel, 'utf8')).toBe('keep');
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackDisplaced = '';
      attackOutside = '';
      attackReplaced = false;
      if (realFs.existsSync(destination)) realFs.rmSync(destination, { recursive: true, force: true });
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not publish a payload through a staging root replaced at the file target boundary', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const displaced = join(root, 'displaced');
    const outside = join(root, 'outside');
    const outsideSentinel = join(outside, 'sentinel.txt');
    const payload = new TextEncoder().encode('outside-write');
    const archive = storedZip([
      { name: 'nested/first.bin', data: new TextEncoder().encode('first') },
      { name: 'nested/payload.bin', data: payload },
    ]);
    realFs.mkdirSync(join(outside, 'nested'), { recursive: true });
    realFs.writeFileSync(outsideSentinel, 'keep');
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'file-target-swap';
    attackDestination = destination;
    attackDisplaced = displaced;
    attackOutside = outside;
    attackObserved = false;
    attackReplaced = false;
    outsidePayloadObserved = false;
    preparedTargetCount = 0;
    expectedPreparedTargetCount = 2;
    preparedTargetDescriptors = [];
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });
      outsidePayloadObserved =
        realFs.existsSync(join(outside, 'nested', 'first.bin')) ||
        realFs.existsSync(join(outside, 'nested', 'payload.bin'));

      expect(preparedTargetCount).toBe(expectedPreparedTargetCount);
      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(outsidePayloadObserved).toBe(false);
      expect(result).toBe(false);
      expect(realFs.existsSync(join(outside, 'nested', 'first.bin'))).toBe(false);
      expect(realFs.existsSync(join(outside, 'nested', 'payload.bin'))).toBe(false);
      expect(realFs.readFileSync(join(displaced, 'nested', 'first.bin')).byteLength).toBe(0);
      expect(realFs.readFileSync(join(displaced, 'nested', 'payload.bin')).byteLength).toBe(0);
      expect(realFs.readFileSync(outsideSentinel, 'utf8')).toBe('keep');
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackDisplaced = '';
      attackOutside = '';
      attackReplaced = false;
      outsidePayloadObserved = false;
      preparedTargetCount = 0;
      expectedPreparedTargetCount = 0;
      preparedTargetDescriptors = [];
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not publish through an output root spelling replaced after root open', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archiveRoot = realFs.mkdtempSync(
      join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-source-'),
    );
    const archivePath = join(archiveRoot, 'candidate.zip');
    const destination = join(root, 'extracted');
    const displaced = `${root}-displaced`;
    const outside = `${root}-outside`;
    const outsideSentinel = join(outside, 'sentinel.txt');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.mkdirSync(outside);
    realFs.writeFileSync(outsideSentinel, 'keep');
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'destination-root-swap';
    attackDestination = destination;
    attackDisplaced = displaced;
    attackOutside = outside;
    attackObserved = false;
    attackReplaced = false;
    observedStagePath = '';
    stageAnchoredToDisplacedRoot = false;
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(stageAnchoredToDisplacedRoot).toBe(true);
      expect(result).toBe(false);
      expect(realFs.existsSync(join(outside, 'extracted', 'payload.bin'))).toBe(false);
      expect(realFs.readFileSync(outsideSentinel, 'utf8')).toBe('keep');
      expect(observedStagePath).not.toBe('');
      expect(realFs.existsSync(join(displaced, basename(observedStagePath)))).toBe(false);
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackDisplaced = '';
      attackOutside = '';
      attackReplaced = false;
      observedStagePath = '';
      stageAnchoredToDisplacedRoot = false;
      for (const candidate of [root, displaced, outside, archiveRoot]) {
        realFs.rmSync(candidate, { recursive: true, force: true });
      }
    }
  });

  test('fails closed when an extra file appears in the private stage', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'extra-stage-entry';
    attackDestination = destination;
    attackObserved = false;
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(result).toBe(false);
      expect(realFs.existsSync(destination)).toBe(false);
    } finally {
      attackMode = 'none';
      attackDestination = '';
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the published directory is replaced by an ordinary directory', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const displaced = join(root, 'displaced');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'published-swap';
    attackDestination = destination;
    attackDisplaced = displaced;
    attackObserved = false;
    attackReplaced = false;
    observedStagePath = '';
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.readFileSync(join(destination, 'attacker-sentinel.txt'), 'utf8')).toBe('keep');
      expect(observedStagePath).not.toBe('');
      expect(realFs.existsSync(observedStagePath)).toBe(false);
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackDisplaced = '';
      observedStagePath = '';
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains the private stage when a retained file is replaced before cleanup', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'cleanup-file-swap';
    attackDestination = destination;
    attackObserved = false;
    attackReplaced = false;
    observedStagePath = '';
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.readFileSync(join(destination, 'attacker-sentinel.txt'), 'utf8')).toBe('keep');
      expect(observedStagePath).not.toBe('');
      expect(realFs.readFileSync(join(observedStagePath, 'payload.bin'), 'utf8')).toBe(
        'replacement',
      );
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackReplaced = false;
      observedStagePath = '';
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains the private stage when a file is replaced before cleanup identity is authorized', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'pre-retain-file-swap';
    attackDestination = destination;
    attackObserved = false;
    attackReplaced = false;
    observedStagePath = '';
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.existsSync(destination)).toBe(false);
      expect(observedStagePath).not.toBe('');
      expect(realFs.existsSync(observedStagePath)).toBe(true);
      expect(realFs.readFileSync(join(observedStagePath, 'payload.bin'), 'utf8')).toBe(
        'replacement',
      );
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackReplaced = false;
      observedStagePath = '';
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not leave a replaced payload at the destination when the stage changes before publication', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'pre-publish-file-swap';
    attackDestination = destination;
    attackObserved = false;
    attackReplaced = false;
    observedStagePath = '';
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.existsSync(destination)).toBe(false);
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackReplaced = false;
      observedStagePath = '';
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not recursively delete a replacement after post-publish failure', async () => {
    const root = realFs.mkdtempSync(join(realFs.realpathSync.native(tmpdir()), 'openopc-archive-race-'));
    const archivePath = join(root, 'candidate.zip');
    const destination = join(root, 'extracted');
    const displaced = join(root, 'displaced');
    const archive = singleFileZip('payload.bin', new TextEncoder().encode('payload'));
    realFs.writeFileSync(archivePath, archive);

    attackMode = 'cleanup-swap';
    attackDestination = destination;
    attackDisplaced = displaced;
    attackObserved = false;
    attackReplaced = false;
    failNextDestinationLstat = false;
    try {
      const result = await authenticateAndExtractPublicBetaArchive({
        archivePath,
        expectedDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
        expectedSizeBytes: archive.length,
        destination,
      });

      expect(attackObserved).toBe(true);
      expect(attackReplaced).toBe(true);
      expect(result).toBe(false);
      expect(realFs.readFileSync(join(destination, 'attacker-sentinel.txt'), 'utf8')).toBe('keep');
    } finally {
      attackMode = 'none';
      attackDestination = '';
      attackDisplaced = '';
      failNextDestinationLstat = false;
      realFs.rmSync(root, { recursive: true, force: true });
    }
  });
});
