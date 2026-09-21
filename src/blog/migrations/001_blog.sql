-- 001_blog.sql
-- Автоблог Linkeon в Telegram. Одна таблица постов: идея — это тот же пост
-- без текста, отдельной очереди идей нет.

CREATE TABLE IF NOT EXISTS blog_post (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rubric         text NOT NULL CHECK (rubric IN ('news','case')),
  source         text NOT NULL CHECK (source IN ('backlog','git','stats','manual')),
  source_ref     text,
  topic_key      text NOT NULL,
  -- Подсказка темы от источника (например «на этой неделе часто спрашивали
  -- юриста про аренду»). Редактор получает её на вход.
  topic_hint     text,
  lang           text NOT NULL DEFAULT 'ru',
  title          text,
  body           text,
  image_prompt   text,
  image_url      text,
  status         text NOT NULL DEFAULT 'idea'
                   CHECK (status IN ('idea','drafting','pending_review','approved',
                                     'publishing','published','rejected','failed')),
  slot_at        timestamptz,
  published_at   timestamptz,
  -- Координаты сообщения-черновика в личке у владельца. Без них правку
  -- текста реплаем не с чем сопоставить.
  review_chat_id     bigint,
  review_message_id  bigint,
  tg_message_id  bigint,
  tg_url         text,
  attempts       int NOT NULL DEFAULT 0,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_post_status_slot ON blog_post (status, slot_at);
CREATE INDEX IF NOT EXISTS idx_blog_post_topic_created ON blog_post (topic_key, created_at DESC);
-- Поиск черновика по сообщению в личке: нужен для правки реплаем.
CREATE INDEX IF NOT EXISTS idx_blog_post_review_msg ON blog_post (review_chat_id, review_message_id);

-- Единственная строка настроек (id всегда 1): канал публикации, расписание
-- слотов и общий стиль генерации картинок.
CREATE TABLE IF NOT EXISTS blog_settings (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  channel_chat_id text,
  slot_days       int[] NOT NULL DEFAULT '{1,3,5}',
  slot_hour_msk   int   NOT NULL DEFAULT 10,
  image_style     text  NOT NULL DEFAULT '',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO blog_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
