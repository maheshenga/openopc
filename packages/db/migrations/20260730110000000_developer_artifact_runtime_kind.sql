ALTER TABLE kortix.developer_module_artifacts
  ADD COLUMN IF NOT EXISTS runtime_kind varchar(32);

DO $developer_artifact_runtime_kind$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_artifacts_runtime_kind_check'
      AND conrelid = 'kortix.developer_module_artifacts'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_artifacts
      ADD CONSTRAINT developer_module_artifacts_runtime_kind_check
      CHECK (runtime_kind IS NULL OR runtime_kind IN ('wasi-component', 'oci-image'));
  END IF;
END
$developer_artifact_runtime_kind$;
