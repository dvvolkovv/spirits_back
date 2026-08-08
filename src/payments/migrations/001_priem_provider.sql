-- Приём криптоплатежей через «Приём» (priem.io) рядом с YooKassa.
--
-- До этого в payments лежали только рублёвые платежи YooKassa, и ни провайдер,
-- ни валюта не хранились — они подразумевались. Теперь строк два вида, и
-- различать их нужно явно: у «Приёма» суммы в USD, а payment_id — его uuid.
--
-- provider проставляется существующим строкам как 'yookassa': все платежи до
-- этой миграции были именно им.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'yookassa',
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'RUB';

-- Ключ идемпотентности, который мы отдаём «Приёму». Он обязан быть нашим и
-- устойчивым (номер заказа), иначе повторный запрос выставит второй счёт
-- вместо возврата того же платежа. Уникальность — чтобы это гарантировала
-- база, а не только код.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_uniq
  ON payments (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Коллбэк приходит с paymentId «Приёма» и без user_id: искать строку по
-- payment_id надо быстро и в отрыве от пользователя.
CREATE INDEX IF NOT EXISTS payments_provider_payment_id_idx
  ON payments (provider, payment_id);
