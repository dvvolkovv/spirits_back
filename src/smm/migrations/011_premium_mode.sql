-- 011_premium_mode.sql
-- Adds premium-mode fields to smm_scenario + creates audit table for billing/refund.
-- Idempotent.

ALTER TABLE smm_scenario
  ADD COLUMN IF NOT EXISTS premium_genre text NULL,
  ADD COLUMN IF NOT EXISTS kling_scene_count int NOT NULL DEFAULT 0;

-- Postgres doesn't support IF NOT EXISTS on ADD CONSTRAINT — drop-then-add.
ALTER TABLE smm_scenario DROP CONSTRAINT IF EXISTS premium_genre_check;
ALTER TABLE smm_scenario ADD CONSTRAINT premium_genre_check
  CHECK (premium_genre IS NULL OR premium_genre IN ('surreal', 'pov', 'cinematic'));

CREATE TABLE IF NOT EXISTS smm_premium_generation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id              uuid REFERENCES smm_video(id) ON DELETE CASCADE,
  user_id               text NOT NULL,
  genre                 text NOT NULL,
  scene_count           int  NOT NULL,
  tokens_charged        int  NOT NULL,
  tokens_refunded       int  NOT NULL DEFAULT 0,
  status                text NOT NULL,         -- 'in_progress' | 'completed' | 'partial_refund' | 'full_refund'
  internal_cost_cents   int,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);

CREATE INDEX IF NOT EXISTS idx_premium_gen_user_created
  ON smm_premium_generation(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_premium_gen_video
  ON smm_premium_generation(video_id);
