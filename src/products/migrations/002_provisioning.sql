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
-- ВАЖНО: словарь перечислен ЦЕЛИКОМ, все семь значений. См.
-- identity/migrations/003_telegram_provider.sql: там дописывание одного
-- значения уже потеряло 'apple' и сломало вход.
--
-- 'sleeping' заводит МИГРАЦИЯ 004, а стоит он здесь. Это не забытая строка и не
-- опережение: модуль накатывает ВЕСЬ список при каждом старте API, и ЭТОТ файл
-- едет первым — то есть навешивает свой словарь на живые данные заново, уже
-- после того, как 004 научила продукты засыпать. Словарь `уже` живых данных —
-- это ADD CONSTRAINT, падающий на существующей строке: весь файл (простой
-- протокол = неявная транзакция) откатывается, applyMigration ловит отказ,
-- пишет строку в лог и едет дальше. 002 становится мёртвой — молча, навсегда и
-- вместе со всем, что в неё когда-нибудь допишут. Схема при этом выглядит
-- исправной: её доводит до ума 004, идущая следом.
--
-- Измерено исполнением на PostgreSQL 16: продукт в 'sleeping' + повторная
-- накатка 002 = `check constraint "products_status_check" of relation
-- "products" is violated by some row`. Сторожат сценарий 20д
-- (provisioning.integration.spec.ts) и «один именованный словарь — один состав
-- во ВСЕХ миграциях» (products.migration.spec.ts).
--
-- ОТСЮДА ПРАВИЛО для следующих миграций: значение, дописанное в словарь
-- поздним файлом, дописывается И во все ранние файлы, где тот же ИМЕНОВАННЫЙ
-- словарь объявлен заново. Инлайновых CHECK из CREATE TABLE это не касается —
-- CREATE TABLE стоит под IF NOT EXISTS и на живой базе не исполняется вовсе
-- (потому словарь статусов в 001 и остался пятизначным).
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_status_check;
ALTER TABLE products ADD CONSTRAINT products_status_check
  CHECK (status IN ('provisioning','running','degraded','stopped','archived','failed','sleeping'));

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
