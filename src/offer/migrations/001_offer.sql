-- 001_offer.sql — cooldown-метка для оффера вовлечённому неплатящему (e184d001).
ALTER TABLE ai_profiles_consolidated
  ADD COLUMN IF NOT EXISTS offer_dismissed_at timestamptz;
