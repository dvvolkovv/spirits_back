-- 001_custom_agents.sql
-- Personal library of user-defined AI agents (custom roles).
-- Referenced by /chat AssistantSelection and (future) Telegram bot configs.

CREATE TABLE IF NOT EXISTS custom_agents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  name          text NOT NULL,
  description   text,
  system_prompt text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_custom_agents_owner
  ON custom_agents (owner_user_id, updated_at DESC);
