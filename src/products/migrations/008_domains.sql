-- Свой домен продукта.
-- Дизайн: spirits_front/docs/superpowers/specs/2026-09-24-linkeon-products-custom-domain-design.md
--
-- ФАЙЛ ОБЯЗАТЕЛЬНЫЙ (FATAL_MIGRATIONS, products.service.ts) — превентивно, до
-- того как в модуле появится код, который реально читает эту таблицу: её
-- станут читать выдача заданий агенту (claimJob, задания ЛЮБОГО вида, не
-- только 'domain') и выборка продуктов кабинета (COLUMNS). Молча не
-- применившаяся 008 в тот момент — это 42P01 на каждом опросе агента (ни
-- одного заведения, ни одного сна, ни одного пробуждения) и 500 на списке
-- кабинета; deploy.sh jest не гоняет, а прод-smoke продукты не трогает вовсе,
-- то есть такой отказ проехал бы зелёными test и smoke и уронил бы модуль
-- продуктов на проде молча. Подробности цены обязательности и гонки
-- PM2-кластера на первом выкате — в products.service.ts у FATAL_MIGRATIONS.
--
-- ИМЕННО ПОЭТОМУ в файле нет ни одного ADD CONSTRAINT / ALTER TABLE: у
-- ОБЯЗАТЕЛЬНОЙ миграции перевешиваемый на каждом старте именованный словарь —
-- это забытый в другом файле будущий вид задания, роняющий старт всего API
-- (тот же принцип, что у 005 с её инлайновым словарём audience — см. «словарь
-- аудитории ИНЛАЙНОВЫЙ…» в products.migration.spec.ts). Здесь только
-- CREATE ... IF NOT EXISTS — на уже накатанной базе чистый no-op, и цена
-- обязательности близка к нулю той же логикой, что у 006.
--
-- ПРАВКА ТЕЛА CREATE TABLE НИЖЕ ПОСЛЕ ПЕРВОГО ВЫКАТА НИ ДО ОДНОЙ БАЗЫ НЕ
-- ДОЕДЕТ: IF NOT EXISTS проверяет только имя таблицы, а не её форму. Новая
-- колонка или новое ограничение — это отдельная следующая миграция (ALTER
-- TABLE), а не правка этого файла задним числом.
--
-- ОДНА СТРОКА НА ПРОДУКТ: первичный ключ по product_id и есть правило «один
-- свой домен на продукт». Отдельная таблица, а не колонки products, — у домена
-- свои состояния, свой разовый код и своя уникальность, и всё это не касается
-- ни одного другого места, читающего products.
--
-- Состояния: awaiting_dns → issuing → active; failed — отказ Let's Encrypt,
-- агента или снятое задание; removing — отвязка поставлена агенту. Словарь
-- состояний инлайновый, как и оба инварианта ниже: CREATE TABLE исполняется
-- ровно один раз (страж именованных словарей в products.migration.spec.ts
-- инлайновые намеренно не видит, а в файле, где запрещён ADD CONSTRAINT,
-- другого способа их выразить и нет).
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

  -- Индекс занятости ниже (product_domains_occupied) сравнивает БАЙТЫ домена,
  -- а «то же имя, записанное иначе» — это не только регистр: точка на конце
  -- (FQDN-нотация) и юникод-домен против его punycode-формы дают РАЗНУЮ
  -- строку для одного и того же DNS-имени, а lower() ни то, ни другое не
  -- лечит и вдобавок зависит от LC_CTYPE базы. Вместо нормализации — закрытая
  -- форма: ASCII-метки из строчных латинских букв, цифр и дефиса, минимум две
  -- через точку, без точки в конце. Юникод-домен обязан приезжать уже в
  -- punycode — это дело вызывающего кода, не миграции.
  CONSTRAINT product_domains_domain_form CHECK (domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),

  -- Сертификат Let's Encrypt выпускается на names, а агент машины понимает
  -- НАМЕРЕНИЕ задания 'domain' по этому массиву, а не по статусу: пустой '{}'
  -- в issuing — отвязка (снять домен с продукта), непустой — привязка
  -- (выпустить и приладить). Форма закрыта здесь: только голый корень или
  -- корень плюс 'www.' + корень, и первый элемент обязан совпадать с domain —
  -- иначе агент, доверяющий names[1] как имени для выпуска, привяжет продукту
  -- чужой домен.
  --
  -- IS NOT DISTINCT FROM, а не `=`: у CHECK НЕИЗВЕСТНО (NULL) — это проход, а
  -- не отказ, и `=` с NULL-элементом всегда даёт NULL. NULL-элемент — это не
  -- только явный '{a.ru,NULL}': то же NULL отдаёт names[1] на '{{a.ru}}'
  -- (двумерный массив — одного индекса ему не хватает) и на '[2:2]={a.ru}'
  -- (нижняя граница не 1 — индекс 1 вне диапазона), а cardinality() в обоих
  -- случаях остаётся в пределах 1..2 и не спасает.
  CONSTRAINT product_domains_names_shape CHECK (
    cardinality(names) BETWEEN 1 AND 2
    AND names[1] IS NOT DISTINCT FROM domain
    AND (cardinality(names) = 1 OR names[2] IS NOT DISTINCT FROM 'www.' || domain)
  )
);

-- Уникальность ТОЛЬКО среди занятых доменов. Заявок в awaiting_dns на один
-- домен может быть сколько угодно, у каждой свой код: домен достаётся той,
-- чей TXT первым появится в DNS. Переход в issuing — одним оператором, и
-- этот индекс не пускает туда вторую заявку. Так нельзя ни забронировать
-- чужой домен впрок, ни перехватить работающий.
CREATE UNIQUE INDEX IF NOT EXISTS product_domains_occupied
  ON product_domains (domain) WHERE status IN ('issuing','active','removing');
