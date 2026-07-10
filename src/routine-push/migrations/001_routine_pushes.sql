-- Проактивные рутинные пуши (Слой 3). Старт: «энергия дня» от Райи.
-- Один пользователь × один kind = одна строка (opt-in, 1 рутина каждого вида).
CREATE TABLE IF NOT EXISTS routine_pushes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text NOT NULL,
  kind           text NOT NULL DEFAULT 'energy_of_day',
  assistant_id   text NOT NULL DEFAULT '14',       -- Райя
  prompt         text NOT NULL,
  send_hour      int  NOT NULL DEFAULT 8,           -- локальный час 0..23
  tz             text NOT NULL DEFAULT 'Europe/Moscow',
  enabled        boolean NOT NULL DEFAULT true,
  last_sent_date date,                              -- защита от дублей (в локальной tz)
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now(),
  UNIQUE (user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_routine_pushes_enabled ON routine_pushes (enabled) WHERE enabled;
