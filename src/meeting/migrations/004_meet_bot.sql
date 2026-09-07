-- 004_meet_bot.sql
-- id бота Attendee. Нужен ровно для одного: вывести Chrome из встречи, когда
-- ассистент вышел. Без него бот остаётся сидеть в встрече — видимый участник,
-- которого никто не звал.
--
-- Отдельная колонка, а не JSON в summary: её читает реапер, и запрос по полю
-- честнее, чем разбор текста.
ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS external_bot_id TEXT;

-- Под проход реапера «забытые боты»: он крутится каждые 5 минут и в штатном
-- состоянии не находит ничего. Без индекса это seq scan по всей истории
-- звонков, потому что убедиться в отсутствии строк можно только прочитав
-- таблицу целиком — LIMIT здесь не помогает.
--
-- Частичный: external_bot_id не-null только у встреч Meet, поэтому индекс
-- останется маленьким независимо от роста voice_calls. Тот же приём, что у
-- voice_calls_active_idx и voice_calls_provider_room_idx.
CREATE INDEX IF NOT EXISTS voice_calls_external_bot_idx
  ON voice_calls (external_bot_id) WHERE external_bot_id IS NOT NULL;
