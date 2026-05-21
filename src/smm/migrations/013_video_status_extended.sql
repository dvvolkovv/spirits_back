-- 013_video_status_extended.sql
-- Adds escape_hatch_offered + cancelled to smm_video.status enum.
-- escape_hatch_offered = premium-pipeline исчерпал retries, юзеру нужно выбрать что делать.
-- cancelled = юзер выбрал refund через POST /videos/:id/escape-hatch (Task 19).
-- Idempotent: drop-then-add (Postgres не поддерживает IF NOT EXISTS на CONSTRAINT).

ALTER TABLE smm_video DROP CONSTRAINT IF EXISTS smm_video_status_check;
ALTER TABLE smm_video ADD CONSTRAINT smm_video_status_check
  CHECK (status IN (
    'queued', 'rendering', 'ready', 'failed', 'approved', 'rejected',
    'escape_hatch_offered', 'cancelled'
  ));
