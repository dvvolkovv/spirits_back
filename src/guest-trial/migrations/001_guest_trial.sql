-- Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
-- Катится при КАЖДОМ старте API (GuestTrialStore.onModuleInit), поэтому файл —
-- один DO: advisory-лок разводит одновременные старты, индексы создаются только
-- если их нет (голый CREATE INDEX IF NOT EXISTS на PG 16 берёт ShareLock на
-- таблицу даже при готовом индексе — см. tokens/002).
DO $guest_trial$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('guest-trial/001'));
  PERFORM set_config('lock_timeout', '5s', true);

  CREATE TABLE IF NOT EXISTS guest_trial_sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- sha256 ключа гостя; сам ключ живёт только в браузере.
    token_hash      text NOT NULL UNIQUE,
    assistant_id    int  NOT NULL,
    lang            text NOT NULL,
    answers         int  NOT NULL DEFAULT 0,
    -- метка привлечения, формат как у ai_profiles_consolidated.signup_source
    source          text,
    campaign        text,
    cost_usd        numeric(10,4) NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_message_at timestamptz NOT NULL DEFAULT now(),
    -- sha256 от userId, а не сам userId: у телефонных аккаунтов userId — номер.
    claimed_by_hash text,
    claimed_at      timestamptz
  );

  CREATE TABLE IF NOT EXISTS guest_trial_messages (
    id          bigserial PRIMARY KEY,
    session_id  uuid NOT NULL REFERENCES guest_trial_sessions(id) ON DELETE CASCADE,
    sender_type varchar(10) NOT NULL CHECK (sender_type IN ('human', 'ai')),
    content     text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );

  -- Режим и лимиты: в базе, а не в .env — файлы на сервере руками не правим.
  -- Ключи: 'mode' ("off" | "preview" | "on"), 'limits' (объект GuestLimits).
  CREATE TABLE IF NOT EXISTS guest_trial_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  IF to_regclass('public.idx_guest_trial_sessions_created') IS NULL THEN
    CREATE INDEX idx_guest_trial_sessions_created ON guest_trial_sessions (created_at);
  END IF;
  IF to_regclass('public.idx_guest_trial_sessions_open') IS NULL THEN
    CREATE INDEX idx_guest_trial_sessions_open ON guest_trial_sessions (last_message_at) WHERE claimed_at IS NULL;
  END IF;
  IF to_regclass('public.idx_guest_trial_messages_session') IS NULL THEN
    CREATE INDEX idx_guest_trial_messages_session ON guest_trial_messages (session_id, id);
  END IF;
END
$guest_trial$;
