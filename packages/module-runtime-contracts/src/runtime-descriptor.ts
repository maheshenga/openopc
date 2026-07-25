import Ajv2020 from 'ajv/dist/2020';

import runtimeDescriptorSchema from '../schema/openopc.runtime.v1.schema.json';

export interface RuntimeLimits {
  cpuMillis: number;
  fuel: number;
  memoryMiB: number;
  outputBytes: number;
  pids: number;
  wallTimeMs: number;
}

export interface WasiComponentRuntime {
  kind: 'wasi-component';
  component: string;
  world: string;
  operation: string;
  imports: string[];
  limits: RuntimeLimits;
}

export interface OciImageRuntime {
  kind: 'oci-image';
  image: `sha256:${string}`;
  command: string[];
  args: string[];
  profile: string;
  limits: RuntimeLimits;
}

export interface RuntimeDescriptorV1 {
  descriptorVersion: 1;
  runtime: WasiComponentRuntime | OciImageRuntime;
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateRuntimeDescriptor = ajv.compile<RuntimeDescriptorV1>(runtimeDescriptorSchema);
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasInvalidOciImage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.runtime) || value.runtime.kind !== 'oci-image') {
    return false;
  }
  return typeof value.runtime.image !== 'string' || !SHA256_DIGEST.test(value.runtime.image);
}

function hasSortedUniqueImports(value: RuntimeDescriptorV1): boolean {
  if (value.runtime.kind !== 'wasi-component') return true;
  const { imports } = value.runtime;
  return imports.every((item, index) => index === 0 || imports[index - 1] < item);
}

export function parseRuntimeDescriptor(value: unknown): RuntimeDescriptorV1 {
  if (hasInvalidOciImage(value)) throw new Error('OCI_IMAGE_DIGEST_REQUIRED');
  if (!validateRuntimeDescriptor(value) || !hasSortedUniqueImports(value)) {
    throw new Error('RUNTIME_DESCRIPTOR_INVALID');
  }
  return value;
}
