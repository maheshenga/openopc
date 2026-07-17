import { type StudioAsset, StudioAssetSchema } from '@kortix/api-contract';
import type { StudioSqlClient } from './postgres';

export class PostgresStudioReferenceAssetLookup {
  constructor(private readonly client: StudioSqlClient) {}

  async getAsset(projectId: string, assetId: string): Promise<StudioAsset | null> {
    const rows = await this.client.unsafe(
      `
      SELECT
        asset_id, account_id, project_id, source_job_id, kind, mime_type,
        bucket, object_key, checksum_sha256, size_bytes, width, height,
        metadata, created_at
      FROM kortix.studio_assets
      WHERE project_id = $1::uuid
        AND asset_id = $2::uuid
      LIMIT 1
    `,
      [projectId, assetId],
    );
    const row = rows[0];
    if (!row) return null;
    const parsed = StudioAssetSchema.safeParse({
      asset_id: row.asset_id,
      account_id: row.account_id,
      project_id: row.project_id,
      source_job_id: row.source_job_id ?? null,
      kind: row.kind,
      mime_type: row.mime_type,
      bucket: row.bucket,
      object_key: row.object_key,
      checksum_sha256: row.checksum_sha256,
      size_bytes: Number(row.size_bytes),
      width: row.width == null ? null : Number(row.width),
      height: row.height == null ? null : Number(row.height),
      metadata: row.metadata ?? {},
      created_at:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    });
    if (!parsed.success) return null;
    const asset = parsed.data;
    return asset.project_id === projectId && asset.asset_id === assetId ? asset : null;
  }
}
