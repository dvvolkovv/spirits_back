-- Проба ассистента без регистрации (spec 2026-10-30-guest-trial-design.md).
-- Катится при КАЖДОМ старте API (GuestTrialStore.onModuleInit), поэтому файл —
-- один DO: advisory-лок разводит одновременные старты, индексы создаются только
-- если их нет (голый CREATE INDEX IF NOT EXISTS на PG 16 берёт ShareLock на
-- таблицу даже при готовом индексе — см. tokens/002).
--
-- ОТКАТ:
--   Быстрый — режим 'off' (админ-ручка или прямой UPDATE guest_trial_settings
--   по key='mode'): пробу выключает немедленно, таблицы и данные остаются.
--   Полный — DROP TABLE, и только ПОСЛЕ того, как GuestTrialModule убран из
--   app.module.ts: иначе следующий старт API создаст таблицы заново.
--     DROP TABLE guest_trial_messages;
--     DROP TABLE guest_trial_sessions;
--     DROP TABLE guest_trial_settings;
--
-- ⚠️ Для будущих 002+: ALTER TABLE … ADD COLUMN IF NOT EXISTS берёт
-- ACCESS EXCLUSIVE на таблицу на КАЖДОМ старте, даже когда колонка уже есть —
-- в отличие от CREATE TABLE IF NOT EXISTS это не бесплатный no-op. Добавлять
-- колонку только через проверку каталога (information_schema.columns или
-- pg_attribute — to_regclass резолвит имя ОТНОШЕНИЯ, для колонки не подходит)
-- внутри DO.
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
    -- хеш нужен только около входа (повторный перенос тем же человеком);
    -- уборка обнуляет его через 7 дней после переноса.
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
  -- Ключи: 'mode' ("off" | "preview" | "on"), 'limits' (только переопределения
  -- поверх умолчаний кода — DEFAULT_GUEST_LIMITS, а не полный объект GuestLimits).
  CREATE TABLE IF NOT EXISTS guest_trial_settings (
    key        text PRIMARY KEY,
    value      jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- Только индекс сообщений сессии: статистика по sessions — агрегат без
  -- WHERE, а уборка открытых проб фильтрует OR по двум колонкам (ни created_at,
  -- ни last_message_at отдельным индексом её не ускорят).
  IF to_regclass('public.idx_guest_trial_messages_session') IS NULL THEN
    CREATE INDEX idx_guest_trial_messages_session ON guest_trial_messages (session_id, id);
  END IF;
END
$guest_trial$;
