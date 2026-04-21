-- 001_video_jobs.sql
CREATE TABLE IF NOT EXISTS video_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  mode             text NOT NULL,
  model            text NOT NULL,
  quality          text NOT NULL,
  duration_sec     int NOT NULL,
  prompt           text,
  negative_prompt  text,
  cfg_scale        numeric(3,1),
  source_image_url text,
  source_video_id  uuid REFERENCES video_jobs(id) ON DELETE SET NULL,
  camera_type      text,
  camera_config    jsonb,
  audio_url        text,
  tokens_spent     bigint NOT NULL,
  kling_task_id    text,
  status           text NOT NULL DEFAULT 'pending',
  video_url        text,
  thumbnail_url    text,
  error_message    text,
  created_at       timestamp with time zone DEFAULT now(),
  updated_at       timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_created
  ON video_jobs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_video_jobs_active_status
  ON video_jobs (status)
  WHERE status IN ('pending','processing');
