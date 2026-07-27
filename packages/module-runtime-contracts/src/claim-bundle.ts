import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020';

import claimBundleSchema from '../schema/claim-bundle.v1.schema.json';
import runtimeDescriptorSchema from '../schema/openopc.runtime.v1.schema.json';
import type { CapabilityAudience } from './capability-token';
import { type RuntimeDescriptorV1, parseRuntimeDescriptor } from './runtime-descriptor';
import type { Sha256Digest } from './work-envelope';

export const MODULE_EXECUTION_INPUT_MAX_BYTES = 262_144;
export const WASI_RUNTIME_ARTIFACT_MAX_BYTES = 33_554_432;
export const RUNTIME_ARTIFACT_FETCH_PATH = 'module-runtime/artifacts/fetch' as const;

export interface RunnerCapabilityTokenV1 {
  grantId: string;
  audience: CapabilityAudience;
  token: string;
}

export interface RunnerClaimBundleV1 {
  signedEnvelope: string;
  capabilityTokens: readonly RunnerCapabilityTokenV1[];
  runtimeDescriptor: RuntimeDescriptorV1;
  inputBase64: string;
  runtimeArtifact: {
    fetchPath: typeof RUNTIME_ARTIFACT_FETCH_PATH;
    digest: Sha256Digest;
    bytes: number;
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(runtimeDescriptorSchema);
const validateClaimBundle = ajv.compile<RunnerClaimBundleV1>(claimBundleSchema);

function invalid(): never {
  throw new Error('RUNNER_CLAIM_BUNDLE_INVALID');
}

function decodedBase64UrlBytes(value: string): number {
  try {
    const standard = value.replaceAll('-', '+').replaceAll('_', '/');
    const padding = '='.repeat((4 - (standard.length % 4)) % 4);
    const decoded = atob(`${standard}${padding}`);
    const canonical = btoa(decoded).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    if (canonical !== value) invalid();
    return decoded.length;
  } catch {
    invalid();
  }
}

export function parseRunnerClaimBundle(value: unknown): RunnerClaimBundleV1 {
  if (!validateClaimBundle(value)) invalid();
  if (decodedBase64UrlBytes(value.inputBase64) > MODULE_EXECUTION_INPUT_MAX_BYTES) invalid();
  if (
    new Set(value.capabilityTokens.map((token) => token.grantId)).size !==
    value.capabilityTokens.length
  ) {
    invalid();
  }
  try {
    parseRuntimeDescriptor(value.runtimeDescriptor);
  } catch {
    invalid();
  }
  return value;
}
