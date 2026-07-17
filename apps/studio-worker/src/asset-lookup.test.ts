import { describe, expect, test } from 'bun:test';
import { PostgresStudioReferenceAssetLookup } from './asset-lookup';

const PROJECT_ID = '20000000-0000-4000-a000-000000000001';
const OTHER_PROJECT_ID = '20000000-0000-4000-a000-000000000002';
const ASSET_ID = '50000000-0000-4000-a000-000000000001';

describe('PostgresStudioReferenceAssetLookup', () => {
  test('loads and normalizes an asset through project and asset id fences', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const lookup = new PostgresStudioReferenceAssetLookup({
      async unsafe(text, values = []) {
        queries.push({ text, values });
        return [
          {
            asset_id: ASSET_ID,
            account_id: '10000000-0000-4000-a000-000000000001',
            project_id: PROJECT_ID,
            source_job_id: null,
            kind: 'image',
            mime_type: 'image/png',
            bucket: 'studio-production',
            object_key: `accounts/10000000-0000-4000-a000-000000000001/projects/${PROJECT_ID}/asset.png`,
            checksum_sha256: 'a'.repeat(64),
            size_bytes: '128',
            width: '1',
            height: '1',
            metadata: { source: 'upload' },
            created_at: new Date('2026-07-17T08:00:00.000Z'),
          },
        ];
      },
    });

    await expect(lookup.getAsset(PROJECT_ID, ASSET_ID)).resolves.toMatchObject({
      asset_id: ASSET_ID,
      project_id: PROJECT_ID,
      size_bytes: 128,
      width: 1,
      height: 1,
      created_at: '2026-07-17T08:00:00.000Z',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]?.text).toContain('WHERE project_id = $1::uuid');
    expect(queries[0]?.text).toContain('AND asset_id = $2::uuid');
    expect(queries[0]?.values).toEqual([PROJECT_ID, ASSET_ID]);
  });

  test('fails closed when a returned asset does not belong to the requested project', async () => {
    const lookup = new PostgresStudioReferenceAssetLookup({
      async unsafe() {
        return [
          {
            asset_id: ASSET_ID,
            account_id: '10000000-0000-4000-a000-000000000001',
            project_id: OTHER_PROJECT_ID,
            source_job_id: null,
            kind: 'image',
            mime_type: 'image/png',
            bucket: 'studio-production',
            object_key: `accounts/10000000-0000-4000-a000-000000000001/projects/${OTHER_PROJECT_ID}/asset.png`,
            checksum_sha256: 'a'.repeat(64),
            size_bytes: 128,
            width: 1,
            height: 1,
            metadata: {},
            created_at: new Date('2026-07-17T08:00:00.000Z'),
          },
        ];
      },
    });

    await expect(lookup.getAsset(PROJECT_ID, ASSET_ID)).resolves.toBeNull();
  });

  test('fails closed when the stored asset row is malformed', async () => {
    const lookup = new PostgresStudioReferenceAssetLookup({
      async unsafe() {
        return [
          {
            asset_id: ASSET_ID,
            account_id: '10000000-0000-4000-a000-000000000001',
            project_id: PROJECT_ID,
            source_job_id: null,
            kind: 'video',
            mime_type: 'video/mp4',
            bucket: 'studio-production',
            object_key: 'malformed-row-must-not-escape',
            checksum_sha256: 'not-a-checksum',
            size_bytes: -1,
            width: null,
            height: null,
            metadata: {},
            created_at: new Date('2026-07-17T08:00:00.000Z'),
          },
        ];
      },
    });

    await expect(lookup.getAsset(PROJECT_ID, ASSET_ID)).resolves.toBeNull();
  });
});
