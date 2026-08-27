-- 001_meeting_rooms.sql
-- Голосовая комната Linkeon.
--
-- Живёт дольше одного входа ассистента и существует без него вовсе: люди
-- могут собраться и поговорить сами, а ассистента позвать позже или никогда.
CREATE TABLE IF NOT EXISTS meeting_rooms (
  code           TEXT PRIMARY KEY,
  -- TEXT, не varchar(20): у пользователей через email/OAuth идентификатор это
  -- gen_random_uuid()::text (36 символов), а не телефон. Колонка под телефон
  -- сломалась бы на первом же таком владельце.
  owner_user_id  TEXT NOT NULL,
  title          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS meeting_rooms_owner_idx
  ON meeting_rooms (owner_user_id, created_at DESC);

-- Вход ассистента переиспользует voice_calls: жизненный цикл, завершение,
-- учёт стоимости и карточка в ленте у встречи те же, что у звонка. Отдельная
-- таблица означала бы дублирование complete/fail/reaper.
--
-- provider: 'linkeon' — звонок из интерфейса (всё, что было до этого),
-- 'linkeon_room' — встреча. Дальше сюда добавится 'zoom'.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'linkeon';

-- Код комнаты. Не UNIQUE: в одну комнату могут по очереди заходить разные
-- ассистенты разных пользователей, и история этих входов должна сохраняться.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_room TEXT;

-- Момент, когда в комнате впервые появился живой участник. Пока NULL —
-- действует ожидание LOBBY_MS, а не правило «комната опустела»: ассистента
-- могут позвать раньше, чем соберутся люди.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS first_human_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS voice_calls_provider_room_idx
  ON voice_calls (provider, external_room) WHERE external_room IS NOT NULL;
