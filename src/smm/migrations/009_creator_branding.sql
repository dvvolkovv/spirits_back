-- 009_creator_branding.sql
-- Adds creator branding fields: own logo (uploaded to MinIO), short CTA slogan
-- rendered on the final video frame, and default caption used by PublishModal.

ALTER TABLE smm_creator_campaign
  ADD COLUMN IF NOT EXISTS logo_url        text,
  ADD COLUMN IF NOT EXISTS cta_slogan      text,
  ADD COLUMN IF NOT EXISTS publish_caption text;
