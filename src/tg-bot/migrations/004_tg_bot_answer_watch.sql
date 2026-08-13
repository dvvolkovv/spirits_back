-- Отметка «бот обязан был ответить на это сообщение».
--
-- persistUserMessage пишет в tg_bot_messages КАЖДОЕ входящее сообщение — в том
-- числе те, которые бот игнорирует намеренно: в группе с addressing_mode='strict'
-- к нему не обратились, конфиг в status='silent', это была slash-команда. Поэтому
-- «user-строка без assistant-строки» сама по себе НЕ признак сбоя: в рабочем
-- групповом чате таких строк большинство (конфиг d5a9a953: 115 сообщений, три
-- участника, бот отвечает только по обращению).
--
-- Детектор зависших чатов не может переизобрести эту логику по содержимому: часть
-- триггеров (reply на сообщение бота) в таблице вообще не хранится. Поэтому
-- намерение ответить проставляется явно — там же, где принято решение
-- (shouldRespond вернул true, либо чат занят и юзеру обещана «минутка»).
--
-- Пустое значение = ответа не ждали. Непустое без assistant-строки после него =
-- ровно тот тихий отказ, ради которого колонка заведена.
ALTER TABLE tg_bot_messages
  ADD COLUMN IF NOT EXISTS answer_expected_at timestamptz;

-- Единственный путь чтения у детектора — «висящие» отметки. Частичный индекс,
-- потому что колонка пустая у подавляющего большинства строк.
CREATE INDEX IF NOT EXISTS idx_tg_bot_messages_answer_expected
  ON tg_bot_messages(answer_expected_at)
  WHERE answer_expected_at IS NOT NULL;

-- Детектор ищет assistant-ответ, пришедший позже отметки, в том же чате.
CREATE INDEX IF NOT EXISTS idx_tg_bot_messages_assistant_by_chat
  ON tg_bot_messages(tg_chat_id, created_at)
  WHERE role = 'assistant';
