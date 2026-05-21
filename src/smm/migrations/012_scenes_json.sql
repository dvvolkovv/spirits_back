-- 012_scenes_json.sql
-- Adds scenes_json column to smm_scenario — premium-mode scenes array
-- (objects with type: 'kling' | 'imagen', keyframe_prompt, motion_prompt).
-- Idempotent. Old scenarios get NULL = "classic" path.

ALTER TABLE smm_scenario
  ADD COLUMN IF NOT EXISTS scenes_json jsonb NULL;
