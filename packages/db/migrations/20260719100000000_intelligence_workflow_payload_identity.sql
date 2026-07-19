DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kortix.intelligence_workflow_payloads'::regclass
      AND conname = 'intelligence_workflow_payloads_run_node_purpose_unique'
  ) THEN
    ALTER TABLE kortix.intelligence_workflow_payloads
      ADD CONSTRAINT intelligence_workflow_payloads_run_node_purpose_unique
      UNIQUE (run_id, node_id, purpose);
  END IF;
END
$$;
