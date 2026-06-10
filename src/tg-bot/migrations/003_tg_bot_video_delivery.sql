-- Контекст доставки async video-job'ов в Telegram. video_jobs (видео-модуль) —
-- источник истины состояния рендера; эта таблица только связывает готовый job
-- с TG-чатом куда нужно его прислать.
CREATE TABLE IF NOT EXISTS tg_bot_video_jobs (
  job_id uuid PRIMARY KEY REFERENCES video_jobs(id) ON DELETE CASCADE,
  tg_chat_id bigint NOT NULL,
  tg_reply_to_message_id integer,
  config_id uuid REFERENCES tg_bot_configs(id) ON DELETE SET NULL,
  delivery_status text NOT NULL DEFAULT 'pending',  -- pending | sent | failed
  delivery_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Главный путь чтения у поллера — найти все job'ы которые ждут доставки.
CREATE INDEX IF NOT EXISTS idx_tg_bot_video_jobs_pending
  ON tg_bot_video_jobs(created_at)
  WHERE delivery_status = 'pending';
