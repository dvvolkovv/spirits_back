-- Long-form video support. For target_duration > 10s we plan a chain of
-- Kling calls (base 10s + N × extend 5s), then ffmpeg-concat + trim to the
-- exact requested duration. composed_plan tracks progress across the chain;
-- the job stays as a single video_jobs row so the UI shows one progress
-- bar and one final MP4.

ALTER TABLE video_jobs
  ADD COLUMN IF NOT EXISTS target_duration_sec INT,
  ADD COLUMN IF NOT EXISTS composed_plan       JSONB;

-- composed_plan shape (when present):
-- {
--   "target_duration_sec":     24,
--   "segments_total":           4,         // 1 base + 3 extends
--   "segments_done":            0,
--   "segment_kling_video_ids": [],         // Kling video_id per segment
--   "segment_video_urls":      []          // Kling-side URL per segment
-- }
