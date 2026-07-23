import { createHash } from 'node:crypto';
import type { StudioObjectStore } from '@kortix/studio-runtime';
import type { EvidenceStore } from './evidence-writer';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVIDENCE_REFERENCE_PATTERN = new RegExp(`^evidence:(${UUID_PATTERN.source.slice(1, -1)})$`, 'i');

type EvidenceInput = Parameters<EvidenceStore['put']>[0];

export function createStudioBrowserEvidenceStore(store: StudioObjectStore): EvidenceStore {
  return Object.freeze({
    async put(input: EvidenceInput): Promise<void> {
      const evidenceId = parseEvidenceInput(input);
      const checksum = createHash('sha256').update(input.body).digest('hex');
      await store.putObject({
        key: [
          'automation-evidence',
          input.tenantId,
          input.projectId,
          input.jobId,
          input.leaseId,
          input.stepId,
          evidenceId,
        ].join('/'),
        body: new Blob([Uint8Array.from(input.body).buffer]).stream(),
        content_type: input.contentType,
        size_bytes: input.body.byteLength,
        checksum_sha256: checksum,
        metadata: {
          tenant_id: input.tenantId,
          project_id: input.projectId,
          job_id: input.jobId,
          lease_id: input.leaseId,
          step_id: input.stepId,
        },
        if_none_match: '*',
      });
    },
  });
}

function parseEvidenceInput(input: EvidenceInput): string {
  const identifiers = [
    ['tenantId', input.tenantId],
    ['projectId', input.projectId],
    ['jobId', input.jobId],
    ['leaseId', input.leaseId],
    ['stepId', input.stepId],
  ] as const;
  const invalid = identifiers.find(([, value]) => !UUID_PATTERN.test(value));
  if (invalid !== undefined) throw new Error(`invalid browser evidence ${invalid[0]}`);

  const reference = EVIDENCE_REFERENCE_PATTERN.exec(input.reference);
  if (reference?.[1] === undefined) throw new Error('invalid browser evidence reference');
  return reference[1];
}
