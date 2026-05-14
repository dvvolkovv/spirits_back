-- 001_smm_schema.sql
-- SMM Producer feature — 9 tables for campaigns, scenarios, videos, publications,
-- social accounts, music library, pricing, billing ledger, event log.

-- 1. Campaigns ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_campaign (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  conversation_id  uuid,
  topic            text,
  source_mode      text NOT NULL CHECK (source_mode IN ('auto', 'topic', 'trends')),
  requested_count  int NOT NULL CHECK (requested_count > 0 AND requested_count <= 20),
  status           text NOT NULL DEFAULT 'drafting'
                   CHECK (status IN ('drafting', 'approved', 'done', 'cancelled')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_campaign_user_created
  ON smm_campaign (user_id, created_at DESC);

-- 2. Scenarios ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_scenario (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES smm_campaign(id) ON DELETE CASCADE,
  title            text NOT NULL,
  assistant_role   text NOT NULL,
  dialog           jsonb NOT NULL,
  mood             text NOT NULL,
  broll_prompts    jsonb NOT NULL DEFAULT '[]'::jsonb,
  music_track_id   text,
  tts_tier         text NOT NULL DEFAULT 'premium'
                   CHECK (tts_tier IN ('economy', 'premium')),
  status           text NOT NULL DEFAULT 'pending_review'
                   CHECK (status IN ('pending_review', 'approved', 'rejected', 'regenerating')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_scenario_campaign
  ON smm_scenario (campaign_id, created_at);

-- 3. Videos ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_video (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id      uuid NOT NULL UNIQUE REFERENCES smm_scenario(id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued', 'rendering', 'ready', 'failed', 'approved', 'rejected')),
  render_job_id    text,
  render_state     jsonb NOT NULL DEFAULT '{}'::jsonb,
  mp4_url          text,
  duration_sec     int,
  size_bytes       bigint,
  error_message    text,
  tokens_charged   int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_video_status
  ON smm_video (status)
  WHERE status IN ('queued', 'rendering', 'failed');

-- 4. Publications ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_publication (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id          uuid NOT NULL REFERENCES smm_video(id) ON DELETE CASCADE,
  platform          text NOT NULL
                    CHECK (platform IN ('telegram', 'vk', 'youtube', 'tiktok', 'instagram')),
  scheduled_at      timestamptz,
  status            text NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  publish_job_id    text,
  external_url      text,
  external_post_id  text,
  caption           text,
  error_message     text,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (video_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_smm_publication_scheduled
  ON smm_publication (scheduled_at)
  WHERE status = 'scheduled';

-- 5. Social accounts ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_social_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text,
  platform      text NOT NULL
                CHECK (platform IN ('telegram', 'vk', 'youtube', 'tiktok', 'instagram')),
  display_name  text NOT NULL,
  credentials   jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_social_account_user_platform
  ON smm_social_account (user_id, platform);

-- 6. Music library -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_music_track (
  id            text PRIMARY KEY,
  title         text NOT NULL,
  mood          text NOT NULL
                CHECK (mood IN ('dramatic', 'inspiring', 'calm', 'uplifting', 'tense', 'neutral')),
  duration_sec  int NOT NULL,
  storage_key   text NOT NULL,
  license       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- 7. Pricing -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_pricing (
  id            text PRIMARY KEY
                CHECK (id IN ('economy', 'premium')),
  tokens_cost   int NOT NULL CHECK (tokens_cost > 0),
  display_name  text NOT NULL,
  description   text,
  active        boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 8. Billing ledger ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_billing_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  video_id      uuid REFERENCES smm_video(id) ON DELETE SET NULL,
  amount        int NOT NULL,
  op            text NOT NULL CHECK (op IN ('charge', 'refund')),
  reason        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_ledger_user_created
  ON smm_billing_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_smm_ledger_video
  ON smm_billing_ledger (video_id);

-- 9. Event log ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS smm_event_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type      text NOT NULL,
  video_id        uuid REFERENCES smm_video(id) ON DELETE SET NULL,
  publication_id  uuid REFERENCES smm_publication(id) ON DELETE SET NULL,
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smm_event_log_created
  ON smm_event_log (created_at DESC);

-- updated_at triggers --------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_smm_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'smm_campaign','smm_scenario','smm_video',
    'smm_publication','smm_social_account','smm_pricing'
  ])
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS smm_updated_at ON %I;
       CREATE TRIGGER smm_updated_at BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION trg_smm_set_updated_at();',
      t, t
    );
  END LOOP;
END $$;
