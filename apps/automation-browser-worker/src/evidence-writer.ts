import { randomUUID } from 'node:crypto';

export interface EvidenceStore {
  put(input: {
    tenantId: string;
    projectId: string;
    jobId: string;
    leaseId: string;
    stepId: string;
    reference: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<void>;
}

export type EvidenceScope = Readonly<{
  tenantId: string;
  projectId: string;
  jobId: string;
  leaseId: string;
}>;

export function createEvidenceWriter(
  store: EvidenceStore,
  scope: EvidenceScope,
  maxBytes = 1_000_000,
) {
  return {
    async write(stepId: string, contentType: string, body: Uint8Array): Promise<string> {
      if (body.byteLength > maxBytes) throw new Error('evidence exceeds size limit');
      const reference = `evidence:${randomUUID()}`;
      await store.put({ ...scope, stepId, reference, contentType, body });
      return reference;
    },
  };
}
