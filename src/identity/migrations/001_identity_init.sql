-- 001_identity_init.sql
BEGIN;

CREATE TABLE IF NOT EXISTS user_identities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        text NOT NULL REFERENCES user_id(internal_id) ON DELETE CASCADE,
  provider       text NOT NULL CHECK (provider IN ('phone','email','google','yandex')),
  provider_sub   text NOT NULL,
  email          text,
  email_verified boolean NOT NULL DEFAULT false,
  created_at     timestamptz DEFAULT now(),
  last_used_at   timestamptz,
  UNIQUE(provider, provider_sub)
);
CREATE INDEX IF NOT EXISTS idx_user_identities_user ON user_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_user_identities_email_verified ON user_identities(email) WHERE email_verified;

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
