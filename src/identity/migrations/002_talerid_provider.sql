-- 002_talerid_provider.sql
-- Добавляет talerid в список разрешённых провайдеров входа.
--
-- Без этого вставка identity падает на CHECK из 001: список провайдеров
-- там перечислен явно, и новый способ входа отвергается базой уже ПОСЛЕ
-- успешного обмена кода — то есть человек проходит окно согласия
-- провайдера и получает ошибку на последнем шаге.
--
-- drop-then-add: Postgres не поддерживает IF NOT EXISTS на CONSTRAINT,
-- поэтому идемпотентность достигается сносом старого ограничения.

BEGIN;

ALTER TABLE user_identities DROP CONSTRAINT IF EXISTS user_identities_provider_check;
ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_check
  CHECK (provider IN ('phone','email','google','yandex','talerid'));

COMMIT;
