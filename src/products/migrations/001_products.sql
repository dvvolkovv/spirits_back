-- 001_products.sql
-- Реестр клиентских продуктов, которые Linkeon хостит, и история ходов
-- живущего внутри каждого продукта агента.

CREATE TABLE IF NOT EXISTS products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- text, не varchar: у OAuth/email-пользователей это UUID на 36 символов,
  -- а не телефон. См. custom-agents/migrations/002.
  user_id            text NOT NULL,
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'running',
  host_ip            inet,
  domain             text,
  repo_url           text,
  checkout_path      text NOT NULL,
  build_cmd          text,
  restart_cmd        text,
  health_url         text,
  runner_token_hash  text NOT NULL,
  runner_seen_at     timestamptz,
  claude_session_id  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  archived_at        timestamptz
);

CREATE INDEX IF NOT EXISTS idx_products_user
  ON products (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_turns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id      text NOT NULL,
  channel      text NOT NULL,
  prompt       text NOT NULL,
  result       text,
  status       text NOT NULL DEFAULT 'queued',
  sha_before   text,
  sha_after    text,
  tokens_spent bigint NOT NULL DEFAULT 0,
  error        text,
  started_at   timestamptz,
  finished_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_turns_product
  ON product_turns (product_id, created_at DESC);

-- Замок: один продукт = один активный ход. Два параллельных claude -p в одном
-- чекауте передерутся за файлы и оставят его в состоянии, не соответствующем
-- ни одному коммиту. Гарантию даёт база, а не аккуратность вызывающего кода.
CREATE UNIQUE INDEX IF NOT EXISTS product_turns_one_active
  ON product_turns (product_id)
  WHERE status IN ('queued', 'running');
