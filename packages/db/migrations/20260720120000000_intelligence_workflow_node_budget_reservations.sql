ALTER TABLE kortix.intelligence_workflow_nodes
  ADD COLUMN IF NOT EXISTS budget_reserved_credits numeric(18, 6);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kortix.intelligence_workflow_nodes'::regclass
      AND conname = 'intelligence_workflow_nodes_budget_reserved_credits_check'
  ) THEN
    ALTER TABLE kortix.intelligence_workflow_nodes
      ADD CONSTRAINT intelligence_workflow_nodes_budget_reserved_credits_check
      CHECK (
        budget_reserved_credits IS NULL
        OR budget_reserved_credits BETWEEN 0 AND 1000000
      );
  END IF;
END
$$;

UPDATE kortix.intelligence_workflow_nodes AS node
SET budget_reserved_credits = job.reserved_credits
FROM kortix.intelligence_tasks AS task
JOIN kortix.studio_jobs AS job ON job.job_id = task.job_id
WHERE node.task_id = task.task_id
  AND node.budget_reserved_credits IS NULL
  AND job.reserved_credits BETWEEN 0 AND 1000000;
