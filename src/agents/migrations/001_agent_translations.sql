-- Локализованные карточки ассистентов (имя и описание), которые видит пользователь.
-- Системные промпты НЕ переводятся намеренно: шесть копий каждой персоны — это
-- шесть источников расхождений при любой правке промпта.
CREATE TABLE IF NOT EXISTS agent_translations (
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('agent', 'custom_agent')),
  -- TEXT, а не INT: agents.id — int, custom_agents.id — uuid.
  -- Внешнего ключа нет по той же причине: таблица ссылается на два источника.
  entity_id    TEXT NOT NULL,
  locale       TEXT NOT NULL,
  display_name TEXT,
  description  TEXT,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, locale)
);

CREATE INDEX IF NOT EXISTS agent_translations_lookup
  ON agent_translations (locale, entity_type);

-- Накат вручную (migrate-runner сломан на base/001 и не докатывает ничего после):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/agents/migrations/001_agent_translations.sql
--   psql "$DATABASE_URL" -c "INSERT INTO schema_migrations (filename)
--     VALUES ('agents/001_agent_translations.sql') ON CONFLICT DO NOTHING"
-- Колонка называется filename (не name), значение — путь вида <модуль>/<файл>.sql.
-- Применено на test.linkeon.io 2026-08-05.
