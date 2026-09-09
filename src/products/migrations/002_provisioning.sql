-- 002_provisioning.sql
-- Автопровижининг продуктов: форма продукта, выбранный порт, секреты и
-- очередь заданий заведения.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-07-linkeon-products-hosting-design.md

-- Форма продукта: от неё зависит, публикуется ли порт и заводится ли vhost.
-- DEFAULT 'site' нужен ради существующих строк: demo и shop2 заведены до
-- появления колонки и являются сайтами.
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'site';
DO $$ BEGIN
  ALTER TABLE products ADD CONSTRAINT products_kind_chk CHECK (kind IN ('site','bot'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Порт выбирает агент хоста: только он знает занятые. У бота пуст.
ALTER TABLE products ADD COLUMN IF NOT EXISTS port int;

-- Секреты продукта под AES-256-GCM. bytea, а не text: внутри iv, тег и
-- шифротекст одним значением.
ALTER TABLE products ADD COLUMN IF NOT EXISTS secrets_encrypted bytea;

-- Причина последнего сорванного заведения. Переживает повтор, поэтому не
-- очищается автоматически — только перезаписывается следующей попыткой.
ALTER TABLE products ADD COLUMN IF NOT EXISTS provision_error text;

CREATE TABLE IF NOT EXISTS product_provision_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  phase text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

-- Одно активное задание на продукт — тем же приёмом, что замок на ходы.
-- Без него двойное нажатие кнопки «повторить» запустило бы два развёртывания
-- в один каталог.
CREATE UNIQUE INDEX IF NOT EXISTS product_provision_jobs_one_active
  ON product_provision_jobs (product_id) WHERE status IN ('queued','running');
