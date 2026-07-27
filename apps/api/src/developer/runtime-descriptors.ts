import { createHash } from 'node:crypto';
import {
  type RegistryModuleManifest,
  createRegistryModuleArtifactEnvelope,
  readRegistryModuleManifest,
} from '@kortix/registry';
import {
  type RuntimeDescriptorV1,
  type Sha256Digest,
  WASI_RUNTIME_ARTIFACT_MAX_BYTES,
  canonicalDigest,
  parseRuntimeDescriptor,
} from '@openopc/module-runtime-contracts';

import { parseDeveloperModuleArtifactPackage } from './artifacts';

export interface ExtractedRuntimeArtifact {
  componentPath: string;
  mediaType: 'application/wasm';
  digest: Sha256Digest;
  bytes: Uint8Array;
}

export interface RuntimeDescriptorEvidence {
  descriptor: RuntimeDescriptorV1;
  descriptorDigest: Sha256Digest;
  entryPath: string;
  runtimeKind: 'wasi-component' | 'oci-image';
  runtimeArtifact: ExtractedRuntimeArtifact | null;
}

export class DeveloperRuntimeDescriptorError extends Error {
  constructor(
    readonly code:
      | 'DEVELOPER_RUNTIME_ENTRY_INVALID'
      | 'DEVELOPER_RUNTIME_ARTIFACT_INVALID'
      | 'DEVELOPER_RUNTIME_DESCRIPTOR_MISSING'
      | 'DEVELOPER_RUNTIME_DESCRIPTOR_INVALID',
    readonly status = 400,
  ) {
    super(code);
    this.name = 'DeveloperRuntimeDescriptorError';
  }
}

const SAFE_ENTRY =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*\/\/)[A-Za-z0-9._/-]+$/;

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function invalid(code: DeveloperRuntimeDescriptorError['code']): DeveloperRuntimeDescriptorError {
  return new DeveloperRuntimeDescriptorError(code);
}

function jsonProjection(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

export async function extractRuntimeDescriptor(input: {
  manifest: RegistryModuleManifest;
  artifactBytes: Uint8Array;
}): Promise<RuntimeDescriptorEvidence | null> {
  if (input.manifest.execution.mode !== 'server-adapter') return null;

  const entryPath = input.manifest.execution.entry;
  if (
    typeof entryPath !== 'string' ||
    !SAFE_ENTRY.test(entryPath) ||
    entryPath.split('/').at(-1) !== 'openopc.runtime.json'
  ) {
    throw invalid('DEVELOPER_RUNTIME_ENTRY_INVALID');
  }

  let artifact: ReturnType<typeof parseDeveloperModuleArtifactPackage>;
  try {
    artifact = parseDeveloperModuleArtifactPackage(input.artifactBytes);
    createRegistryModuleArtifactEnvelope(artifact);
    const artifactManifest = readRegistryModuleManifest(artifact.item);
    if (
      !artifactManifest ||
      (await canonicalDigest(jsonProjection(artifactManifest))) !==
        (await canonicalDigest(jsonProjection(input.manifest)))
    ) {
      throw invalid('DEVELOPER_RUNTIME_ARTIFACT_INVALID');
    }
  } catch (error) {
    if (error instanceof DeveloperRuntimeDescriptorError) throw error;
    throw invalid('DEVELOPER_RUNTIME_ARTIFACT_INVALID');
  }

  const matches = (artifact.files ?? []).filter((file) => file.target === entryPath);
  if (matches.length === 0) throw invalid('DEVELOPER_RUNTIME_DESCRIPTOR_MISSING');
  const descriptorFile = matches[0];
  if (
    matches.length !== 1 ||
    !descriptorFile ||
    (descriptorFile.kind !== undefined && descriptorFile.kind !== 'file')
  ) {
    throw invalid('DEVELOPER_RUNTIME_ARTIFACT_INVALID');
  }

  const descriptorBytes = descriptorFile.bytes;
  let descriptor: RuntimeDescriptorV1;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(descriptorBytes));
    descriptor = parseRuntimeDescriptor(value);
    if ((await canonicalDigest(descriptor)) !== digest(descriptorBytes)) {
      throw invalid('DEVELOPER_RUNTIME_DESCRIPTOR_INVALID');
    }
  } catch (error) {
    if (error instanceof DeveloperRuntimeDescriptorError) throw error;
    throw invalid('DEVELOPER_RUNTIME_DESCRIPTOR_INVALID');
  }

  let runtimeArtifact: ExtractedRuntimeArtifact | null = null;
  if (descriptor.runtime.kind === 'wasi-component') {
    const componentPath = descriptor.runtime.component;
    const components = (artifact.files ?? []).filter((file) => file.target === componentPath);
    const componentFile = components[0];
    if (
      components.length !== 1 ||
      !componentFile ||
      (componentFile.kind !== undefined && componentFile.kind !== 'file') ||
      componentFile.mediaType !== 'application/wasm' ||
      componentFile.bytes.byteLength < 1 ||
      componentFile.bytes.byteLength > WASI_RUNTIME_ARTIFACT_MAX_BYTES
    ) {
      throw invalid('DEVELOPER_RUNTIME_DESCRIPTOR_INVALID');
    }
    runtimeArtifact = {
      componentPath,
      mediaType: 'application/wasm',
      digest: digest(componentFile.bytes),
      bytes: new Uint8Array(componentFile.bytes),
    };
  }

  return {
    descriptor,
    descriptorDigest: digest(descriptorBytes),
    entryPath,
    runtimeKind: descriptor.runtime.kind,
    runtimeArtifact,
  };
}
