-- 001_identity_init.sql
BEGIN;

CREATE TABLE IF NOT EXISTS user_identities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text NOT NULL REFERENCES user_id(internal_id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('phone','email','google','yandex','talerid','apple')),
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
-- и только если он ещё не знает про самый новый провайдер. Файл прогоняется
-- при каждом старте сервиса, так что блок обязан быть идемпотентным.
--
-- ВНИМАНИЕ: расширять список провайдеров нужно ИМЕННО ЗДЕСЬ. Отдельные файлы
-- 002_*.sql и далее в этом каталоге НЕ ИСПОЛНЯЮТСЯ: onModuleInit в
-- identity.service.ts читает только 001. Новый файл миграции выглядел бы
-- рабочим и молча ничего не делал.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'user_identities'::regclass
      AND conname  = 'user_identities_provider_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%apple%'
  ) THEN
    ALTER TABLE user_identities DROP CONSTRAINT user_identities_provider_check;
    ALTER TABLE user_identities ADD  CONSTRAINT user_identities_provider_check
      CHECK (provider IN ('phone','email','google','yandex','talerid','apple'));
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

COMMIT;
