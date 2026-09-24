-- Свой домен продукта.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-24-linkeon-products-custom-domain-design.md
--
-- ОДНА СТРОКА НА ПРОДУКТ: первичный ключ по product_id и есть правило «один
-- свой домен на продукт». Отдельная таблица, а не колонки products, — у домена
-- свои состояния, свой разовый код и своя уникальность, и всё это не касается
-- ни одного другого места, читающего products.
--
-- Состояния: awaiting_dns → issuing → active; failed — отказ Let's Encrypt,
-- агента или снятое задание; removing — отвязка поставлена агенту. Словарь
-- инлайновый: таблица новая, и CREATE TABLE ниже исполняется ровно один раз
-- (страж именованных словарей в products.migration.spec.ts инлайновые
-- намеренно не видит).
--
-- check_result, а не check: check — зарезервированное слово SQL.
CREATE TABLE IF NOT EXISTS product_domains (
  product_id     uuid PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  domain         text NOT NULL,
  names          text[] NOT NULL,
  token          text NOT NULL,
  status         text NOT NULL DEFAULT 'awaiting_dns'
                 CHECK (status IN ('awaiting_dns','issuing','active','failed','removing')),
  error          text,
  check_result   jsonb,
  checked_at     timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  attempts_since timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  activated_at   timestamptz
);

-- Уникальность ТОЛЬКО среди занятых доменов. Заявок в awaiting_dns на один
-- домен может быть сколько угодно, у каждой свой код: домен достаётся той,
-- чей TXT первым появится в DNS. Переход в issuing — одним оператором, и
-- этот индекс не пускает туда вторую заявку. Так нельзя ни забронировать
-- чужой домен впрок, ни перехватить работающий.
CREATE UNIQUE INDEX IF NOT EXISTS product_domains_occupied
  ON product_domains (domain) WHERE status IN ('issuing','active','removing');

-- Вид задания 'domain'. Тот же именованный словарь объявлен в 004_rent.sql,
-- и составы ОБЯЗАНЫ совпадать: модуль накатывает весь список при каждом
-- старте, и 004 со старым словарём падала бы на первом же задании 'domain' —
-- молча, applyMigration ловит отказ. Страж — products.migration.spec.ts.
ALTER TABLE product_provision_jobs DROP CONSTRAINT IF EXISTS product_provision_jobs_kind_check;
ALTER TABLE product_provision_jobs ADD CONSTRAINT product_provision_jobs_kind_check
  CHECK (kind IN ('provision','sleep','wake','domain'));
