DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('alert-bot/001'));
  PERFORM set_config('lock_timeout', '5s', true);
  CREATE TABLE IF NOT EXISTS alert_messages (
    id bigserial PRIMARY KEY, chat_id text NOT NULL, message_id bigint NOT NULL,
    text text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS alert_bot_updates (
    update_id bigint PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS alert_bot_turns (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), update_id bigint NOT NULL,
    chat_id text NOT NULL, tg_user_id text NOT NULL, linkeon_user_id text NOT NULL,
    question_message_id bigint NOT NULL, answer_message_id bigint, parent_turn_id uuid,
    question text NOT NULL, answer text, tools jsonb NOT NULL DEFAULT '[]'::jsonb,
    status text NOT NULL DEFAULT 'in_progress', error_kind text, duration_ms integer,
    cost_usd numeric(12,6), private_chat boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
  );
  CREATE TABLE IF NOT EXISTS alert_bot_ticket_drafts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), chat_id text NOT NULL,
    tg_user_id text NOT NULL, linkeon_user_id text NOT NULL, ticket_id uuid NOT NULL,
    text text NOT NULL, prompt_message_id bigint,
    expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    outcome text, claimed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz
  );
  ALTER TABLE alert_bot_ticket_drafts
    ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
  IF to_regclass('idx_alert_messages_created') IS NULL THEN
    CREATE INDEX idx_alert_messages_created ON alert_messages (created_at DESC);
  END IF;
  IF to_regclass('idx_alert_bot_turns_answer') IS NULL THEN
    CREATE INDEX idx_alert_bot_turns_answer ON alert_bot_turns (chat_id, answer_message_id);
  END IF;
  IF to_regclass('idx_alert_bot_turns_user_recent') IS NULL THEN
    CREATE INDEX idx_alert_bot_turns_user_recent ON alert_bot_turns (linkeon_user_id, created_at DESC);
  END IF;
  IF to_regclass('idx_alert_bot_turns_chat_recent') IS NULL THEN
    CREATE INDEX idx_alert_bot_turns_chat_recent ON alert_bot_turns (chat_id, created_at DESC);
  END IF;
  IF to_regclass('idx_alert_bot_turns_in_progress') IS NULL THEN
    CREATE INDEX idx_alert_bot_turns_in_progress ON alert_bot_turns (status) WHERE status = 'in_progress';
  END IF;
  IF to_regclass('idx_alert_bot_drafts_expiry') IS NULL THEN
    CREATE INDEX idx_alert_bot_drafts_expiry ON alert_bot_ticket_drafts (expires_at) WHERE outcome IS NULL;
  END IF;
END $$;
