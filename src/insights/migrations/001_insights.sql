-- Затыки недели. Спека: docs/superpowers/specs/2026-10-24-conversation-insights-design.md.
-- Файл катится на каждом старте (как у остальных модулей), идемпотентно.
-- Лок — против двух одновременных первых стартов: проигравший ждёт, а не
-- ловит 23505 на pg_type (так было у products).
SELECT pg_advisory_xact_lock(hashtext('insights/001_insights'));

-- В таблицах insights_* нет ни цитат, ни id пользователей, ни id сессий:
-- поэтому при удалении аккаунта стирать здесь нечего.
CREATE TABLE IF NOT EXISTS insights_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start        date NOT NULL,
  manual            boolean NOT NULL DEFAULT false,
  status            text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'postponed')),
  attempts          int NOT NULL DEFAULT 0,
  retry_at          timestamptz,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  conversations     int,
  people            int,
  crisis_count      int,
  signals           jsonb,
  cost_usd          numeric(10, 4),
  error             text,
  digest_chat_id    bigint,
  digest_message_id bigint,
  finding_ids       uuid[]
);
CREATE INDEX IF NOT EXISTS idx_insights_runs_week ON insights_runs (week_start, status);

CREATE TABLE IF NOT EXISTS insights_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type             text NOT NULL CHECK (type IN ('missing', 'confused', 'assistant', 'failure', 'money', 'silent')),
  title            text NOT NULL,
  description      text NOT NULL,
  proposal         text NOT NULL,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'backlog', 'rejected')),
  first_week       date NOT NULL,
  last_week        date NOT NULL,
  rejected_people  int,
  backlog_item_id  uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insights_findings_last_week ON insights_findings (last_week DESC);

CREATE TABLE IF NOT EXISTS insights_finding_weeks (
  finding_id     uuid NOT NULL REFERENCES insights_findings(id) ON DELETE CASCADE,
  week_start     date NOT NULL,
  people         int NOT NULL,
  conversations  int NOT NULL,
  assistants     text[] NOT NULL DEFAULT '{}',
  severity       int NOT NULL CHECK (severity BETWEEN 1 AND 3),
  PRIMARY KEY (finding_id, week_start)
);

-- Выключатель расписания: в базе, а не в .env — править файлы на сервере
-- руками нельзя (правила выката). Ключ 'enabled', значение jsonb true/false.
CREATE TABLE IF NOT EXISTS insights_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
