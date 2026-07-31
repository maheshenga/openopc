import { createHash } from 'node:crypto';

import { readRegistryModuleManifest } from './module-manifest';
import type {
  RegistryItem,
  RegistryItemFile,
  RegistryModuleExecutionMode,
  RegistryModuleManifestV2,
  RegistryModuleManifestV3,
} from './schema';

export const DEVELOPER_MODULE_ARTIFACT_FORMAT_VERSION = 2 as const;
export const DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE =
  'application/vnd.openopc.developer-module.v2+json' as const;

export type Sha256Digest = `sha256:${string}`;

export interface ResolvedRegistryModuleFile {
  path: string;
  target: string;
  mediaType: string;
  bytes: Uint8Array;
  kind?: 'file' | 'symlink' | 'hardlink' | 'device' | 'sparse';
}

export interface RegistryModuleArtifactBlobDescriptor {
  path: string;
  target: string;
  mediaType: string;
  size: number;
  digest: Sha256Digest;
}

export interface RegistryModuleLockNode {
  name: string;
  version: string;
  resolved: string;
  integrity: string;
  dependencies: Record<string, string>;
}

export interface RegistryModuleLockGraph {
  format: 'openopc-lock.v1';
  nodes: RegistryModuleLockNode[];
}

export interface RegistryModuleSourceProvenance {
  uri: string;
  revision: string;
  registryItemAddress?: string;
}

export interface RegistryModuleArtifactDescriptorModuleV2 {
  id: string;
  version: string;
  publisherId: string;
  category: string;
  executionMode: RegistryModuleExecutionMode;
}

export interface RegistryModuleArtifactDescriptorModuleV3 {
  id: string;
  version: string;
  publisherId: string;
  executionMode: RegistryModuleExecutionMode;
}

export type RegistryModuleArtifactDescriptorModule =
  | RegistryModuleArtifactDescriptorModuleV2
  | RegistryModuleArtifactDescriptorModuleV3;

interface RegistryModuleArtifactDescriptorBase {
  artifactFormatVersion: typeof DEVELOPER_MODULE_ARTIFACT_FORMAT_VERSION;
  mediaType: typeof DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE;
  blobs: RegistryModuleArtifactBlobDescriptor[];
  dependencies: string[];
  devDependencies: string[];
  registryDependencies: string[];
  lockGraph: RegistryModuleLockGraph | null;
  lockDigest: Sha256Digest | null;
  entries: Record<string, string>;
  uiEntries: Record<string, string>;
  source: RegistryModuleSourceProvenance | null;
}

export interface RegistryModuleArtifactDescriptorV2 extends RegistryModuleArtifactDescriptorBase {
  item: RegistryItem & { module: RegistryModuleManifestV2 };
  module: RegistryModuleArtifactDescriptorModuleV2;
}

export interface RegistryModuleArtifactDescriptorV3 extends RegistryModuleArtifactDescriptorBase {
  item: RegistryItem & { module: RegistryModuleManifestV3 };
  module: RegistryModuleArtifactDescriptorModuleV3;
}

export type RegistryModuleArtifactDescriptor =
  | RegistryModuleArtifactDescriptorV2
  | RegistryModuleArtifactDescriptorV3;

export function isRegistryModuleArtifactDescriptorV2(
  descriptor: RegistryModuleArtifactDescriptor,
): descriptor is RegistryModuleArtifactDescriptorV2 {
  return descriptor.item.module?.schemaVersion === 2;
}

export interface RegistryModuleArtifactEnvelope {
  descriptor: RegistryModuleArtifactDescriptor;
  descriptorDigest: Sha256Digest;
  artifactDigest: Sha256Digest;
}

export interface RegistryModuleArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxExpandedBytes: number;
  maxPathLength: number;
  maxDependencies: number;
  maxJsonDepth: number;
}

export interface CreateRegistryModuleArtifactInput {
  item: RegistryItem;
  files?: ResolvedRegistryModuleFile[];
  lockGraph?: RegistryModuleLockGraph | null;
  source?: RegistryModuleSourceProvenance | null;
  limits?: Partial<RegistryModuleArtifactLimits>;
}

export interface RegistryModuleArtifactValidationIssue {
  path: string;
  message: string;
}

export class RegistryModuleArtifactValidationError extends Error {
  readonly code = 'REGISTRY_MODULE_ARTIFACT_INVALID' as const;

  constructor(readonly issues: readonly RegistryModuleArtifactValidationIssue[]) {
    super(
      `REGISTRY_MODULE_ARTIFACT_INVALID: ${issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'RegistryModuleArtifactValidationError';
  }
}

const DEFAULT_LIMITS: RegistryModuleArtifactLimits = {
  maxFiles: 2_048,
  maxFileBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 512 * 1024 * 1024,
  maxPathLength: 512,
  maxDependencies: 2_048,
  maxJsonDepth: 64,
};

const SEMVER =
  '(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?';
const PINNED_PACKAGE = new RegExp(`^(@[^/@]+/[^/@]+|[^@/][^@]*)@(${SEMVER})$`);
const DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const encoder = new TextEncoder();

function fail(path: string, message: string): never {
  throw new RegistryModuleArtifactValidationError([{ path, message }]);
}

function sha256(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('descriptor', 'contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry);
    }
    return result;
  }
  fail('descriptor', `contains unsupported ${typeof value} value`);
}

function canonicalBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(canonicalValue(value)));
}

function assertJsonDepth(value: unknown, maxDepth: number, path: string, depth = 0): void {
  if (depth > maxDepth) fail(path, `exceeds maximum JSON depth ${maxDepth}`);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonDepth(entry, maxDepth, `${path}[${index}]`, depth + 1),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertJsonDepth(entry, maxDepth, `${path}.${key}`, depth + 1);
    }
  }
}

function normalizedPath(value: string, path: string, limits: RegistryModuleArtifactLimits): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'must be a non-empty path');
  if (value.length > limits.maxPathLength) {
    fail(path, `exceeds maximum path length ${limits.maxPathLength}`);
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\')) {
    fail(path, 'must be relative');
  }
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    fail(path, 'contains a control character');
  }
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        DEVICE_NAME.test(segment),
    )
  ) {
    fail(path, 'contains an unsafe or non-portable segment');
  }
  return normalized;
}

function sortedUnique(
  values: readonly string[] | undefined,
  path: string,
  limit: number,
): string[] {
  const normalized = [...(values ?? [])];
  if (normalized.length > limit) fail(path, `exceeds maximum count ${limit}`);
  for (const [index, value] of normalized.entries()) {
    if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
      fail(`${path}[${index}]`, 'must be a bounded non-empty string');
    }
  }
  normalized.sort();
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] === normalized[index - 1]) fail(path, 'contains a duplicate value');
  }
  return normalized;
}

function pinnedPackage(value: string, path: string): { name: string; version: string } {
  const match = PINNED_PACKAGE.exec(value);
  if (!match?.[1] || !match[2]) fail(path, 'must pin an exact semantic version');
  return { name: match[1], version: match[2] };
}

function normalizedLockGraph(
  graph: RegistryModuleLockGraph | null | undefined,
  codeBearing: boolean,
  packages: readonly string[],
): RegistryModuleLockGraph | null {
  if (!graph) {
    if (codeBearing) fail('lockGraph', 'is required for a code-bearing module');
    return null;
  }
  if (graph.format !== 'openopc-lock.v1') fail('lockGraph.format', 'must be openopc-lock.v1');
  const nodes = graph.nodes.map((node, index) => {
    const path = `lockGraph.nodes[${index}]`;
    if (!node.name || node.name.length > 214)
      fail(`${path}.name`, 'must be a bounded package name');
    if (!new RegExp(`^${SEMVER}$`).test(node.version)) {
      fail(`${path}.version`, 'must be an exact semantic version');
    }
    let resolved: URL;
    try {
      resolved = new URL(node.resolved);
    } catch {
      fail(`${path}.resolved`, 'must be an HTTPS URL');
    }
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password) {
      fail(`${path}.resolved`, 'must be a credential-free HTTPS URL');
    }
    if (!/^sha(?:256|384|512)-[A-Za-z0-9+/=_-]{32,}$/.test(node.integrity)) {
      fail(`${path}.integrity`, 'must be a supported content integrity value');
    }
    const dependencies = Object.fromEntries(
      Object.entries(node.dependencies)
        .map(([name, version]) => {
          if (!name || !new RegExp(`^${SEMVER}$`).test(version)) {
            fail(`${path}.dependencies.${name}`, 'must resolve to an exact semantic version');
          }
          return [name, version] as const;
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    );
    return { ...node, dependencies };
  });
  nodes.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  const keys = new Set<string>();
  for (const node of nodes) {
    const key = `${node.name}@${node.version}`;
    if (keys.has(key)) fail('lockGraph.nodes', `contains duplicate node ${key}`);
    keys.add(key);
  }
  for (const [index, dependency] of packages.entries()) {
    const pinned = pinnedPackage(dependency, `dependencies[${index}]`);
    if (!keys.has(`${pinned.name}@${pinned.version}`)) {
      fail(`dependencies[${index}]`, 'is not resolved by the lock graph');
    }
  }
  for (const [index, node] of nodes.entries()) {
    for (const [name, version] of Object.entries(node.dependencies)) {
      if (!keys.has(`${name}@${version}`)) {
        fail(`lockGraph.nodes[${index}].dependencies.${name}`, 'references an unresolved node');
      }
    }
  }
  return { format: 'openopc-lock.v1', nodes };
}

function normalizedSource(
  source: RegistryModuleSourceProvenance | null | undefined,
): RegistryModuleSourceProvenance | null {
  if (!source) return null;
  let uri: URL;
  try {
    uri = new URL(source.uri);
  } catch {
    fail('source.uri', 'must be an HTTPS URL');
  }
  if (uri.protocol !== 'https:' || uri.username || uri.password || source.uri.length > 2_048) {
    fail('source.uri', 'must be a bounded credential-free HTTPS URL');
  }
  if (!/^[0-9a-f]{40,64}$/.test(source.revision)) {
    fail('source.revision', 'must be an immutable lowercase hexadecimal revision');
  }
  if (
    source.registryItemAddress !== undefined &&
    (!source.registryItemAddress.trim() || source.registryItemAddress.length > 1_024)
  ) {
    fail('source.registryItemAddress', 'must be a bounded non-empty address');
  }
  return { ...source };
}

function normalizedItem(item: RegistryItem, limits: RegistryModuleArtifactLimits): RegistryItem {
  const clone = JSON.parse(JSON.stringify(item)) as RegistryItem;
  clone.dependencies = sortedUnique(item.dependencies, 'item.dependencies', limits.maxDependencies);
  clone.devDependencies = sortedUnique(
    item.devDependencies,
    'item.devDependencies',
    limits.maxDependencies,
  );
  clone.registryDependencies = sortedUnique(
    item.registryDependencies,
    'item.registryDependencies',
    limits.maxDependencies,
  );
  clone.categories = item.categories
    ? sortedUnique(item.categories, 'item.categories', limits.maxDependencies)
    : undefined;
  clone.files = (item.files ?? [])
    .map((file, index) => ({
      ...file,
      path: normalizedPath(file.path, `item.files[${index}].path`, limits),
      target: normalizedPath(file.target ?? file.path, `item.files[${index}].target`, limits),
    }))
    .sort((left, right) =>
      `${left.path}\0${left.target}`.localeCompare(`${right.path}\0${right.target}`),
    );
  if (clone.module) {
    clone.module.locales = [...clone.module.locales].sort();
    if (clone.module.execution.entry) {
      clone.module.execution.entry = normalizedPath(
        clone.module.execution.entry,
        'item.module.execution.entry',
        limits,
      );
    }
    clone.module.capabilities = clone.module.capabilities
      ?.map((capability) => ({
        ...capability,
        assetKinds: capability.assetKinds ? [...capability.assetKinds].sort() : undefined,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    if (clone.module.permissions) {
      for (const key of Object.keys(clone.module.permissions) as Array<
        keyof typeof clone.module.permissions
      >) {
        const values = clone.module.permissions[key];
        if (values) clone.module.permissions[key] = [...values].sort();
      }
    }
    clone.module.ui = clone.module.ui
      ?.map((surface) => ({
        ...surface,
        entry: surface.entry
          ? normalizedPath(surface.entry, `item.module.ui.${surface.id}.entry`, limits)
          : undefined,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  return clone;
}

function assertNoCaseCollisions(values: readonly string[], path: string): void {
  const seen = new Map<string, string>();
  for (const value of values) {
    const folded = value.normalize('NFC').toLocaleLowerCase('en-US');
    const previous = seen.get(folded);
    if (previous !== undefined) fail(path, `contains colliding paths ${previous} and ${value}`);
    seen.set(folded, value);
  }
}

function resolvedBlobs(
  item: RegistryItem,
  files: readonly ResolvedRegistryModuleFile[],
  limits: RegistryModuleArtifactLimits,
): RegistryModuleArtifactBlobDescriptor[] {
  if (files.length > limits.maxFiles) fail('files', `exceeds maximum count ${limits.maxFiles}`);
  const declared = new Map<string, RegistryItemFile>(
    (item.files ?? []).map((file) => [`${file.path}\0${file.target ?? file.path}`, file] as const),
  );
  if (declared.size !== (item.files ?? []).length)
    fail('item.files', 'contains duplicate declarations');
  const resolvedKeys = new Set<string>();
  let expandedBytes = 0;
  const blobs = files.map((file, index) => {
    const path = normalizedPath(file.path, `files[${index}].path`, limits);
    const target = normalizedPath(file.target, `files[${index}].target`, limits);
    if (file.kind !== undefined && file.kind !== 'file') {
      fail(`files[${index}].kind`, `${file.kind} entries are forbidden`);
    }
    if (!MEDIA_TYPE.test(file.mediaType) || file.mediaType.length > 128) {
      fail(`files[${index}].mediaType`, 'must be a bounded media type');
    }
    if (!(file.bytes instanceof Uint8Array)) fail(`files[${index}].bytes`, 'must be bytes');
    if (file.bytes.byteLength > limits.maxFileBytes) {
      fail(`files[${index}].bytes`, `exceeds maximum file bytes ${limits.maxFileBytes}`);
    }
    expandedBytes += file.bytes.byteLength;
    if (expandedBytes > limits.maxExpandedBytes) {
      fail('files', `exceeds maximum expanded bytes ${limits.maxExpandedBytes}`);
    }
    const key = `${path}\0${target}`;
    const declaration = declared.get(key);
    if (!declaration) fail(`files[${index}]`, 'is not declared by item.files');
    if (resolvedKeys.has(key)) fail('files', 'contains a duplicate resolved blob');
    resolvedKeys.add(key);
    if (declaration.content !== undefined) {
      const inline = encoder.encode(declaration.content);
      if (!Buffer.from(inline).equals(Buffer.from(file.bytes))) {
        fail(`files[${index}].bytes`, 'does not match declared inline content');
      }
    }
    return {
      path,
      target,
      mediaType: file.mediaType.toLowerCase(),
      size: file.bytes.byteLength,
      digest: sha256(file.bytes),
    };
  });
  if (resolvedKeys.size !== declared.size)
    fail('files', 'does not resolve every declared item file');
  assertNoCaseCollisions(
    blobs.map((blob) => blob.path),
    'files.path',
  );
  assertNoCaseCollisions(
    blobs.map((blob) => blob.target),
    'files.target',
  );
  return blobs.sort((left, right) =>
    `${left.path}\0${left.target}`.localeCompare(`${right.path}\0${right.target}`),
  );
}

export function createRegistryModuleArtifactEnvelope(
  input: CreateRegistryModuleArtifactInput,
): RegistryModuleArtifactEnvelope {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      fail(`limits.${key}`, 'must be a positive integer');
  }
  assertJsonDepth(input.item, limits.maxJsonDepth, 'item');
  const manifest = readRegistryModuleManifest(input.item);
  if (!manifest) {
    fail('item.module', 'must be a valid schema-version-2 or schema-version-3 module manifest');
  }
  const item = normalizedItem(input.item, limits);
  const blobs = resolvedBlobs(item, input.files ?? [], limits);
  const dependencies = item.dependencies ?? [];
  const devDependencies = item.devDependencies ?? [];
  const packages = [...dependencies, ...devDependencies];
  packages.forEach((dependency, index) => pinnedPackage(dependency, `dependencies[${index}]`));
  const lockGraph = normalizedLockGraph(
    input.lockGraph,
    manifest.execution.mode !== 'declarative' || blobs.length > 0,
    packages,
  );
  const lockDigest = lockGraph ? sha256(canonicalBytes(lockGraph)) : null;
  const entries: Record<string, string> = manifest.execution.entry
    ? { execution: normalizedPath(manifest.execution.entry, 'item.module.execution.entry', limits) }
    : {};
  const uiEntries = Object.fromEntries(
    (manifest.ui ?? [])
      .filter((surface) => surface.entry !== undefined)
      .map((surface) => [
        surface.id,
        normalizedPath(surface.entry as string, `item.module.ui.${surface.id}.entry`, limits),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const descriptorBase: RegistryModuleArtifactDescriptorBase = {
    artifactFormatVersion: DEVELOPER_MODULE_ARTIFACT_FORMAT_VERSION,
    mediaType: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
    blobs,
    dependencies,
    devDependencies,
    registryDependencies: item.registryDependencies ?? [],
    lockGraph,
    lockDigest,
    entries,
    uiEntries,
    source: normalizedSource(input.source),
  };
  const descriptor: RegistryModuleArtifactDescriptor =
    manifest.schemaVersion === 2
      ? {
          ...descriptorBase,
          item: item as RegistryModuleArtifactDescriptorV2['item'],
          module: {
            id: manifest.id,
            version: manifest.version,
            publisherId: manifest.publisher.id,
            category: manifest.category,
            executionMode: manifest.execution.mode,
          },
        }
      : {
          ...descriptorBase,
          item: item as RegistryModuleArtifactDescriptorV3['item'],
          module: {
            id: manifest.id,
            version: manifest.version,
            publisherId: manifest.publisher.id,
            executionMode: manifest.execution.mode,
          },
        };
  const descriptorDigest = sha256(canonicalRegistryModuleArtifactDescriptor(descriptor));
  return {
    descriptor,
    descriptorDigest,
    artifactDigest: registryModuleArtifactDigest({ descriptor }),
  };
}

export function canonicalRegistryModuleArtifactDescriptor(
  descriptor: RegistryModuleArtifactDescriptor,
): Uint8Array {
  return canonicalBytes(descriptor);
}

export function registryModuleArtifactDigest(
  artifact: Pick<RegistryModuleArtifactEnvelope, 'descriptor'>,
): Sha256Digest {
  const descriptorDigest = sha256(canonicalRegistryModuleArtifactDescriptor(artifact.descriptor));
  return sha256(
    canonicalBytes({
      artifactFormatVersion: DEVELOPER_MODULE_ARTIFACT_FORMAT_VERSION,
      mediaType: DEVELOPER_MODULE_ARTIFACT_MEDIA_TYPE,
      descriptorDigest,
      blobs: artifact.descriptor.blobs.map((blob) => blob.digest),
    }),
  );
}
