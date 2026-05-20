-- 007_creator_campaign.sql
-- Adds is_linkeon_official flag to smm_campaign and creates
-- smm_creator_campaign for external-user CTA/voice/genre settings.

ALTER TABLE smm_campaign
  ADD COLUMN IF NOT EXISTS is_linkeon_official boolean NOT NULL DEFAULT false;

-- Backfill: all existing campaigns are admin-owned Linkeon-marketing.
UPDATE smm_campaign SET is_linkeon_official = true WHERE created_at < now();

CREATE TABLE IF NOT EXISTS smm_creator_campaign (
  campaign_id   uuid PRIMARY KEY REFERENCES smm_campaign(id) ON DELETE CASCADE,
  cta_handle    text NOT NULL,
  cta_label     text NOT NULL DEFAULT 'Подписывайся',
  voice_gender  text NOT NULL CHECK (voice_gender IN ('male', 'female')),
  genre         text NOT NULL DEFAULT 'dialog'
                CHECK (genre IN ('dialog', 'monologue', 'fact_explanation')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS smm_creator_updated_at ON smm_creator_campaign;
CREATE TRIGGER smm_creator_updated_at BEFORE UPDATE ON smm_creator_campaign
  FOR EACH ROW EXECUTE FUNCTION trg_smm_set_updated_at();
