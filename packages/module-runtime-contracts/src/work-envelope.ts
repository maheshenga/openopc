import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020';

import workEnvelopeSchema from '../schema/work-envelope.v1.schema.json';

export type Sha256Digest = `sha256:${string}`;

export interface WorkEnvelopeGrantV1 {
  id: string;
  audience: string;
  tokenHash: Sha256Digest;
}

export interface WorkEnvelopeLeaseV1 {
  id: string;
  generation: number;
  deadline: string;
}

export interface WorkEnvelopeResourceCeilingsV1 {
  cpuMillis: number;
  memoryMiB: number;
  wallTimeMs: number;
  costMicro: number;
}

export interface WorkEnvelopeV1 {
  envelopeVersion: 1;
  executionId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  idempotencyKey: string;
  installRevision: number;
  releaseId: string;
  releaseDigest: Sha256Digest;
  consentRevisionId: string;
  permissionDigest: Sha256Digest;
  runtimeDescriptorId: string;
  runtimeDescriptorDigest: Sha256Digest;
  inputDigest: Sha256Digest;
  runtimeArtifactDigest: Sha256Digest;
  runtimeArtifactBytes: number;
  runtimeKind: 'wasi-component' | 'oci-image';
  runtimeProfile: string;
  policyDigest: Sha256Digest;
  killSwitchGeneration: number;
  executionDeadline: string;
  bindingDigest: Sha256Digest;
  resourceCeilings: WorkEnvelopeResourceCeilingsV1;
  lease: WorkEnvelopeLeaseV1;
  grants: readonly WorkEnvelopeGrantV1[];
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateWorkEnvelope = ajv.compile<WorkEnvelopeV1>(workEnvelopeSchema);

export function parseWorkEnvelope(value: unknown): WorkEnvelopeV1 {
  if (!validateWorkEnvelope(value)) throw new Error('WORK_ENVELOPE_INVALID');
  if (new Set(value.grants.map((grant) => grant.id)).size !== value.grants.length) {
    throw new Error('WORK_ENVELOPE_INVALID');
  }
  return value;
}
