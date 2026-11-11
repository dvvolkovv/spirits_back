DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('alert-bot/002'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS alert_bot_repairs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    update_id bigint NOT NULL,
    turn_id uuid,
    chat_id text NOT NULL,
    admin_tg_id text NOT NULL,
    instruction text NOT NULL,
    status text NOT NULL DEFAULT 'requested',
    failure_kind text,
    mutation_count integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS alert_bot_repair_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    repair_id uuid NOT NULL REFERENCES alert_bot_repairs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL,
    host text NOT NULL,
    command_redacted text NOT NULL,
    kind text NOT NULL,
    mutates boolean NOT NULL DEFAULT true,
    interruptible boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'queued',
    requested_timeout_ms integer NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    exit_code integer,
    stdout_redacted text,
    stderr_redacted text,
    failure_kind text,
    UNIQUE (repair_id, sequence)
  );
  IF to_regclass('idx_alert_bot_repairs_update') IS NULL THEN
    CREATE UNIQUE INDEX idx_alert_bot_repairs_update ON alert_bot_repairs (update_id);
  END IF;
  IF to_regclass('idx_alert_bot_repairs_active_chat') IS NULL THEN
    CREATE UNIQUE INDEX idx_alert_bot_repairs_active_chat ON alert_bot_repairs (chat_id)
      WHERE status IN ('requested', 'running', 'cancel_requested');
  END IF;
  IF to_regclass('idx_alert_bot_repairs_active_turn') IS NULL THEN
    CREATE UNIQUE INDEX idx_alert_bot_repairs_active_turn ON alert_bot_repairs (turn_id)
      WHERE status IN ('requested', 'running', 'cancel_requested') AND turn_id IS NOT NULL;
  END IF;
  IF to_regclass('idx_alert_bot_repair_jobs_active') IS NULL THEN
    CREATE UNIQUE INDEX idx_alert_bot_repair_jobs_active ON alert_bot_repair_jobs (repair_id)
      WHERE status IN ('queued', 'running');
  END IF;
  IF to_regclass('idx_alert_bot_repair_jobs_created') IS NULL THEN
    CREATE INDEX idx_alert_bot_repair_jobs_created ON alert_bot_repair_jobs (repair_id, sequence);
  END IF;
  IF to_regclass('idx_alert_bot_repairs_created') IS NULL THEN
    CREATE INDEX idx_alert_bot_repairs_created ON alert_bot_repairs (created_at);
  END IF;
END $$;
