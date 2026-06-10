-- 001_tg_bot_schema.sql
-- Telegram bot integration: identities, configs, claim tokens, message history.
-- linkeon_user_id / owner_user_id = text (телефон-строка, как в smm_campaign, tasks,
-- custom_agents — НЕ uuid).

-- 1. Привязка Telegram-аккаунта к Linkeon-пользователю (1:1)
CREATE TABLE IF NOT EXISTS tg_user_identities (
  linkeon_user_id  text PRIMARY KEY,
  tg_user_id       bigint UNIQUE NOT NULL,
  tg_username      text,
  tg_first_name    text,
  bound_at         timestamptz NOT NULL DEFAULT now()
);

-- 2. Конфигурация бота для группы (1 group ↔ 1 active config)
CREATE TABLE IF NOT EXISTS tg_bot_configs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id            text NOT NULL,
  tg_chat_id               bigint,
  tg_chat_title            text,
  display_name             text NOT NULL,
  preset_agent_id          text,
  custom_agent_id          uuid,
  addressing_mode          text NOT NULL CHECK (addressing_mode IN ('strict','always','smart')),
  voice_reply_mode         text NOT NULL CHECK (voice_reply_mode IN ('never','mirror','always')),
  status                   text NOT NULL CHECK (status IN ('pending','active','silent','archived','deleted')),
  last_low_balance_dm_at   timestamptz,
  last_zero_balance_msg_at timestamptz,
  last_reply_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  archived_at              timestamptz,
  CHECK (preset_agent_id IS NOT NULL OR custom_agent_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tg_bot_configs_active_chat
  ON tg_bot_configs (tg_chat_id) WHERE status IN ('active','silent');
CREATE INDEX IF NOT EXISTS idx_tg_bot_configs_owner_status
  ON tg_bot_configs (owner_user_id, status);

-- 3. Одноразовые токены onboarding-флоу
CREATE TABLE IF NOT EXISTS tg_claim_tokens (
  token         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('auth','claim')),
  owner_user_id text NOT NULL,
  config_id     uuid,
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS idx_tg_claim_tokens_pending
  ON tg_claim_tokens (expires_at) WHERE consumed_at IS NULL;

-- 4. История сообщений
CREATE TABLE IF NOT EXISTS tg_bot_messages (
  id             bigserial PRIMARY KEY,
  config_id      uuid NOT NULL REFERENCES tg_bot_configs(id) ON DELETE CASCADE,
  tg_chat_id     bigint NOT NULL,
  tg_message_id  bigint,
  tg_user_id     bigint,
  tg_user_name   text,
  role           text NOT NULL CHECK (role IN ('user','assistant','system')),
  content        text NOT NULL,
  content_type   text NOT NULL CHECK (content_type IN ('text','voice_transcript','voice_reply')),
  tokens_charged int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tg_bot_messages_config
  ON tg_bot_messages (config_id, created_at DESC);
