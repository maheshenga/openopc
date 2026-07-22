ALTER TABLE kortix.automation_job_events
  ADD COLUMN IF NOT EXISTS worker_id varchar(128),
  ADD COLUMN IF NOT EXISTS worker_lease_id uuid,
  ADD COLUMN IF NOT EXISTS worker_ordinal bigint;

DO $automation$
BEGIN
  ALTER TABLE kortix.automation_job_events
    ADD CONSTRAINT automation_job_events_worker_receipt_check
    CHECK (
      (
        worker_id IS NULL
        AND worker_lease_id IS NULL
        AND worker_ordinal IS NULL
      ) OR (
        worker_id IS NOT NULL
        AND worker_lease_id IS NOT NULL
        AND worker_ordinal IS NOT NULL
        AND worker_id ~ '^[A-Za-z][A-Za-z0-9._:-]{0,127}$'
        AND worker_ordinal > 0
      )
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_job_events_worker_ordinal_unique
  ON kortix.automation_job_events(job_id, worker_id, worker_lease_id, worker_ordinal)
  WHERE worker_id IS NOT NULL;
