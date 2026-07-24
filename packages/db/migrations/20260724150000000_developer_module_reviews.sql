DO $developer$
BEGIN
  CREATE TYPE kortix.developer_module_review_action AS ENUM (
    'submit',
    'resubmit',
    'request_changes',
    'approve',
    'revoke'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

DO $developer$
BEGIN
  CREATE TYPE kortix.developer_module_review_actor_kind AS ENUM (
    'publisher',
    'platform_admin'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$developer$;

ALTER TABLE kortix.developer_module_releases
  ADD COLUMN IF NOT EXISTS review_revision integer NOT NULL DEFAULT 0;

DO $developer$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_review_revision_check'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_review_revision_check
      CHECK (review_revision >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'developer_module_releases_release_account_unique'
      AND conrelid = 'kortix.developer_module_releases'::regclass
  ) THEN
    ALTER TABLE kortix.developer_module_releases
      ADD CONSTRAINT developer_module_releases_release_account_unique
      UNIQUE (release_id, account_id);
  END IF;
END
$developer$;

CREATE INDEX IF NOT EXISTS idx_developer_module_releases_review_queue
  ON kortix.developer_module_releases(status, updated_at, release_id);

CREATE TABLE IF NOT EXISTS kortix.developer_module_release_review_events (
  review_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  release_id uuid NOT NULL,
  account_id uuid NOT NULL,
  sequence integer NOT NULL,
  action kortix.developer_module_review_action NOT NULL,
  from_status kortix.developer_module_release_status NOT NULL,
  to_status kortix.developer_module_release_status NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_kind kortix.developer_module_review_actor_kind NOT NULL,
  reason text,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT developer_module_release_review_events_release_account_fk
    FOREIGN KEY (release_id, account_id)
    REFERENCES kortix.developer_module_releases(release_id, account_id)
    ON DELETE CASCADE,
  CONSTRAINT developer_module_release_review_events_release_sequence_unique
    UNIQUE (release_id, sequence),
  CONSTRAINT developer_module_release_review_events_sequence_check
    CHECK (sequence > 0),
  CONSTRAINT developer_module_release_review_events_reason_check
    CHECK (
      (
        reason IS NULL
        OR (
          length(BTRIM(reason)) BETWEEN 1 AND 4000
          AND octet_length(reason) <= 8192
        )
      )
      AND (
        action NOT IN ('resubmit', 'request_changes', 'revoke')
        OR reason IS NOT NULL
      )
    ),
  CONSTRAINT developer_module_release_review_events_evidence_check
    CHECK (
      jsonb_typeof(evidence) = 'array'
      AND jsonb_array_length(evidence) <= 16
      AND pg_column_size(evidence) <= 32768
      AND (
        (action = 'approve' AND jsonb_array_length(evidence) BETWEEN 2 AND 16)
        OR (action <> 'approve' AND jsonb_array_length(evidence) = 0)
      )
    ),
  CONSTRAINT developer_module_release_review_events_transition_check
    CHECK (
      (
        action = 'submit'
        AND actor_kind = 'publisher'
        AND from_status = 'validated'
        AND to_status = 'review_pending'
      ) OR (
        action = 'resubmit'
        AND actor_kind = 'publisher'
        AND from_status = 'changes_requested'
        AND to_status = 'review_pending'
      ) OR (
        action = 'request_changes'
        AND actor_kind = 'platform_admin'
        AND from_status = 'review_pending'
        AND to_status = 'changes_requested'
      ) OR (
        action = 'approve'
        AND actor_kind = 'platform_admin'
        AND from_status = 'review_pending'
        AND to_status = 'approved'
      ) OR (
        action = 'revoke'
        AND actor_kind = 'platform_admin'
        AND from_status = 'approved'
        AND to_status = 'revoked'
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_developer_module_release_review_events_account_release_sequence
  ON kortix.developer_module_release_review_events(account_id, release_id, sequence);

REVOKE UPDATE (status, review_revision, updated_at)
  ON TABLE kortix.developer_module_releases
  FROM service_role;

GRANT UPDATE (status, review_revision, updated_at)
  ON TABLE kortix.developer_module_releases
  TO service_role;

REVOKE ALL
  ON TABLE kortix.developer_module_release_review_events
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT
  ON TABLE kortix.developer_module_release_review_events
  TO service_role;
