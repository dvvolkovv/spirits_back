-- 009_product_actions.sql
-- Ассистент ведёт продукт целиком. Спека:
-- docs/superpowers/specs/2026-10-25-product-full-lifecycle-design.md.
-- Катится на каждом старте вместе со всем списком MIGRATIONS, идемпотентно.
--
-- ПРАВКА ТЕЛА CREATE TABLE НИЖЕ (колонки, словари CHECK) ПОСЛЕ ПЕРВОГО
-- ВЫКАТА НИ ДО ОДНОЙ БАЗЫ НЕ ДОЕДЕТ: IF NOT EXISTS проверяет только имя
-- таблицы, а не её форму. Новое значение словаря (kind/status/channel/
-- confirmed_via), новая колонка или новое ограничение — это отдельная
-- следующая миграция (ALTER TABLE ... DROP/ADD CONSTRAINT или ADD COLUMN),
-- а не правка этого файла задним числом.
--
-- Лок ниже — только вокруг ЭТОЙ миграции: защищает её CREATE TABLE от гонки
-- двух параллельных первых стартов PM2-кластера (та же гонка, что у 005/006/
-- 008 на первом выкате — см. FATAL_MIGRATIONS в products.service.ts).
-- Системный лок вокруг ВСЕЙ накатки миграций — отдельная задача, как и
-- отмечено там же, а не точечная правка этой строки.
SELECT pg_advisory_xact_lock(hashtext('products/009_product_actions'));

-- Мягкое удаление. archived_at уже есть — по нему считают место в пределе и
-- аренду. purge_after — до какого момента продукт можно вернуть; purged_at —
-- когда стёрт насовсем (очередь 2).
ALTER TABLE products ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS purged_at timestamptz;
-- Идентификатор бота Telegram — не секрет. Два живых продукта на одном токене
-- отнимают друг у друга обновления.
ALTER TABLE products ADD COLUMN IF NOT EXISTS tg_bot_id bigint;
-- Первая правка, переданная при создании: ставится, как только продукт поднялся.
ALTER TABLE products ADD COLUMN IF NOT EXISTS first_prompt text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS first_prompt_channel text;

-- Ожидающие действия (карточки) и журнал жизненного цикла. Значений ключей
-- здесь нет: в payload — только имена, secrets_box — шифротекст до конца
-- задания (очередь 2). Словари — встроенными CHECK, а не ADD CONSTRAINT:
-- сторож products.migration.spec ведёт учёт именованных словарей продуктов.
CREATE TABLE IF NOT EXISTS product_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       text NOT NULL,
  -- SET NULL, а не CASCADE, как у других дочерних таблиц продукта
  -- (product_turns, product_domains): это журнал, который обязан пережить
  -- запись products, а не исчезнуть вместе с ней. Продукт обычно НЕ удаляют
  -- физически — только архивируют (archived_at) и, в очереди 2, помечают на
  -- стирание (purge_after/purged_at), так что на практике строка products
  -- никуда не девается; но если она всё же пропадёт, действие должно
  -- остаться с отвязанным product_id, а не пропасть из журнала молча.
  product_id    uuid REFERENCES products(id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN ('create_site','create_bot','keys','delete','restore','revert','purge')),
  status        text NOT NULL CHECK (status IN ('pending','working','done','failed','expired','cancelled')),
  channel       text NOT NULL CHECK (channel IN ('web','telegram','system')),
  confirmed_via text CHECK (confirmed_via IN ('chat','telegram','tma','cabinet')),
  turn_nonce    text,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets_box   bytea,
  result        jsonb,
  attached_at   timestamptz,
  tg_chat_id    bigint,
  tg_message_id bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  resolved_at   timestamptz
);

-- Индексы — только если их нет: CREATE INDEX IF NOT EXISTS на каждом старте
-- берёт ShareLock на таблицу даже при существующем индексе.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_product_actions_user_pending') THEN
    CREATE INDEX idx_product_actions_user_pending ON product_actions (user_id, created_at) WHERE status = 'pending';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_products_purge_after') THEN
    CREATE INDEX idx_products_purge_after ON products (purge_after) WHERE archived_at IS NOT NULL AND purged_at IS NULL;
  END IF;
END $$;
