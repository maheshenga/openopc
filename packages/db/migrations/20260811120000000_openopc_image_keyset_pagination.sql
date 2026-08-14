CREATE INDEX IF NOT EXISTS idx_studio_jobs_project_created_job
  ON kortix.studio_jobs(project_id, created_at DESC, job_id DESC);

CREATE INDEX IF NOT EXISTS idx_studio_assets_project_created_asset
  ON kortix.studio_assets(project_id, created_at DESC, asset_id DESC);

CREATE INDEX IF NOT EXISTS idx_studio_job_assets_job_role_created_asset
  ON kortix.studio_job_assets(job_id, role, created_at DESC, asset_id DESC);
