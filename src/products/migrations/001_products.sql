-- 001_products.sql
-- Реестр клиентских продуктов, которые Linkeon хостит, и история ходов
-- живущего внутри каждого продукта агента.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-07-linkeon-products-hosting-design.md

CREATE TABLE IF NOT EXISTS products (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- text, не varchar: у OAuth/email-пользователей это UUID на 36 символов,
  -- а не телефон. См. custom-agents/migrations/002.
  user_id            text NOT NULL,
  name               text NOT NULL,
  slug               text NOT NULL UNIQUE,
  -- Без DEFAULT: дефолт 'running' объявлял бы продукт живым до подтверждения
  -- провижининга. Скрипт заведения продукта передаёт статус явно.
  status             text NOT NULL
                       CHECK (status IN ('provisioning','running','degraded','stopped','archived')),
  host_ip            inet,
  domain             text,
  repo_url           text,
  checkout_path      text NOT NULL,
  build_cmd          text,
  restart_cmd        text,
  health_url         text,
  -- UNIQUE, не просто индекс: RunnerGuard бьёт сюда SELECT на каждый
  -- long-poll (а он крутится непрерывно на каждый продукт). Без уникальности
  -- совпадение хеша давало бы guard-у произвольную строку — и чужой
  -- checkout_path в придачу.
  runner_token_hash  text NOT NULL UNIQUE,
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
  -- Словарь закреплён так же, как у status: TS-тип 'web' | 'telegram' не
  -- переживает границу рантайма, а значение приходит из контроллера.
  channel      text NOT NULL CHECK (channel IN ('web', 'telegram')),
  prompt       text NOT NULL,
  result       text,
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','running','done','failed','reverted')),
  sha_before   text,
  sha_after    text,
  tokens_spent bigint NOT NULL DEFAULT 0 CHECK (tokens_spent >= 0),
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
--
-- Корректность целиком держится на словаре статусов выше: строка со статусом
-- вне ('queued','running') выпадает из предиката индекса, и продукт считается
-- свободным. CHECK на product_turns.status — не декорация, а часть этой
-- гарантии.
--
-- Это мьютекс, а не очередь: пока идёт ход, второй запрос отбивается 409
-- («Агент уже работает над предыдущим запросом»), а не встаёт в ожидание.
-- Не наращивай поверх этого предиката логику постановки в очередь.
CREATE UNIQUE INDEX IF NOT EXISTS product_turns_one_active
  ON product_turns (product_id)
  WHERE status IN ('queued', 'running');
