-- Журнал попыток создать платёж.
--
-- Раньше провалившаяся попытка не оставляла следа НИГДЕ: строка в payments
-- пишется только ПОСЛЕ успешного ответа провайдера, а тело ошибки провайдера
-- проглатывалось. Инцидент 14–15.08.2026: магазин ЮKassa перевели в
-- status=disabled, POST /v3/payments начал отдавать 403, пользователи видели
-- «Internal server error» — и двое суток об этом никто не знал, потому что в
-- БД не появлялось ни одной записи, а в логе был только стектрейс без причины.
-- Причину пришлось доставать руками отдельным запросом к API провайдера.
--
-- Таблица закрывает три дыры сразу: даёт мониторингу сигнал «подряд отказы»
-- (переживает рестарт, в отличие от счётчика в памяти), сохраняет ответ
-- провайдера для разбора, и показывает реальный спрос — сколько людей пытались
-- заплатить и не смогли.
CREATE TABLE IF NOT EXISTS payment_attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  provider    text NOT NULL,
  package_id  text,
  amount      numeric(10,2),
  currency    text,
  ok          boolean NOT NULL,
  http_status int,                 -- статус от провайдера, если ответ был
  error       text,                -- тело ответа/сообщение, обрезано
  payment_id  text,                -- заполнен только при успехе
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Единственный путь чтения у мониторинга — последние попытки по провайдеру.
CREATE INDEX IF NOT EXISTS idx_payment_attempts_recent
  ON payment_attempts(provider, created_at DESC);

-- Разбор инцидента: показать только неудачные за окно.
CREATE INDEX IF NOT EXISTS idx_payment_attempts_failed
  ON payment_attempts(created_at DESC)
  WHERE NOT ok;
