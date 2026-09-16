import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS, ProductsService } from './products.service';

function makeService() {
  const queries: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    }),
  };
  return { svc: new ProductsService(pg as any), queries };
}

describe('ProductsService.onModuleInit', () => {
  it('накатывает схему products и product_turns', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS products');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS product_turns');
  });

  it('создаёт замок «один активный ход на продукт»', async () => {
    const { svc, queries } = makeService();

    await svc.onModuleInit();

    expect(queries.join('\n')).toContain('product_turns_one_active');
  });

  it('не падает, если применение миграции бросает ошибку', async () => {
    const pg = {
      query: jest.fn(async () => {
        throw new Error('boom');
      }),
    };
    const svc = new ProductsService(pg as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});

/**
 * Текст миграции 002 отдельно от 001.
 *
 * Склейка обоих файлов для проверок непригодна: 001 содержит и
 * `ON DELETE CASCADE`, и `status text NOT NULL DEFAULT 'queued'`, и
 * `WHERE status IN ('queued', 'running')`. Проверка по склейке зеленела бы на
 * тексте 001 даже если бы 002 растеряла все свои ограничения до единого.
 */
async function migration002(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('product_provision_jobs'));
  if (!sql) {
    throw new Error('миграция 002 не применена: ни один запрос не заводит product_provision_jobs');
  }
  // Комментарии вырезаются: проверки ниже ищут подстроки, а закомментированный
  // DROP CONSTRAINT зеленил бы сторож идемпотентности, оставаясь для Postgres
  // отсутствующим. Блочные — тоже: вырезание одних строчных оставляло ту же
  // дыру уровнем выше, /* ... */ вокруг DROP DEFAULT проходил зелёным.
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Текст миграции 003 — отдельно от 001 и 002 по той же причине, по какой 002
 * отделена от 001: склейка зеленела бы на чужом тексте. `timestamptz NOT NULL`
 * и `DEFAULT now()` есть в обоих соседних файлах.
 */
async function migration003(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('product_host_agent'));
  if (!sql) {
    throw new Error('миграция 003 не применена: ни один запрос не заводит product_host_agent');
  }
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Текст миграции 004 — отдельно от соседей по той же причине, по какой отделены
 * 002 и 003. Якорь — `paid_until`: в 004 есть и `product_provision_jobs`, и
 * `products_status_check`, то есть по ним `find` подобрал бы 002, применённую
 * раньше.
 */
async function migration004(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('paid_until'));
  if (!sql) {
    throw new Error('миграция 004 не применена: ни один запрос не заводит paid_until');
  }
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Значения именованного CHECK-словаря, отсортированные: сверка получается ровно
 * про состав, а не про порядок перечисления.
 *
 * Имя ограничения в якоре обязательно: словарей по колонке status в файле два —
 * у products и у очереди заданий, — и безымянный поиск подобрал бы чужой.
 */
function dictionary(sql: string, constraint: string, column: string, where = '002'): string[] {
  const m = sql.match(
    new RegExp(`ADD CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*${column} IN \\(([^)]*)\\)`),
  );
  if (!m) throw new Error(`в миграции ${where} нет CHECK-словаря ${constraint} по колонке ${column}`);
  return m[1]
    .split(',')
    .map((v) => v.trim().replace(/'/g, ''))
    .sort();
}

/**
 * Все ИМЕНОВАННЫЕ CHECK-словари из всех файлов схемы разом: имя ограничения →
 * где объявлено и с каким составом.
 *
 * Файлы читаются с диска по MIGRATIONS, а не через makeService: проверка ниже —
 * про отношение МЕЖДУ файлами, и она обязана видеть их все, а не тот один,
 * который подобрал `find`.
 *
 * Инлайновые CHECK из `CREATE TABLE` сюда намеренно не попадают: CREATE TABLE
 * стоит под IF NOT EXISTS и на существующей базе не исполняется вовсе, поэтому
 * словарь внутри него на живые данные не навешивается. Отсюда и разница: в 001
 * словарь статусов знает пять значений и это безвредно, а в 002 тот же словарь
 * обязан быть актуальным — 002 навешивает его заново при каждом старте.
 */
function namedDictionaries(): Map<string, { file: string; values: string[] }[]> {
  const out = new Map<string, { file: string; values: string[] }[]>();
  for (const file of MIGRATIONS) {
    const sql = fs
      .readFileSync(path.join(__dirname, 'migrations', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/ADD CONSTRAINT\s+(\w+)\s+CHECK\s*\(\s*\w+ IN \(([^)]*)\)/g)) {
      const values = m[2]
        .split(',')
        .map((v) => v.trim().replace(/'/g, ''))
        .sort();
      out.set(m[1], [...(out.get(m[1]) ?? []), { file, values }]);
    }
  }
  return out;
}

describe('словари CHECK сквозь весь список миграций', () => {
  it('разбор словарей работает — иначе проверка ниже зеленела бы на пустоте', () => {
    // Сторож прибора. Регексп, переставший что-либо находить, оставил бы
    // следующий тест зелёным навсегда: цикл по пустой карте не делает ни одного
    // утверждения.
    expect([...namedDictionaries().keys()].sort()).toEqual([
      'product_provision_jobs_kind_check',
      'products_kind_chk',
      'products_status_check',
    ]);
  });

  it('один именованный словарь — один состав во ВСЕХ миграциях, где он объявлен', () => {
    // Модуль накатывает ВЕСЬ список при каждом старте API, а не только новые
    // файлы. Значит миграция, стоящая в списке раньше, навешивает свой словарь
    // на данные, которые успела завести миграция, стоящая позже. Словарь `уже`
    // живых данных — это ADD CONSTRAINT, падающий на существующей строке:
    // applyMigration ловит отказ, пишет строку в лог и едет дальше, то есть
    // ранняя миграция становится МЁРТВОЙ — молча и навсегда.
    //
    // Измерено на живом Postgres 16: продукт в 'sleeping' + повторная накатка
    // 002 = `check constraint "products_status_check" of relation "products" is
    // violated by some row`. Сценарий 20д в provisioning.integration.spec.ts
    // ловит то же самое исполнением.
    for (const [constraint, declared] of namedDictionaries()) {
      if (declared.length < 2) continue;
      const [first] = declared;
      for (const d of declared.slice(1)) {
        expect({ constraint, file: d.file, values: d.values }).toEqual({
          constraint,
          file: d.file,
          values: first.values,
        });
      }
    }
  });
});

/**
 * Проверки ниже сверяют смысл SQL, а не упоминание имён: тип и модификаторы
 * колонки, словари CHECK, предикат частичного индекса, каскад внешнего ключа.
 * Живого Postgres в прогоне нет, поэтому семантика закреплена по тексту
 * миграции — и закреплена раздельно: каждое утверждение в своём тесте, чтобы
 * снятый CHECK и снятый предикат индекса нельзя было спутать по красному.
 */
describe('миграция 002', () => {
  it('применяется вслед за 001', async () => {
    const applied: string[] = [];
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const svc = new ProductsService(pg as any);
    (svc as any).applyMigration = jest.fn(async (f: string) => void applied.push(f));

    await svc.onModuleInit();

    // Порядок важен: 002 добавляет колонки в таблицу, которую создаёт 001.
    // 003 своя таблица и ни от кого не зависит, но список файлов — это и есть
    // описание схемы: пропавший из него файл не применяется вовсе.
    //
    // Литеральный массив, а не сверка с самой константой MIGRATIONS: сверка
    // константы с собой зеленела бы при любом её содержимом, включая пустое.
    // 004 идёт ПОСЛЕ 003, хотя зависит только от 002: нумерация перескакивает
    // через 003 (он уже накачен на проде), и переставить их местами значило бы
    // завести второй порядок — по зависимостям, — который разошёлся бы с
    // номерами файлов при первой же следующей миграции.
    expect(applied).toEqual([
      '001_products.sql',
      '002_provisioning.sql',
      '003_host_agent.sql',
      '004_rent.sql',
    ]);
  });

  it('kind — обязательный текст со значением по умолчанию для старых строк', async () => {
    // int вместо text или пропавший DEFAULT сломали бы существующие demo и
    // shop2, заведённые до появления колонки.
    expect(await migration002()).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+kind\s+text\s+NOT NULL\s+DEFAULT\s+'site'/,
    );
  });

  it('DEFAULT у kind снимается сразу после заполнения старых строк', async () => {
    // Оставленный DEFAULT означает, что INSERT, забывший kind, заводит бота
    // как сайт — с публичным портом и vhost-ом наружу. Ровно поэтому в 001
    // оставлен без DEFAULT status.
    expect(await migration002()).toMatch(/ALTER COLUMN\s+kind\s+DROP DEFAULT/);
  });

  it('словарь форм продукта закрыт CHECK', async () => {
    expect(dictionary(await migration002(), 'products_kind_chk', 'kind')).toEqual(['bot', 'site']);
  });

  it('словарь статусов продукта знает failed — иначе тупик в обработчике ошибки', async () => {
    // Без 'failed' запись причины сорванного заведения падала бы ВНУТРИ
    // обработчика ошибки: продукт навсегда застревал бы в 'provisioning'.
    // Словарь сверяется целиком: identity/migrations/003 — про то, как
    // дописывание одного значения теряет остальные.
    //
    // 'sleeping' в списке 002, хотя заводит его 004: 002 едет ПЕРВОЙ при каждом
    // старте API и навешивает свой словарь на живые данные заново. Словарь `уже`
    // живых данных роняет ADD CONSTRAINT, и 002 замолкает навсегда. Подробности
    // — в самом файле 002; исполнением это ловит сценарий 20д.
    expect(dictionary(await migration002(), 'products_status_check', 'status')).toEqual([
      'archived',
      'degraded',
      'failed',
      'provisioning',
      'running',
      'sleeping',
      'stopped',
    ]);
  });

  it('каждое ограничение навешивается идемпотентно', async () => {
    // ADD CONSTRAINT не знает IF NOT EXISTS: без снятия одноимённого
    // ограничения повторный прогон миграции падал бы. DO/EXCEPTION
    // duplicate_object тут не годится — он молча сохраняет СТАРОЕ определение.
    const sql = await migration002();
    const added = [...sql.matchAll(/ADD CONSTRAINT\s+(\w+)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      // Именно DROP перед ADD, а не где-нибудь в файле: иначе снятое
      // ограничение вернулось бы позже собственной замены.
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`)).toBeLessThan(
        sql.indexOf(`ADD CONSTRAINT ${name}`),
      );
    }
  });

  it('порт — целое число и необязателен: у бота его нет', async () => {
    expect(await migration002()).toMatch(/ADD COLUMN IF NOT EXISTS\s+port\s+int\s*;/);
  });

  it('секреты хранятся как bytea под шифротекст AES-GCM', async () => {
    // text здесь означал бы перекодировку iv и тега, то есть порчу значения.
    expect(await migration002()).toMatch(/ADD COLUMN IF NOT EXISTS\s+secrets_encrypted\s+bytea\s*;/);
  });

  it('причина сорванного заведения — текстовая колонка products', async () => {
    expect(await migration002()).toMatch(/ADD COLUMN IF NOT EXISTS\s+provision_error\s+text\s*;/);
  });

  it('заводит очередь заданий', async () => {
    expect(await migration002()).toMatch(/CREATE TABLE IF NOT EXISTS\s+product_provision_jobs/);
  });

  it('задание удаляется вместе со своим продуктом', async () => {
    expect(await migration002()).toMatch(
      /product_id\s+uuid\s+NOT NULL\s+REFERENCES\s+products\s*\(\s*id\s*\)\s+ON DELETE CASCADE/,
    );
  });

  it('новое задание стартует в статусе queued', async () => {
    expect(await migration002()).toMatch(/status\s+text\s+NOT NULL\s+DEFAULT\s+'queued'/);
  });

  it('словарь статусов задания закрыт CHECK', async () => {
    // Не декорация: частичный индекс ниже считает продукт свободным при любом
    // статусе вне ('queued','running'), поэтому словарь — часть замка.
    expect(await migration002()).toMatch(
      /CHECK\s*\(\s*status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*,\s*'done'\s*,\s*'failed'\s*\)\s*\)/,
    );
  });

  it('задание несёт фазу, ошибку и отметки времени', async () => {
    const sql = await migration002();
    expect(sql).toMatch(/\bphase\s+text\b/);
    expect(sql).toMatch(/\berror\s+text\b/);
    expect(sql).toMatch(/created_at\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/);
    expect(sql).toMatch(/started_at\s+timestamptz/);
    expect(sql).toMatch(/finished_at\s+timestamptz/);
  });

  it('замок «одно активное задание» — уникальный индекс по продукту', async () => {
    expect(await migration002()).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+product_provision_jobs_one_active\s+ON product_provision_jobs\s*\(\s*product_id\s*\)/,
    );
  });

  it('замок ограничен активными статусами, а не всей историей продукта', async () => {
    // Без предиката индекс означал бы «одно задание за всю жизнь продукта»:
    // повторное заведение того же продукта навсегда отбивалось бы
    // уникальностью. Имя индекса при этом остаётся прежним.
    expect(await migration002()).toMatch(
      /product_provision_jobs_one_active[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'queued'\s*,\s*'running'\s*\)/,
    );
  });
});

describe('миграция 003 — отметка о жизни агента хоста', () => {
  it('заводит таблицу отметки', async () => {
    expect(await migration003()).toMatch(/CREATE TABLE IF NOT EXISTS\s+product_host_agent/);
  });

  it('повторный прогон миграции не падает', async () => {
    // Модуль накатывает схему на КАЖДОМ старте (onModuleInit), то есть при
    // каждом `pm2 restart`. CREATE TABLE без IF NOT EXISTS уронил бы миграцию
    // на втором запуске, а applyMigration такой отказ только пишет в лог —
    // значит следующая миграция молча поехала бы на базу в неизвестном
    // состоянии.
    expect(await migration003()).toContain('IF NOT EXISTS');
  });

  it('строка в таблице может быть только одна', async () => {
    // Ключ boolean плюс CHECK(id) — это и есть гарантия единственности:
    // читатель берёт отметку без ORDER BY и без max(). Со снятым CHECK ключ
    // пускает вторую строку с id = false, и запрос начинает брать одну из
    // двух отметок наугад — то есть иногда показывать позавчерашнюю.
    expect(await migration003()).toMatch(/id\s+boolean\s+PRIMARY KEY\s+DEFAULT\s+true\s+CHECK\s*\(\s*id\s*\)/);
  });

  it('отметка — обязательная метка времени с часовым поясом', async () => {
    // timestamp без пояса складывался бы с now() по-разному в зависимости от
    // TimeZone соединения: свежесть считается вычитанием, и молчание агента
    // измерялось бы с ошибкой в часы. NULL здесь невозможен по смыслу: строка
    // существует только затем, чтобы нести это значение.
    expect(await migration003()).toMatch(/seen_at\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)/);
  });

  it('реестра хостов не заводит', async () => {
    // Таблица хостов отвергнута в спеке по YAGNI, триггер пересмотра назван —
    // второй хост. Колонки вроде host_ip или name здесь означали бы, что
    // реестр завели наполовину: писать в них некому, а читатель решит, что
    // машин несколько.
    const sql = await migration003();
    expect(sql).not.toMatch(/host_ip|hostname|\bname\b/);
  });
});

describe('миграция 004 — аренда', () => {
  it('срок оплаты — обязательная метка времени с бесплатным первым месяцем', async () => {
    // timestamptz, а не timestamp: срок сравнивается с now() в отборе
    // сборщика, и без пояса сравнение зависело бы от TimeZone соединения —
    // то есть от того, какой процесс кластера спросил.
    //
    // NOT NULL: NULL означал бы «срок неизвестен», а `paid_until <= now()` на
    // NULL даёт не-совпадение — продукт молча хостился бы бесплатно и вечно.
    //
    // DEFAULT — это и есть «первый месяц бесплатно» из решений владельца, и
    // одновременно заполнение существующих demo и shop2: ADD COLUMN проставит
    // им значение, вычисленное в момент ALTER. INSERT в provisioning.service
    // колонку не перечисляет, так что без DEFAULT новый продукт приезжал бы
    // без срока вовсе.
    expect(await migration004()).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+paid_until\s+timestamptz\s+NOT NULL\s+DEFAULT\s+now\(\)\s*\+\s*interval\s+'1 month'/,
    );
  });

  it('бесплатный месяц не перевыдаётся: правки данных в файле нет', async () => {
    // ГЛАВНЫЙ сторож файла. Модуль накатывает свои миграции сам, в
    // onModuleInit, то есть при КАЖДОМ `pm2 restart`.
    // `UPDATE products SET paid_until = now() + interval '1 month'
    //  WHERE paid_until IS NULL` выглядит разовой правкой данных, но ею не
    // является: любая строка с пустой колонкой получала бы новый бесплатный
    // месяц от минуты рестарта. А пустой она была бы у каждого продукта,
    // заведённого после выката, раз INSERT её не заполняет, — продукт
    // бесконечно жил бы «в первом месяце». Заметно только по недосчитанной
    // выручке.
    expect(await migration004()).not.toMatch(/UPDATE\s+products\s+SET\s+paid_until/i);
  });

  it('причина сна — необязательный текст', async () => {
    // Именно nullable. NOT NULL DEFAULT '' завёл бы третье состояние: пустая
    // строка против «причины нет», а их этот код уже различал неправильно.
    // `;` в якоре не украшение — он и запрещает приехавшие следом модификаторы.
    expect(await migration004()).toMatch(/ADD COLUMN IF NOT EXISTS\s+sleep_reason\s+text\s*;/);
  });

  it('словарь статусов знает sleeping', async () => {
    // Состав сверен с живой базой прода 16.09.2026 (`\d products`): там ровно
    // шесть значений ниже без sleeping.
    expect(dictionary(await migration004(), 'products_status_check', 'status', '004')).toEqual([
      'archived',
      'degraded',
      'failed',
      'provisioning',
      'running',
      'sleeping',
      'stopped',
    ]);
  });

  it('словарь статусов РАСШИРЕН, а не переписан: прежние значения на месте', async () => {
    // Ожидание выводится из текста 002, а не пишется руками: список,
    // продублированный в тесте, теряет значение вместе с миграцией и остаётся
    // зелёным. Потерянное значение здесь — это `UPDATE products SET status =
    // '...'`, падающий на CHECK внутри своего обработчика (так уже было бы с
    // 'failed', см. 002).
    //
    // Сверка на РАВЕНСТВО, а не на «002 плюс sleeping». Прежняя редакция этого
    // теста требовала, чтобы 002 значения НЕ знала, — и тем закрепляла дефект:
    // 002 едет первой при каждом старте API, её словарь навешивается на живые
    // данные заново, и первый же уснувший продукт ронял ADD CONSTRAINT в ней.
    // Оба файла объявляют один и тот же ИМЕНОВАННЫЙ словарь, значит состав у
    // него обязан быть один. 004 при этом остаётся нужной: на базе, где 002
    // накатилась ДО появления sleeping (прод на 16.09.2026), словарь расширяет
    // именно она.
    const inTwo = dictionary(await migration002(), 'products_status_check', 'status');
    const inFour = dictionary(await migration004(), 'products_status_check', 'status', '004');

    expect(inFour).toEqual(inTwo);
    expect(inFour).toContain('sleeping');
  });

  it('вид задания — обязательный текст, заведение по умолчанию', async () => {
    // Единственный существующий INSERT в очередь (provisioning.service.ts)
    // вида не передаёт. Без DEFAULT постановка заданий сломалась бы в ту же
    // секунду, а с NULL-ами вид пришлось бы домысливать в каждом читателе.
    expect(await migration004()).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+kind\s+text\s+NOT NULL\s+DEFAULT\s+'provision'/,
    );
  });

  it('DEFAULT у вида задания НЕ снимается — в отличие от products.kind', async () => {
    // 002 снимает DEFAULT у products.kind сразу после заполнения старых строк,
    // и это правильно там: забытый kind означал бы бота, выставленного наружу
    // сайтом. Здесь наоборот — задание без вида это заведение, и повторить
    // приём 002 значило бы сломать постановку заданий. Сторож от копирования
    // соседней миграции по образцу.
    expect(await migration004()).not.toMatch(/ALTER COLUMN\s+kind\s+DROP DEFAULT/);
  });

  it('словарь видов задания закрыт CHECK', async () => {
    expect(
      dictionary(await migration004(), 'product_provision_jobs_kind_check', 'kind', '004'),
    ).toEqual(['provision', 'sleep', 'wake']);
  });

  it('каждое ограничение навешивается идемпотентно', async () => {
    // Тот же сторож, что в 002: ADD CONSTRAINT не знает IF NOT EXISTS, и без
    // снятия одноимённого повторный прогон падал бы — а applyMigration такой
    // отказ только пишет в лог.
    const sql = await migration004();
    const added = [...sql.matchAll(/ADD CONSTRAINT\s+(\w+)/g)].map((m) => m[1]);
    expect(added.length).toBeGreaterThan(0);
    for (const name of added) {
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`DROP CONSTRAINT IF EXISTS ${name};`)).toBeLessThan(
        sql.indexOf(`ADD CONSTRAINT ${name}`),
      );
    }
  });

  it('ни одного неповторяемого оператора во всём файле', async () => {
    // Сторож шире предыдущих двух: он красный на ЛЮБОМ новом операторе без
    // защиты от повтора — правке данных, голом ALTER, CREATE без IF NOT
    // EXISTS. Файл исполняется при каждом старте API, и цена незащищённого
    // оператора здесь не «ошибка», а молчаливый отказ: applyMigration ловит
    // исключение, пишет строку в лог и едет дальше.
    const statements = (await migration004())
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s).toMatch(
        /ADD COLUMN IF NOT EXISTS|DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT|CREATE INDEX IF NOT EXISTS/,
      );
    }
  });

  it('индекс по сроку оплаты — частичный, мимо архивных', async () => {
    // Сборщику нужен отбор «кому пора платить», пробуждению — «кого будить
    // первым». Обоим подходит индекс по paid_until; архивные не платят
    // никогда, и держать их в индексе незачем.
    const sql = await migration004();
    expect(sql).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_products_paid_until\s+ON products\s*\(\s*paid_until\s*\)/,
    );
    expect(sql).toMatch(/idx_products_paid_until[\s\S]*?WHERE\s+archived_at IS NULL\s*;/);
  });

  it('предикат индекса не вшивает в себя статус', async () => {
    // `AND status = 'running'` напрашивается, но набор платящих статусов не
    // устоялся: на проде 16.09.2026 четыре продукта из шести в 'degraded'.
    // Индекс, вшивший один статус, пришлось бы пересоздавать вместе с этим
    // решением и до тех пор он не обслуживал бы выборку спящих для
    // пробуждения. Запросу с более узким условием широкий предикат не мешает.
    const index = (await migration004()).split(';').find((s) => s.includes('CREATE INDEX'));

    expect(index).toBeDefined();
    expect(index).not.toContain('status');
  });
});
