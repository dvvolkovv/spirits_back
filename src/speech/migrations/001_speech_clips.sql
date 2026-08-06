-- 001_speech_clips.sql
-- Клипы озвучки ассистентов.
-- cache_key = sha256(text + voice + lang): тот же текст другим голосом обязан
-- дать другой клип, поэтому это НЕ хэш одного текста.
-- user_id = text (не varchar(20)) — у email/OAuth-пользователей идентификатор
-- это uuid на 36 символов, а не телефон (см. custom_agents.owner_user_id,
-- referral_* migrations/001_user_id_to_text.sql).
CREATE TABLE IF NOT EXISTS speech_clips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  assistant_id text,
  cache_key    text NOT NULL,
  url          text NOT NULL,
  duration_sec numeric(6,2),
  chars        int NOT NULL,
  provider     text NOT NULL,
  voice        text NOT NULL,
  lang         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS speech_clips_user_key
  ON speech_clips (user_id, cache_key);

CREATE INDEX IF NOT EXISTS speech_clips_user_created
  ON speech_clips (user_id, created_at DESC);
