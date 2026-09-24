-- Свой домен продукта.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-24-linkeon-products-custom-domain-design.md
--
-- ФАЙЛ ОБЯЗАТЕЛЬНЫЙ (FATAL_MIGRATIONS, products.service.ts) — превентивно, до
-- того как в модуле появится код, который реально читает эту таблицу. С Task 6
-- плана её станет читать claimJob при выдаче задания ЛЮБОГО вида любому
-- продукту, не только 'domain', а с Task 8 — список продуктов кабинета. Молча
-- не применившаяся 008 в тот момент — это 42P01 на каждом опросе агента (ни
-- одного заведения, ни одного сна, ни одного пробуждения) и 500 на списке
-- кабинета; deploy.sh jest не гоняет, а прод-smoke продукты не трогает вовсе,
-- то есть такой отказ проехал бы зелёными test и smoke и уронил бы модуль
-- продуктов на проде молча.
--
-- ИМЕННО ПОЭТОМУ в файле нет ни одного ADD CONSTRAINT / ALTER TABLE: у
-- ОБЯЗАТЕЛЬНОЙ миграции перевешиваемый на каждом старте именованный словарь —
-- это забытый в другом файле будущий вид задания, роняющий старт всего API
-- (тот же принцип, что у 005 с её инлайновым словарём audience — см. «словарь
-- аудитории ИНЛАЙНОВЫЙ…» в products.migration.spec.ts). Здесь только
-- CREATE ... IF NOT EXISTS — на уже накатанной базе чистый no-op, и цена
-- обязательности близка к нулю той же логикой, что у 006.
--
-- ОДНА СТРОКА НА ПРОДУКТ: первичный ключ по product_id и есть правило «один
-- свой домен на продукт». Отдельная таблица, а не колонки products, — у домена
-- свои состояния, свой разовый код и своя уникальность, и всё это не касается
-- ни одного другого места, читающего products.
--
-- Состояния: awaiting_dns → issuing → active; failed — отказ Let's Encrypt,
-- агента или снятое задание; removing — отвязка поставлена агенту. Словарь
-- состояний инлайновый, как и оба инварианта имени ниже: CREATE TABLE
-- исполняется ровно один раз (страж именованных словарей в
-- products.migration.spec.ts инлайновые намеренно не видит, а в файле, где
-- запрещён ADD CONSTRAINT, другого способа их выразить и нет).
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
  activated_at   timestamptz,

  -- Индекс занятости ниже (product_domains_occupied) сравнивает БАЙТЫ домена.
  -- Код, вставивший 'A.ru' вместо 'a.ru', обошёл бы замок — для индекса это
  -- другая строка, хотя DNS и Let's Encrypt регистр не различают.
  CONSTRAINT product_domains_domain_lower CHECK (domain = lower(domain)),

  -- Сертификат Let's Encrypt выпускается на names, а агент машины понимает
  -- НАМЕРЕНИЕ задания 'domain' по этому массиву, а не по статусу: пустой '{}'
  -- в issuing — отвязка (снять домен с продукта), непустой — привязка
  -- (выпустить и приладить). Форма закрыта здесь: только голый корень или
  -- корень плюс 'www.' + корень, и первый элемент обязан совпадать с domain —
  -- иначе агент, доверяющий names[1] как имени для выпуска, привяжет продукту
  -- чужой домен.
  CONSTRAINT product_domains_names_shape CHECK (
    cardinality(names) BETWEEN 1 AND 2
    AND names[1] = domain
    AND (cardinality(names) = 1 OR names[2] = 'www.' || domain)
  )
);

-- Уникальность ТОЛЬКО среди занятых доменов. Заявок в awaiting_dns на один
-- домен может быть сколько угодно, у каждой свой код: домен достаётся той,
-- чей TXT первым появится в DNS. Переход в issuing — одним оператором, и
-- этот индекс не пускает туда вторую заявку. Так нельзя ни забронировать
-- чужой домен впрок, ни перехватить работающий.
CREATE UNIQUE INDEX IF NOT EXISTS product_domains_occupied
  ON product_domains (domain) WHERE status IN ('issuing','active','removing');
