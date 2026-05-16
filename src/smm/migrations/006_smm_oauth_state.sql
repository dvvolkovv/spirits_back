-- 006_smm_oauth_state.sql
-- One-shot CSRF state tokens for OAuth flow.
-- A row is inserted at /oauth/:platform/start, deleted at /oauth/:platform/callback.
-- Rows older than 10 minutes are cleaned up by a periodic cron.

CREATE TABLE IF NOT EXISTS smm_oauth_state (
  state         text PRIMARY KEY,         -- crypto-random hex string, also used in URL
  user_id       text NOT NULL,            -- phone of the admin who initiated
  platform      text NOT NULL
                CHECK (platform IN ('vk', 'youtube', 'tiktok', 'instagram')),
  redirect_url  text,                     -- optional: where to redirect after success
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_smm_oauth_state_created
  ON smm_oauth_state (created_at);

-- For the schedule_publication "show me what's queued?" query
CREATE INDEX IF NOT EXISTS idx_smm_publication_user_scheduled
  ON smm_publication (status, scheduled_at);
