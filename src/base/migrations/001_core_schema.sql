-- 001_core_schema.sql
-- Core database schema for Linkeon backend.
-- Creates fundamental tables that exist on prod but have no prior migration.
-- Idempotent (all CREATE ... IF NOT EXISTS).

-- Enums -----------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE transaction_type_enum AS ENUM (
    'purchase', 'consumed', 'bonus', 'refund', 'adjustment', 'coupon'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status_enum AS ENUM (
    'pending', 'succeeded', 'canceled', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE task_status_enum AS ENUM (
    'pending', 'processing', 'completed', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Users -----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_id (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_phone text,
  primary_email text,
  contacts      json,
  create_date   timestamp without time zone DEFAULT now(),
  update_date   timestamp without time zone DEFAULT now(),
  state         text,
  internal_id   character varying NOT NULL,
  UNIQUE (internal_id)
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id                     uuid DEFAULT gen_random_uuid(),
  telegram_username      text,
  location_city          text,
  intents                json,
  available_destinations json,
  location_city_code     integer
);

-- Agents ----------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agents (
  id            serial PRIMARY KEY,
  name          text,
  system_prompt text,
  description   text,
  category      character varying DEFAULT 'business',
  display_name  text
);

-- Chat history ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_history (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_user  character varying,
  to_user    character varying,
  created_at timestamp with time zone DEFAULT now(),
  text       character varying
);

CREATE TABLE IF NOT EXISTS custom_chat_history (
  id           serial PRIMARY KEY,
  session_id   text NOT NULL,
  sender_type  character varying NOT NULL,
  agent        integer,
  content      text NOT NULL,
  created_at   timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  message_type character varying NOT NULL DEFAULT 'text',
  tokens_used  integer DEFAULT 0
);

CREATE TABLE IF NOT EXISTS realtime_chat_history (
  id         serial PRIMARY KEY,
  session_id character varying NOT NULL,
  message    jsonb NOT NULL
);

-- Tokens & payments -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_transactions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          text NOT NULL,
  transaction_type transaction_type_enum NOT NULL,
  amount           bigint NOT NULL,
  balance_after    bigint NOT NULL,
  description      text,
  metadata         jsonb,
  created_at       timestamp with time zone DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_token_tx_user ON token_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS token_packages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL,
  name       text NOT NULL,
  tokens     bigint NOT NULL,
  price_rub  numeric NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_consumption_tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id      integer NOT NULL,
  user_id           text NOT NULL,
  status            task_status_enum NOT NULL DEFAULT 'pending',
  agent_id          integer,
  input_tokens      integer DEFAULT 0,
  output_tokens     integer DEFAULT 0,
  total_tokens      integer DEFAULT 0,
  tokens_to_consume bigint DEFAULT 0,
  error_message     text,
  metadata          jsonb,
  created_at        timestamp with time zone DEFAULT now(),
  updated_at        timestamp with time zone DEFAULT now(),
  completed_at      timestamp with time zone
);

CREATE TABLE IF NOT EXISTS payments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     text NOT NULL,
  payment_id  text NOT NULL,
  package_id  text,
  amount      numeric NOT NULL,
  tokens      bigint NOT NULL,
  status      payment_status_enum NOT NULL DEFAULT 'pending',
  payment_url text,
  created_at  timestamp with time zone DEFAULT now(),
  updated_at  timestamp with time zone DEFAULT now(),
  completed_at timestamp with time zone
);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments (payment_id);

-- Coupons ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS coupons (
  id           serial PRIMARY KEY,
  code         text NOT NULL,
  token_amount bigint NOT NULL DEFAULT 60000,
  is_active    boolean NOT NULL DEFAULT true,
  usage_count  integer DEFAULT 0,
  created_at   timestamp with time zone DEFAULT now(),
  updated_at   timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id             serial PRIMARY KEY,
  coupon_id      integer NOT NULL,
  user_id        text NOT NULL,
  redeemed_at    timestamp with time zone DEFAULT now(),
  tokens_granted bigint NOT NULL
);

-- LLM pricing -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS llm_pricing (
  id                    serial PRIMARY KEY,
  model                 character varying NOT NULL,
  completion_token_price numeric NOT NULL,
  prompt_token_price    numeric NOT NULL,
  updated_at            timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
  created_at            timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);

-- Referrals -------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_leaders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  character varying NOT NULL,
  slug                  character varying NOT NULL,
  user_phone            character varying,
  parent_leader_id      uuid,
  level                 smallint DEFAULT 1,
  commission_pct        numeric DEFAULT 10,
  parent_commission_pct numeric DEFAULT 0,
  is_active             boolean DEFAULT true,
  created_at            timestamp with time zone DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referral_leaders_slug ON referral_leaders (slug);

CREATE TABLE IF NOT EXISTS referral_referees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referee_phone  character varying NOT NULL,
  leader_id      uuid NOT NULL,
  registered_at  timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS referral_commissions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  leader_id           uuid NOT NULL,
  payment_id          character varying,
  referee_phone       character varying,
  commission_level    smallint,
  payment_amount_rub  numeric,
  commission_pct      numeric,
  commission_rub      numeric,
  paid_out            boolean DEFAULT false,
  created_at          timestamp with time zone DEFAULT now()
);

-- Game sessions ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_sessions (
  id             serial PRIMARY KEY,
  user_id        text NOT NULL,
  session_type   text NOT NULL,
  current_sphere text,
  cards_shown    jsonb DEFAULT '[]'::jsonb,
  session_state  text DEFAULT 'active',
  started_at     timestamp with time zone DEFAULT now(),
  completed_at   timestamp with time zone,
  last_activity  timestamp with time zone DEFAULT now()
);
