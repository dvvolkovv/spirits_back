-- 003_telegram_provider.sql
--
-- Добавляет провайдера 'telegram' для входа из Mini App.
--
-- ВАЖНО: констрейнт перечисляется ЦЕЛИКОМ, все семь провайдеров.
-- 002_talerid_provider.sql перезаписал констрейнт без 'apple', хотя 001 его
-- перечислял, — вход через Apple ломался бы на вставке. Эта миграция чинит
-- заодно и его. Любая следующая миграция обязана поступать так же:
-- перечислять всех, а не дописывать одного.

ALTER TABLE user_identities DROP CONSTRAINT IF EXISTS user_identities_provider_check;
ALTER TABLE user_identities ADD CONSTRAINT user_identities_provider_check
  CHECK (provider IN ('phone','email','google','yandex','talerid','apple','telegram'));
