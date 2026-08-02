import { createHash } from 'node:crypto';

import { readRegistryModuleManifest } from '@kortix/registry';

import {
  type DeveloperArtifactStore,
  parseDeveloperModuleArtifactPackage,
  readDeveloperArtifactBytes,
} from '../developer/artifacts';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
export const STATIC_MODULE_RELEASE_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface StaticModuleRelease {
  releaseId: string;
  storageKey: string;
  artifactDigest: `sha256:${string}`;
  artifactSize: number;
  entryPath: string;
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function normalizedAssetPath(value: string, entryPath: string): string | null {
  const requested = value.replace(/^\/+/, '');
  if (!requested) return entryPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return null;
  }
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }
  return decoded;
}

function contentTypeFor(path: string): string {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.gif': 'image/gif',
      '.html': 'text/html; charset=utf-8',
      '.ico': 'image/x-icon',
      '.jpeg': 'image/jpeg',
      '.jpg': 'image/jpeg',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain; charset=utf-8',
      '.wasm': 'application/wasm',
      '.webp': 'image/webp',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }[extension] ?? 'application/octet-stream'
  );
}

export class StaticModuleReleaseReader {
  constructor(
    private readonly input: {
      artifactStore: Pick<DeveloperArtifactStore, 'readCanonical'>;
    },
  ) {}

  async read(
    release: StaticModuleRelease,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | null> {
    if (
      !SHA256_RE.test(release.artifactDigest) ||
      !Number.isSafeInteger(release.artifactSize) ||
      release.artifactSize <= 0 ||
      release.artifactSize > STATIC_MODULE_RELEASE_MAX_ARTIFACT_BYTES
    ) {
      return null;
    }
    const assetPath = normalizedAssetPath(path, release.entryPath);
    if (!assetPath) return null;

    let artifactBytes: Uint8Array;
    try {
      artifactBytes = await readDeveloperArtifactBytes(
        this.input.artifactStore.readCanonical(release.storageKey, {
          maxBytes: STATIC_MODULE_RELEASE_MAX_ARTIFACT_BYTES,
        }),
        release.artifactSize,
      );
    } catch {
      return null;
    }
    if (digest(artifactBytes) !== release.artifactDigest) return null;

    try {
      const artifact = parseDeveloperModuleArtifactPackage(artifactBytes);
      const manifest = readRegistryModuleManifest(artifact.item);
      if (
        !manifest ||
        manifest.execution.mode !== 'sandboxed-web' ||
        manifest.execution.entry !== release.entryPath
      ) {
        return null;
      }
      const file = artifact.files?.find(
        (candidate) =>
          candidate.target === assetPath &&
          (candidate.kind === undefined || candidate.kind === 'file'),
      );
      if (!file) return null;
      return { bytes: file.bytes, contentType: contentTypeFor(assetPath) };
    } catch {
      return null;
    }
  }
}
