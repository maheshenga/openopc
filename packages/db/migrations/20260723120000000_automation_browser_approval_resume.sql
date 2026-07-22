DO $automation$
BEGIN
  CREATE TYPE kortix.automation_approval_resume_attempt_status AS ENUM
    ('issued', 'consumed', 'expired', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$automation$;

CREATE TABLE IF NOT EXISTS kortix.automation_approval_resume_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  project_id uuid NOT NULL,
  approval_id uuid NOT NULL REFERENCES kortix.automation_approvals(approval_id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES kortix.automation_jobs(job_id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  lease_owner varchar(128) NOT NULL,
  kill_switch_generation bigint NOT NULL,
  resume_after_sequence integer NOT NULL,
  action_hash varchar(71) NOT NULL,
  token_hash varchar(71) NOT NULL,
  status kortix.automation_approval_resume_attempt_status NOT NULL DEFAULT 'issued',
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT automation_approval_resume_attempts_job_step_fk
    FOREIGN KEY (job_id, step_id)
    REFERENCES kortix.automation_job_steps(job_id, step_id)
    ON DELETE CASCADE,
  CONSTRAINT automation_approval_resume_attempts_binding_check CHECK (
    kill_switch_generation >= 0
    AND resume_after_sequence >= 0
    AND action_hash ~ '^sha256:[0-9a-f]{64}$'
    AND token_hash ~ '^sha256:[0-9a-f]{64}$'
    AND length(BTRIM(lease_owner)) BETWEEN 1 AND 128
    AND expires_at > issued_at
  ),
  CONSTRAINT automation_approval_resume_attempts_lifecycle_check CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR (status <> 'consumed' AND consumed_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_active_approval
  ON kortix.automation_approval_resume_attempts(approval_id)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_job_status
  ON kortix.automation_approval_resume_attempts(job_id, status, issued_at);

CREATE INDEX IF NOT EXISTS idx_automation_approval_resume_attempts_expiry
  ON kortix.automation_approval_resume_attempts(expires_at)
  WHERE status = 'issued';
