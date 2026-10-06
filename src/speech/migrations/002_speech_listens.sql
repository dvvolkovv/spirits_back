-- 002_speech_listens.sql
-- Прослушивания ответов кнопкой «Прослушать» (POST /webhook/speech/listen).
--
-- Отдельно от speech_clips НАМЕРЕННО: chat.service.ts в конце стрима
-- подхватывает строки speech_clips за время ответа — вставляет маркер плеера
-- {{audio:id=…}} и прибавляет их tokens_spent к счётчику «X токенов». Нажми
-- пользователь «Прослушать» на старом ответе, пока ассистент пишет новый, —
-- новый получил бы чужой плеер и чужую цену.
--
-- cache_key = sha256(text voice lang), как у speech_clips: тот же ответ другим
-- голосом — другая запись. parts — публичные URL кусков в порядке чтения:
-- длинный ответ синтезируется по частям (split.ts).
-- user_id = text: у email/OAuth-пользователей это uuid на 36 символов.
CREATE TABLE IF NOT EXISTS speech_listens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      text NOT NULL,
  assistant    text,
  cache_key    text NOT NULL,
  parts        jsonb NOT NULL,
  chars        int NOT NULL,
  provider     text NOT NULL,
  voice        text NOT NULL,
  lang         text NOT NULL,
  tokens_spent int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS speech_listens_user_key
  ON speech_listens (user_id, cache_key);
