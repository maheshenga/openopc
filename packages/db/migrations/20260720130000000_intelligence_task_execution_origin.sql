ALTER TABLE kortix.intelligence_tasks
  ADD COLUMN IF NOT EXISTS execution_origin text NOT NULL DEFAULT 'request';

DO $$
BEGIN
  IF to_regclass('kortix.intelligence_workflow_nodes') IS NOT NULL
     AND to_regclass('kortix.intelligence_workflow_runs') IS NOT NULL THEN
    EXECUTE $migration$
      UPDATE kortix.intelligence_tasks AS task
      SET execution_origin = 'workflow'
      WHERE EXISTS (
        SELECT 1
        FROM kortix.intelligence_workflow_nodes AS node
        WHERE node.task_id = task.task_id
      )
    $migration$;

    EXECUTE $migration$
      UPDATE kortix.intelligence_tasks AS task
      SET execution_origin = 'workflow'
      FROM kortix.intelligence_workflow_nodes AS node
      JOIN kortix.intelligence_workflow_runs AS run ON run.run_id = node.run_id
      WHERE node.task_id IS NULL
        AND task.account_id = run.account_id
        AND task.project_id = run.project_id
        AND task.idempotency_key = 'workflow-node-' || node.node_id::text
    $migration$;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'intelligence_tasks_execution_origin_check'
      AND connamespace = 'kortix'::regnamespace
  ) THEN
    ALTER TABLE kortix.intelligence_tasks
      ADD CONSTRAINT intelligence_tasks_execution_origin_check
      CHECK (execution_origin IN ('request', 'workflow'));
  END IF;
END
$$;
