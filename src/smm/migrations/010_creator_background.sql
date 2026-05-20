-- 010_creator_background.sql
-- Adds creator-customisable background to smm_creator_campaign.
-- Either a CSS color/gradient string OR a public URL of an uploaded image.
-- If both are set, the image takes precedence in the renderer.

ALTER TABLE smm_creator_campaign
  ADD COLUMN IF NOT EXISTS bg_color     text,
  ADD COLUMN IF NOT EXISTS bg_image_url text;
