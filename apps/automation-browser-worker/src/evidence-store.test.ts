import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type {
  StudioObjectMetadata,
  StudioObjectStore,
  StudioPutObjectInput,
} from '@kortix/studio-runtime';
import { loadBrowserWorkerEvidenceConfig } from './config';
import { createStudioBrowserEvidenceStore } from './evidence-store';

const ACCOUNT_ID = '10000000-0000-4000-a000-000000000001';
const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const JOB_ID = '30000000-0000-4000-a000-000000000001';
const LEASE_ID = '40000000-0000-4000-a000-000000000001';
const STEP_ID = '50000000-0000-4000-a000-000000000001';
const EVIDENCE_ID = '60000000-0000-4000-a000-000000000001';

const S3_ENVIRONMENT = {
  AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
  STUDIO_OBJECT_STORE_MODE: 's3',
  STUDIO_OBJECT_STORE_BUCKET: 'openopc-private',
  STUDIO_OBJECT_STORE_PREFIX: 'browser',
  STUDIO_S3_ENDPOINT: 'https://oss.example.test',
  STUDIO_S3_REGION: 'cn-shanghai',
  STUDIO_S3_CREDENTIAL_MODE: 'default-chain',
  STUDIO_S3_SSE: 'AES256',
} as const;

function recordingObjectStore(): StudioObjectStore & { puts: StudioPutObjectInput[] } {
  const puts: StudioPutObjectInput[] = [];
  return {
    namespace: 'browser',
    puts,
    assertReady: async () => undefined,
    putObject: async (input) => {
      puts.push(input);
      return {} as StudioObjectMetadata;
    },
    headObject: async () => {
      throw new Error('not implemented');
    },
    getObject: async () => {
      throw new Error('not implemented');
    },
    listObjects: async () => {
      throw new Error('not implemented');
    },
    deleteObject: async () => {
      throw new Error('not implemented');
    },
    createSignedUploadUrl: async () => {
      throw new Error('signed URLs are forbidden for browser evidence');
    },
    createSignedDownloadUrl: async () => {
      throw new Error('signed URLs are forbidden for browser evidence');
    },
  };
}

const validInput = () => ({
  tenantId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  jobId: JOB_ID,
  leaseId: LEASE_ID,
  stepId: STEP_ID,
  reference: `evidence:${EVIDENCE_ID}`,
  contentType: 'image/png',
  body: new Uint8Array([1, 2, 3]),
});

describe('private browser evidence storage', () => {
  test('loads storage independently and requires S3 whenever dispatch is enabled', () => {
    expect(loadBrowserWorkerEvidenceConfig({})).toEqual({ enabled: false });
    expect(loadBrowserWorkerEvidenceConfig(S3_ENVIRONMENT)).toMatchObject({
      enabled: true,
      storage: { mode: 's3', bucket: 'openopc-private' },
    });
    expect(() =>
      loadBrowserWorkerEvidenceConfig({
        AUTOMATION_BROWSER_DISPATCH_ENABLED: 'true',
        STUDIO_OBJECT_STORE_MODE: 'memory',
        STUDIO_ALLOW_EPHEMERAL_STORAGE: 'true',
      }),
    ).toThrow('STUDIO_OBJECT_STORE_MODE');
  });

  test('writes checksummed immutable evidence to an opaque scope-bound key', async () => {
    const objectStore = recordingObjectStore();
    const evidence = createStudioBrowserEvidenceStore(objectStore);

    const result = await evidence.put(validInput());

    expect(result).toBeUndefined();
    expect(objectStore.puts).toHaveLength(1);
    expect(objectStore.puts[0]).toMatchObject({
      key: `automation-evidence/${ACCOUNT_ID}/${PROJECT_ID}/${JOB_ID}/${LEASE_ID}/${STEP_ID}/${EVIDENCE_ID}`,
      content_type: 'image/png',
      size_bytes: 3,
      checksum_sha256: createHash('sha256')
        .update(new Uint8Array([1, 2, 3]))
        .digest('hex'),
      metadata: {
        tenant_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        job_id: JOB_ID,
        lease_id: LEASE_ID,
        step_id: STEP_ID,
      },
      if_none_match: '*',
    });
    expect(JSON.stringify(objectStore.puts)).not.toMatch(/https?:|signature|signed/i);
  });

  test('rejects malformed scope IDs and references before storage access', async () => {
    const objectStore = recordingObjectStore();
    const evidence = createStudioBrowserEvidenceStore(objectStore);
    const invalidInputs = [
      { tenantId: 'not-a-uuid' },
      { projectId: 'not-a-uuid' },
      { jobId: 'not-a-uuid' },
      { leaseId: 'not-a-uuid' },
      { stepId: 'not-a-uuid' },
      { reference: EVIDENCE_ID },
      { reference: `evidence:${EVIDENCE_ID}/public` },
    ];

    for (const invalid of invalidInputs) {
      await expect(evidence.put({ ...validInput(), ...invalid })).rejects.toThrow();
    }
    expect(objectStore.puts).toEqual([]);
  });

  test('rejects non-canonical uppercase scope IDs and evidence references', async () => {
    const objectStore = recordingObjectStore();
    const evidence = createStudioBrowserEvidenceStore(objectStore);

    await expect(
      evidence.put({ ...validInput(), tenantId: ACCOUNT_ID.toUpperCase() }),
    ).rejects.toThrow('tenantId');
    await expect(
      evidence.put({
        ...validInput(),
        reference: `evidence:${EVIDENCE_ID.toUpperCase()}`,
      }),
    ).rejects.toThrow('reference');
    expect(objectStore.puts).toEqual([]);
  });
});
