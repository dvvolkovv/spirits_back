DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_id'
      AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE user_id ADD COLUMN deleted_at timestamptz NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user_id'
      AND column_name = 'deletion_id'
  ) THEN
    ALTER TABLE user_id ADD COLUMN deletion_id uuid NULL;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_id uuid NOT NULL,
  user_id text NOT NULL,
  resource_type text NOT NULL,
  resource_key text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('immediate', 'purge')),
  payload_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_jsonb) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NULL,
  last_error_kind text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (deletion_id, resource_type, resource_key)
);

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'user_id_deletion_due_idx'
  ) THEN
    CREATE INDEX user_id_deletion_due_idx ON user_id (deleted_at, internal_id)
      WHERE state = 'deleted' AND deletion_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'user_id_deletion_id_uidx'
  ) THEN
    CREATE UNIQUE INDEX user_id_deletion_id_uidx ON user_id (deletion_id)
      WHERE deletion_id IS NOT NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = 'account_deletion_jobs_claim_idx'
  ) THEN
    CREATE INDEX account_deletion_jobs_claim_idx ON account_deletion_jobs (next_attempt_at, id)
      WHERE status IN ('pending', 'failed', 'running');
  END IF;
END
$migration$;
