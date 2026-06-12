-- Новый статус 'waiting' (ожидание ответа клиента) для задач бэклога.
-- Пример: видео-задача ждёт фидбэка Екатерины — это не «в работе».
ALTER TABLE backlog_items DROP CONSTRAINT IF EXISTS backlog_items_status_check;
ALTER TABLE backlog_items ADD CONSTRAINT backlog_items_status_check
  CHECK (status IN ('proposed','approved','in_progress','waiting','done','rejected'));
