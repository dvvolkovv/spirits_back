-- 001_identity_init.sql
BEGIN;

CREATE TABLE IF NOT EXISTS user_identities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text NOT NULL REFERENCES user_id(internal_id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('phone','email','google','yandex','talerid','apple','telegram')),
  provider_sub   text NOT NULL,
  email          text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at     timestamptz DEFAULT now(),
  last_used_at   timestamptz,
  UNIQUE(provider, provider_sub)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_email_verified ON user_identities(email) WHERE email_verified;

-- Расширение списка провайдеров на УЖЕ созданной таблице: CREATE TABLE IF NOT
-- EXISTS выше существующий CHECK не трогает, поэтому пересоздаём его явно —
-- и только если он ещё не знает про самый новый провайдер (сейчас — telegram).
-- Файл прогоняется при каждом старте сервиса, так что блок обязан быть
-- идемпотентным.
--
-- ОБНОВЛЕНО 25.08.2026: старая версия этого комментария утверждала, что
-- 002_*.sql и далее в этом каталоге НЕ ИСПОЛНЯЮТСЯ и поэтому расширять список
-- провайдеров нужно именно здесь. Это больше не так: IDENTITY_MIGRATIONS в
-- identity.service.ts теперь катает и 003_telegram_provider.sql (после этого
-- файла), и любой следующий пронумерованный файл, если он добавлен в список.
-- Новые провайдеры добавлять отдельным файлом миграции + записью в
-- IDENTITY_MIGRATIONS, а не правкой этого блока — 002_talerid_provider.sql
-- уже показал, чем оборачивается путаница «где именно менять список»: файл
-- был написан, но никогда не исполнялся, и apple выжил только благодаря
-- тому, что этот DO-блок переутверждает констрейнт на каждом старте.
--
-- Блок оставлен (и обновлён до полного списка) на случай восстановления БД
-- из бэкапа, снятого до появления telegram/apple, — тогда именно он первым
-- вернёт констрейнт к жизни, ещё до того как отработает 003.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_identities'::regclass
      AND conname  = 'user_identities_provider_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%telegram%'
  ) THEN
    ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check;
    ALTER TABLE user_identities ADD  CONSTRAINT user_identities_provider_check
      CHECK (provider IN ('phone','email','google','yandex','talerid','apple','telegram'));
  END IF;
END $$;

ALTER TABLE user_id ADD COLUMN IF NOT EXISTS password_hash    text;
ALTER TABLE user_id ADD COLUMN IF NOT EXISTS signup_method    text;
ALTER TABLE user_id ADD COLUMN IF NOT EXISTS welcome_bonus_at timestamptz;

-- Backfill: existing users считаем что бонус уже получили
UPDATE user_id SET welcome_bonus_at = create_date WHERE welcome_bonus_at IS NULL;

-- Backfill: existing users (с непустым internal_id) получают phone-identity
INSERT INTO user_identities (user_id, provider, provider_sub, email_verified)
SELECT internal_id, 'phone', internal_id, false
FROM user_id
WHERE internal_id IS NOT NULL AND internal_id != ''
ON CONFLICT (provider, provider_sub) DO NOTHING;

-- Refresh-токен Apple. Хранится ради одного действия — отзыва доступа при
-- удалении аккаунта: Apple требует его от каждого приложения с входом через
-- Apple, а отозвать по identityToken нельзя, только по refresh или access.
--
-- Заполняется единственный раз, при первом входе: authorizationCode Apple
-- отдаёт вместе с identityToken, и обменять его можно ровно однажды.
ALTER TABLE user_identities ADD COLUMN IF NOT EXISTS provider_refresh_token text;

COMMIT;
