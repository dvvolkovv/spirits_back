-- 003_smm_indexes.sql
-- Follow-up indexes from Task 3 code review (Important I-3, I-4):
-- - Worker callback paths look up videos/publications by BullMQ job id.
-- - Event log queries are typically "events for this video/publication".

CREATE INDEX IF NOT EXISTS idx_smm_video_render_job
  ON smm_video (render_job_id)
  WHERE render_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smm_publication_publish_job
  ON smm_publication (publish_job_id)
  WHERE publish_job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smm_event_log_video
  ON smm_event_log (video_id, created_at DESC)
  WHERE video_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_smm_event_log_publication
  ON smm_event_log (publication_id, created_at DESC)
  WHERE publication_id IS NOT NULL;
