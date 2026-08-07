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
  -- tokens_spent — сколько реально списано за ЭТОТ синтез. У кэш-хита списания
  -- нет, поэтому сумма по стриму (chat.service.ts, toolSpent) обязана считаться
  -- только по created_at >= начала стрима, а не по last_used_at.
  tokens_spent int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- last_used_at — момент последней ВЫДАЧИ клипа, включая бесплатный кэш-хит.
  -- Без него повтор того же текста не получал маркера {{audio:id=...}}: блок
  -- инъекции в chat.service.ts ищет клипы за время стрима, а created_at у
  -- кэш-хита старый — инструмент отчитывался успехом, а плеера не было.
  last_used_at timestamptz NOT NULL DEFAULT now()
);

-- Отдельными ALTER'ами — на случай, если таблица уже создана прежней версией
-- этого же файла (миграция не выкачена ни на один сервер, но повторное
-- применение должно быть безопасным).
ALTER TABLE speech_clips ADD COLUMN IF NOT EXISTS tokens_spent int NOT NULL DEFAULT 0;
ALTER TABLE speech_clips ADD COLUMN IF NOT EXISTS last_used_at timestamptz NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS speech_clips_user_key
  ON speech_clips (user_id, cache_key);

CREATE INDEX IF NOT EXISTS speech_clips_user_created
  ON speech_clips (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS speech_clips_user_last_used
  ON speech_clips (user_id, last_used_at DESC);
