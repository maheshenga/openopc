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

export interface WorkEnvelopeV1 {
  envelopeVersion: 1;
  executionId: string;
  accountId: string;
  projectId: string;
  installationId: string;
  releaseDigest: Sha256Digest;
  runtimeDescriptorDigest: Sha256Digest;
  policyDigest: Sha256Digest;
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
