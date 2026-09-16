-- 002_provisioning.sql
-- Автопровижининг продуктов: форма продукта, выбранный порт, секреты и
-- очередь заданий заведения.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-07-linkeon-products-hosting-design.md

-- Форма продукта: от неё зависит, публикуется ли порт и заводится ли vhost.
-- DEFAULT 'site' нужен ради существующих строк: demo и shop2 заведены до
-- появления колонки и являются сайтами.
ALTER TABLE products ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'site';
-- DEFAULT свою работу сделал (проставил 'site' существующим demo и shop2) и
-- дальше только вредит: INSERT, забывший kind, молча заводил бы БОТА КАК САЙТ,
-- то есть выдавал бы ему vhost и публичный порт наружу. Ровно по этой причине
-- в 001 оставлен без DEFAULT status. DROP DEFAULT идемпотентен.
ALTER TABLE products ALTER COLUMN kind DROP DEFAULT;
-- DROP + ADD, а не DO/EXCEPTION duplicate_object: перехват дубля молча
-- сохраняет СТАРОЕ определение ограничения, и правка словаря в следующей
-- миграции не доедет до баз, где ограничение уже есть. Один приём на файл.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_kind_chk;
ALTER TABLE products ADD CONSTRAINT products_kind_chk CHECK (kind IN ('site','bot'));

-- Порт выбирает агент хоста: только он знает занятые. У бота пуст.
ALTER TABLE products ADD COLUMN IF NOT EXISTS port int;

-- Секреты продукта под AES-256-GCM. bytea, а не text: внутри iv, тег и
-- шифротекст одним значением.
ALTER TABLE products ADD COLUMN IF NOT EXISTS secrets_encrypted bytea;

-- Причина последнего сорванного заведения. Переживает повтор, поэтому не
-- очищается автоматически — только перезаписывается следующей попыткой.
ALTER TABLE products ADD COLUMN IF NOT EXISTS provision_error text;

-- Сорванное заведение обязано быть записуемым: обработчик ошибки делает
-- UPDATE products SET status = 'failed', provision_error = ... Словарь из 001
-- значения 'failed' не знает, поэтому запись падала бы ВНУТРИ обработчика
-- ошибки — причина не сохранилась бы, продукт навсегда остался бы в
-- 'provisioning', и повторная попытка не нашла бы его по status = 'failed'.
-- Заведение выглядело бы вечным: ни ошибки, ни строки в логе.
--
-- ВАЖНО: словарь перечислен ЦЕЛИКОМ, все шесть значений. См.
-- identity/migrations/003_telegram_provider.sql: там дописывание одного
-- значения уже потеряло 'apple' и сломало вход.
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products ADD CONSTRAINT products_status_check
  CHECK (status IN ('provisioning','running','degraded','stopped','archived','failed'));

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
