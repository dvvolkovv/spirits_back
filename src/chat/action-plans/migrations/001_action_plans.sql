CREATE TABLE IF NOT EXISTS action_plans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  session_id   text NOT NULL,
  assistant_id text NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT action_plans_items_array CHECK (jsonb_typeof(items) = 'array')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_action_plans_user_session
  ON action_plans (user_id, session_id);

CREATE INDEX IF NOT EXISTS idx_action_plans_user_updated
  ON action_plans (user_id, updated_at DESC);
