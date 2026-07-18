ALTER TABLE kortix.intelligence_workflow_nodes
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS request_hash text;

UPDATE kortix.intelligence_workflow_nodes
SET
  idempotency_key = COALESCE(idempotency_key, 'legacy-node:' || node_id::text),
  request_hash = COALESCE(request_hash, input_hash)
WHERE idempotency_key IS NULL OR request_hash IS NULL;

ALTER TABLE kortix.intelligence_workflow_nodes
  ALTER COLUMN idempotency_key SET NOT NULL,
  ALTER COLUMN request_hash SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kortix.intelligence_workflow_nodes'::regclass
      AND conname = 'intelligence_workflow_nodes_run_idempotency_unique'
  ) THEN
    ALTER TABLE kortix.intelligence_workflow_nodes
      ADD CONSTRAINT intelligence_workflow_nodes_run_idempotency_unique
      UNIQUE (run_id, idempotency_key);
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'kortix.intelligence_workflow_nodes'::regclass
      AND conname = 'intelligence_workflow_nodes_request_hash_check'
  ) THEN
    ALTER TABLE kortix.intelligence_workflow_nodes
      ADD CONSTRAINT intelligence_workflow_nodes_request_hash_check
      CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$');
  END IF;
END
$$;
