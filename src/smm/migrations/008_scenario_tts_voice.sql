-- 008_scenario_tts_voice.sql
-- Adds tts_voice_id to smm_scenario for creator-mode random voice selection.
-- Admin/Linkeon path leaves it NULL and uses the per-role voice map in the worker.
ALTER TABLE smm_scenario ADD COLUMN IF NOT EXISTS tts_voice_id text;
