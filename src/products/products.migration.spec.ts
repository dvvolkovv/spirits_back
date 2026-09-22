import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS, ProductsService } from './products.service';

// Токен машины нужен 005 при КАЖДОЙ накатке, а onModuleInit зовёт здесь почти
// каждый помощник. Без токена сервис честно пишет строку об этом в лог — и
// заливает ею вывод всей батареи.
const ORIGINAL_TOKEN = process.env.PRODUCT_HOST_TOKEN;
beforeEach(() => {
  process.env.PRODUCT_HOST_TOKEN = 'т'.repeat(64);
});
afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.PRODUCT_HOST_TOKEN;
  else process.env.PRODUCT_HOST_TOKEN = ORIGINAL_TOKEN;
});

function makeService() {
  const queries: string[] = [];
  const record = async (sql: string) => {
    queries.push(sql);
    return { rows: [] };
  };
  // Выделенное соединение ведёт ТОТ ЖЕ журнал запросов: 005 едет по нему (ей
  // нужен параметр сессии), и с отдельным журналом помощник migration005() не
  // увидел бы ни строки, а проверки формы зеленели бы на пустоте.
  const client = { query: jest.fn(record), release: jest.fn() };
  const pg = { query: jest.fn(record), getClient: jest.fn(async () => client) };
  return { svc: new ProductsService(pg as any), queries, pg, client };
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

  it('не падает, если применение НЕобязательной миграции бросает ошибку', async () => {
    // 001..004 едут через пул: их отказ по-прежнему только пишется в лог.
    // Схема продуктов не должна ронять чат, оплаты и вход. 005 едет по
    // выделенному соединению — здесь оно исправно, то есть падают ровно
    // необязательные.
    const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
    const pg = {
      query: jest.fn(async (sql: string) => {
        // 006 тоже едет через пул и тоже обязательная, поэтому исправна здесь
        // ровно как 005: иначе этот сценарий проверял бы не то, что заявляет —
        // старт падал бы от ОБЯЗАТЕЛЬНОЙ миграции, а читался бы как «падает от
        // необязательной». Отказ 006 проверяется своим сценарием ниже.
        if (String(sql).includes('ALTER TABLE product_host_agent')) return { rows: [] };
        throw new Error('boom');
      }),
      getClient: jest.fn(async () => client),
    };
    const svc = new ProductsService(pg as any);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('отказ 005 РОНЯЕТ старт, а не уходит в лог', async () => {
    // 005 отказывает нарочно, когда продукт не сопоставился с машиной по
    // адресу. Отказ, уходящий строкой в лог, оставил бы этот случай
    // незамеченным — а ради того, чтобы его заметили, он и написан. Плюс без
    // product_hosts гвард агента и выдача заданий отвечают 500 на каждый
    // опрос: «одна строка в логе» здесь означает молча вставший хостинг.
    const client = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('product_hosts')) throw new Error('не сошёлся');
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg = { query: jest.fn(async () => ({ rows: [] })), getClient: jest.fn(async () => client) };

    await expect(new ProductsService(pg as any).onModuleInit()).rejects.toThrow(/005_hosts\.sql/);
  });

  it('отказ 006 РОНЯЕТ старт, а не уходит в лог', async () => {
    // Выдачу заданий 006 не трогает — ломается одна вещь, и ломается В СТОРОНУ
    // ЗЕЛЁНОГО: все пути отказа проверки в кабинете отвечают «агент жив»
    // нарочно, поэтому не применившаяся 006 даёт не «диагностики нет», а
    // «индикатор зелёный всегда». Отличить это снаружи нечем — значит отказ
    // обязан быть слышен здесь.
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (String(sql).includes('ALTER TABLE product_host_agent')) throw new Error('не та форма');
        return { rows: [] };
      }),
      getClient: jest.fn(async () => ({ query: jest.fn(async () => ({ rows: [] })), release: jest.fn() })),
    };

    await expect(new ProductsService(pg as any).onModuleInit()).rejects.toThrow(
      /006_host_agent_per_host\.sql/,
    );
  });

  it('006 едет ПОСЛЕ 003 и 005 — она перестраивает их обеих', async () => {
    // Список — это и есть описание схемы: 006 меняет ключ таблицы, которую
    // заводит 003, и вешает внешний ключ на реестр, который заводит 005.
    // Перестановка даёт отказ обязательной миграции, то есть невзлетевший API.
    const applied: string[] = [];
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const svc = new ProductsService(pg as any);
    (svc as any).applyMigration = jest.fn(async (f: string) => void applied.push(f));

    await svc.onModuleInit();

    expect(applied.indexOf('006_host_agent_per_host.sql')).toBeGreaterThan(
      applied.indexOf('003_host_agent.sql'),
    );
    expect(applied.indexOf('006_host_agent_per_host.sql')).toBeGreaterThan(
      applied.indexOf('005_hosts.sql'),
    );
  });

  it('005 везётся на ВЫДЕЛЕННОМ соединении в явной транзакции', async () => {
    // Через пул параметр сессии до файла не доезжает, и не доезжает ТИХО:
    // set_config(..., true) живёт до конца транзакции, а через пул каждый
    // запрос — своя транзакция. Следующий запрос читает пустую строку, а не
    // ошибку, и в реестр уехал бы sha256('') — агент с настоящим токеном молча
    // перестал бы получать работу. Измерено на PostgreSQL 16.14.
    const { svc, client } = makeService();
    process.env.PRODUCT_HOST_TOKEN = 'т'.repeat(64);

    await svc.onModuleInit();

    const onClient = client.query.mock.calls.map((c: any[]) => String(c[0]));
    expect(onClient[0]).toBe('BEGIN');
    expect(onClient.at(-1)).toBe('COMMIT');
    expect(onClient.some((s) => s.includes('CREATE TABLE IF NOT EXISTS product_hosts'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('в Postgres уезжает ХЕШ токена, а не сам токен', async () => {
    // Две причины разом. Первая: digest() живёт в pgcrypto, а на проде
    // 21.09.2026 стоят только citext и plpgsql — считать sha256 внутри SQL там
    // нечем, и `encode(digest(...))` отказал бы всем файлом. Вторая: в базу не
    // уезжает даже то, что можно предъявить гварду.
    const { svc, client } = makeService();
    const token = 'т'.repeat(64);
    process.env.PRODUCT_HOST_TOKEN = token;

    await svc.onModuleInit();

    const setConfig = client.query.mock.calls.find((c: any[]) => String(c[0]).includes('set_config'));
    expect(setConfig).toBeDefined();
    expect(setConfig![1]).toEqual([
      'linkeon.own_host_token_sha256',
      crypto.createHash('sha256').update(token).digest('hex'),
    ]);
    // Сам токен не уезжает НИ ОДНИМ запросом — ни текстом, ни параметром.
    for (const [sql, params] of client.query.mock.calls as any[][]) {
      expect(String(sql)).not.toContain(token);
      for (const p of params ?? []) expect(String(p)).not.toContain(token);
    }
  });

  it('без PRODUCT_HOST_TOKEN параметр пуст — и машина не заводится с хешем пустой строки', async () => {
    // Пустой токен — состояние окружения, а не сломанная схема, и ронять им
    // чат с оплатами незачем. Но подставить вместо него sha256('') нельзя: это
    // машина, которую не узнает ни один агент.
    const { svc, client } = makeService();
    delete process.env.PRODUCT_HOST_TOKEN;

    await svc.onModuleInit();

    const setConfig = client.query.mock.calls.find((c: any[]) => String(c[0]).includes('set_config'));
    expect(setConfig![1]).toEqual(['linkeon.own_host_token_sha256', '']);
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
      '005_hosts.sql',
      '006_host_agent_per_host.sql',
      '007_selfservice.sql',
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
    //
    // 'blocked' здесь по той же причине и заводит его 007: гашение
    // администратором — штатное состояние, и на его строке отставший словарь
    // 002 уронил бы весь файл. Исполнением ловит сценарий 20е.
    expect(dictionary(await migration002(), 'products_status_check', 'status')).toEqual([
      'archived',
      'blocked',
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
    // шесть значений ниже без sleeping. 'blocked' добавлен 22.09.2026 вместе с
    // 007 — и добавлен ВО ВСЕ ТРИ файла, где этот именованный словарь объявлен.
    expect(dictionary(await migration004(), 'products_status_check', 'status', '004')).toEqual([
      'archived',
      'blocked',
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

/**
 * Текст миграции 005 — отдельно от соседей по той же причине, по какой отделены
 * 002, 003 и 004. Якорь — `product_hosts`: в остальных файлах его нет, а в
 * журнале запросов рядом лежат `BEGIN`, `set_config` и `COMMIT` (005 едет по
 * выделенному соединению).
 */
async function migration005(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('product_hosts'));
  if (!sql) {
    throw new Error('миграция 005 не применена: ни один запрос не заводит product_hosts');
  }
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

/**
 * Операторы файла С УЧЁТОМ долларового цитирования.
 *
 * Тело `DO $$ ... $$` несёт собственные точки с запятой, и наивный `split(';')`
 * резал бы его на обрывки, ни один из которых не похож на разрешённый оператор.
 * Сторож ниже краснел бы не от дефекта, а от того, что перестал понимать файл —
 * и чинился бы ослаблением регекспа.
 */
function statements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      buf += '$$';
      i++;
      continue;
    }
    if (sql[i] === ';' && !inDollar) {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += sql[i];
  }
  out.push(buf.trim());
  return out.filter(Boolean);
}

describe('миграция 005 — реестр машин', () => {
  it('разбор операторов понимает долларовое цитирование', () => {
    // Сторож прибора. Без него проверка «ни одного неповторяемого оператора»
    // зеленела бы на нарезке, где DO-блок распался на куски.
    expect(statements("SELECT 1; DO $$ BEGIN; RAISE; END $$; SELECT 2")).toEqual([
      'SELECT 1',
      'DO $$ BEGIN; RAISE; END $$',
      'SELECT 2',
    ]);
  });

  it('заводит реестр машин и переживает повторный прогон', async () => {
    // Модуль накатывает схему на КАЖДОМ старте API. CREATE TABLE без IF NOT
    // EXISTS уронил бы 005 на втором запуске — а она обязательная, то есть
    // уронил бы и сам API.
    expect(await migration005()).toMatch(/CREATE TABLE IF NOT EXISTS\s+product_hosts/);
  });

  it('адрес машины — inet, как host_ip у продукта, и уникален', async () => {
    // text здесь не компилируется вовсе: `operator does not exist: inet = text`
    // на сопоставлении ниже (измерено на PostgreSQL 16.14). UNIQUE — про то,
    // что сопоставление это соединение: две машины с одним адресом дали бы
    // продукту метку одной из них наугад.
    expect(await migration005()).toMatch(/public_ip\s+inet\s+NOT NULL\s+UNIQUE/);
  });

  it('хеш токена агента уникален', async () => {
    // Гвард берёт машину по хешу без ORDER BY — ровно как RunnerGuard берёт
    // продукт по runner_token_hash (001). Без уникальности совпадение отдаёт
    // произвольную машину, то есть чужие задания.
    expect(await migration005()).toMatch(/agent_token_hash\s+text\s+NOT NULL\s+UNIQUE/);
  });

  it('потолок — положительное целое', async () => {
    // Нулевой потолок означает машину, на которую ничего нельзя завести, и
    // отказ «мест нет» вместо ошибки конфигурации.
    expect(await migration005()).toMatch(/capacity\s+int\s+NOT NULL\s+CHECK\s*\(\s*capacity > 0\s*\)/);
  });

  it('словарь аудитории ИНЛАЙНОВЫЙ, а не навешиваемый заново', async () => {
    // Именованный CHECK через DROP+ADD навешивался бы при каждом старте API, и
    // значение, дописанное поздней миграцией, роняло бы 005 на живых данных —
    // ловушка 002. Инлайновый внутри CREATE TABLE IF NOT EXISTS на живой базе
    // не исполняется вовсе.
    const sql = await migration005();
    expect(sql).toMatch(/audience\s+text NOT NULL CHECK \(audience IN \('own','clients'\)\)/);
    expect(sql).not.toMatch(/ADD CONSTRAINT/);
  });

  it('метка машины у продукта — внешний ключ без ON DELETE', async () => {
    // SET NULL означал бы продукты без машины, молча выпавшие из выдачи
    // заданий; CASCADE — снос реестра продуктов вместе со строкой машины.
    const sql = await migration005();
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+host_id\s+text\s+REFERENCES product_hosts\(id\)\s*;/);
    expect(sql).not.toMatch(/ON DELETE/);
  });

  it('хеш приезжает параметром сессии, а не считается в SQL', async () => {
    // digest() живёт в pgcrypto, а на проде 21.09.2026 стоят только citext и
    // plpgsql: `encode(digest(...))` отказал бы всем файлом.
    const sql = await migration005();
    expect(sql).not.toMatch(/digest\s*\(/);
    expect(sql).toContain("current_setting('linkeon.own_host_token_sha256', true)");
  });

  it('параметр сессии читается мягко, и пустой не заводит машину', async () => {
    // Строгий current_setting на неустановленном параметре — ошибка, то есть
    // отказ всего файла у любого, кто накатит его psql-ом или тестовой
    // батареей. А выставленный через пул он читается ПУСТОЙ СТРОКОЙ, и без
    // проверки на пустоту в реестр уехала бы машина с хешем пустой строки:
    // настоящий агент молча перестал бы получать работу.
    const sql = await migration005();
    expect(sql).not.toMatch(/current_setting\('linkeon\.own_host_token_sha256'\)/);
    expect(sql).toMatch(
      /coalesce\(current_setting\('linkeon\.own_host_token_sha256', true\), ''\) <> ''/,
    );
  });

  it('машина own заводится один раз', async () => {
    expect(await migration005()).toMatch(
      /NOT EXISTS \(SELECT 1 FROM product_hosts WHERE id = 'own'\)/,
    );
  });

  it('метка ставится СОПОСТАВЛЕНИЕМ по адресу, а не умолчанием', async () => {
    const sql = await migration005();
    expect(sql).toMatch(
      /UPDATE products p SET host_id = h\.id[\s\S]*?FROM product_hosts h[\s\S]*?WHERE p\.host_id IS NULL AND p\.host_ip = h\.public_ip/,
    );
    // Умолчание — это продукт, получающий задания на машину, где его каталога
    // нет: заведение начнётся заново поверх пустого места.
    expect(sql).not.toMatch(/SET host_id = 'own'/);
  });

  it('несопоставленный ЖИВОЙ продукт роняет файл, архивный — нет', async () => {
    const sql = await migration005();
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toMatch(/host_id IS NULL AND archived_at IS NULL/);
  });

  it('ни одного неповторяемого оператора во всём файле', async () => {
    // Тот же сторож, что в 004, и шире точечных проверок выше: он красный на
    // ЛЮБОМ новом операторе без защиты от повтора. Здесь цена выше, чем у
    // соседей: 005 обязательная, и незащищённый оператор роняет не строку в
    // логе, а старт API на втором же рестарте.
    const sts = statements(await migration005());
    const guards: [RegExp, RegExp][] = [
      [/^CREATE TABLE/, /^CREATE TABLE IF NOT EXISTS product_hosts/],
      [/^ALTER TABLE/, /ADD COLUMN IF NOT EXISTS/],
      [/^INSERT/, /NOT EXISTS \(SELECT 1 FROM product_hosts WHERE id = 'own'\)/],
      [/^UPDATE/, /WHERE p\.host_id IS NULL/],
      [/^DO /, /RAISE EXCEPTION/],
    ];

    expect(sts.map((s) => s.slice(0, s.indexOf(' ')))).toEqual([
      'CREATE',
      'ALTER',
      'INSERT',
      'UPDATE',
      'DO',
    ]);
    sts.forEach((s, i) => {
      expect(s).toMatch(guards[i][0]);
      expect(s).toMatch(guards[i][1]);
    });
  });
});

/**
 * Текст миграции 006.
 *
 * Маркер поиска — `ALTER TABLE product_host_agent`, и он выбран не наугад:
 * `product_host_agent` есть и в 003, а `product_hosts` — и в 005, и обе едут
 * РАНЬШЕ. Поиск по любому из них отдал бы текст соседа, и весь блок ниже
 * проверял бы не тот файл, оставаясь зелёным.
 */
async function migration006(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('ALTER TABLE product_host_agent'));
  if (!sql) {
    throw new Error('миграция 006 не применена: ни один запрос не перестраивает product_host_agent');
  }
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

describe('миграция 006 — отметка о жизни своя у каждой машины', () => {
  it('маркер находит именно 006, а не 003 и не 005', async () => {
    // Сторож прибора. Ошибись он файлом — проверки ниже зеленели бы на тексте
    // соседа, а самый содержательный из них («один оператор») зеленел бы тем
    // охотнее, чем меньше 006 похожа на то, что от неё ждут.
    const sql = await migration006();
    expect(sql).toContain('ADD COLUMN host_id');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS product_host_agent');
    expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS product_hosts');
  });

  it('весь файл — ОДИН оператор под проверкой формы', async () => {
    // Здесь меняется первичный ключ живой таблицы, а файл исполняется при
    // КАЖДОМ старте API. «Идемпотентная» запись через DROP CONSTRAINT IF
    // EXISTS + ADD PRIMARY KEY повтор переживает — и на каждом рестарте
    // перестраивает ключ под ACCESS EXCLUSIVE, оставляя окно без уникального
    // индекса, в котором ON CONFLICT (host_id) отказывает. Единственная форма,
    // у которой повтор — настоящий no-op, это блок с проверкой формы.
    const sts = statements(await migration006());

    expect(sts).toHaveLength(1);
    expect(sts[0]).toMatch(/^DO \$\$/);
  });

  it('признак «уже перестроена» — ЦЕЛЕВАЯ колонка, а не отсутствие исходной', async () => {
    // Проверка «нет колонки id» истинна и у таблицы, которой ничего не делали,
    // если 003 когда-нибудь перепишут: блок ушёл бы перестраивать пустое место.
    const sql = await migration006();
    expect(sql).toMatch(/attname = 'host_id'[\s\S]*?THEN\s+RETURN;/);
  });

  it('отсутствие таблицы — громкий отказ, а не тихий выход', async () => {
    // 006 обязательная. Молчаливый выход здесь означал бы успешный старт API с
    // отметкой, которую некуда писать, то есть индикатор, зеленеющий по
    // своему же отказу.
    const sql = await migration006();
    expect(sql).toMatch(/to_regclass\('product_host_agent'\) IS NULL[\s\S]*?RAISE EXCEPTION/);
  });

  it('единственная строка достаётся own, и только если own есть в реестре', async () => {
    // До реестра машина была одна, и 005 заводит её под меткой 'own' — это не
    // догадка. А вот при пустом реестре (005 — безвредный no-op при
    // незаполненном PRODUCT_HOST_TOKEN) приписывать отметку некому.
    const sql = await migration006();
    expect(sql).toMatch(
      /UPDATE product_host_agent SET host_id = 'own'\s+WHERE EXISTS \(SELECT 1 FROM product_hosts WHERE id = 'own'\)/,
    );
    expect(sql).toMatch(/DELETE FROM product_host_agent WHERE host_id IS NULL/);
  });

  it('имя старого ключа не угадывается', async () => {
    // `DROP CONSTRAINT IF EXISTS product_host_agent_pkey` промахнулся бы молча:
    // не найдя имени, он не делает НИЧЕГО и не говорит об этом. DROP COLUMN
    // уносит ключ с собой, а если бы не унёс — следующий ADD PRIMARY KEY
    // отказал бы громко.
    const sql = await migration006();
    expect(sql).not.toMatch(/DROP CONSTRAINT/);
    expect(sql).toMatch(/ALTER TABLE product_host_agent DROP COLUMN id/);
  });

  it('порядок операций: сначала заполнить и убрать, потом NOT NULL и ключ', async () => {
    // SET NOT NULL на строке без метки отказал бы всем файлом, а файл
    // обязательный — то есть API не взлетел бы.
    const sql = await migration006();
    const at = (re: RegExp) => sql.search(re);
    expect(at(/ADD COLUMN host_id/)).toBeLessThan(at(/UPDATE product_host_agent/));
    expect(at(/UPDATE product_host_agent/)).toBeLessThan(at(/DELETE FROM product_host_agent/));
    expect(at(/DELETE FROM product_host_agent/)).toBeLessThan(at(/SET NOT NULL/));
    expect(at(/SET NOT NULL/)).toBeLessThan(at(/ADD PRIMARY KEY \(host_id\)/));
  });

  it('единственность теперь на МАШИНУ', async () => {
    const sql = await migration006();
    expect(sql).toMatch(/ADD PRIMARY KEY \(host_id\)/);
  });

  it('внешний ключ отметки — с ON DELETE CASCADE, в отличие от ключа продукта', async () => {
    // Продукт снос машины переживать обязан (у него код, история и владелец),
    // отметка — нет: это производная от машины, живущая две минуты. Ключ без
    // ON DELETE сделал бы снос машины невозможным, пока отметку не уберут
    // руками, — то есть подтолкнул бы к `DELETE ... CASCADE` на самой машине,
    // где под каскад попадут уже продукты.
    const sql = await migration006();
    expect(sql).toMatch(
      /FOREIGN KEY \(host_id\) REFERENCES product_hosts\(id\) ON DELETE CASCADE/,
    );
  });
});

/**
 * Текст миграции 007 — отдельно от соседей по той же причине, по какой отделены
 * 002..006: склейка зеленела бы на чужом тексте. Якорь — `product_user_limits`:
 * `products_status_check` есть ещё и в 002, и в 004, а обе едут РАНЬШЕ, то есть
 * поиск по словарю отдал бы текст соседа и весь блок ниже проверял бы не тот
 * файл, оставаясь зелёным.
 */
async function migration007(): Promise<string> {
  const { svc, queries } = makeService();
  await svc.onModuleInit();
  const sql = queries.find((q) => q.includes('product_user_limits'));
  if (!sql) {
    throw new Error('миграция 007 не применена: ни один запрос не заводит product_user_limits');
  }
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
}

describe('миграция 007 — блокировка и потолок на аккаунт', () => {
  it('маркер находит именно 007, а не 002 и не 004', async () => {
    // Сторож прибора. Ошибись он файлом — проверка словаря ниже зеленела бы на
    // тексте 002, который тот же словарь объявляет с тем же составом, и 007
    // могла бы потерять его целиком незамеченной.
    const sql = await migration007();
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS product_user_limits');
    expect(sql).not.toContain('paid_until');
    expect(sql).not.toContain('product_provision_jobs');
  });

  it('словарь статусов знает blocked', async () => {
    // Состав сверяется ЦЕЛИКОМ, а не «содержит blocked»: identity/migrations/003
    // — про то, как дописывание одного значения теряет остальные (там потерялся
    // 'apple' и сломался вход).
    expect(dictionary(await migration007(), 'products_status_check', 'status', '007')).toEqual([
      'archived',
      'blocked',
      'degraded',
      'failed',
      'provisioning',
      'running',
      'sleeping',
      'stopped',
    ]);
  });

  it('blocked знают ВСЕ файлы, где словарь объявлен, а не только 007', async () => {
    // СТОРОЖ КЛАССА, а не случая, и он сильнее соседнего «один состав во всех
    // миграциях»: тот сверяет объявления между собой и остался бы зелёным, если
    // бы blocked не было НИ В ОДНОМ. Здесь проверяется и число объявлений, и
    // наличие значения в каждом.
    //
    // Цена пропуска измерена в куске 3 на 'sleeping': файл, отставший от
    // соседей, отказывает на первой же живой строке с новым значением, отказ
    // уходит строкой в лог (applyMigration ловит и едет дальше), и файл
    // становится мёртвым молча, навсегда и вместе со всем, что в него потом
    // допишут.
    const declared = namedDictionaries().get('products_status_check');
    // Число, а не `toBeGreaterThan(1)`: новый файл, объявивший словарь и
    // забывший значение, обязан краснить здесь, а не проходить как «ну, больше
    // одного же».
    expect(declared?.map((d) => d.file)).toEqual([
      '002_provisioning.sql',
      '004_rent.sql',
      '007_selfservice.sql',
    ]);
    for (const d of declared!) {
      expect({ file: d.file, blocked: d.values.includes('blocked') }).toEqual({
        file: d.file,
        blocked: true,
      });
    }
  });

  it('за что погашен — необязательный текст на продукте', async () => {
    // Именно nullable, по образцу sleep_reason (004): NOT NULL DEFAULT '' завёл
    // бы третье состояние — пустую строку против «причины нет».
    // `;` в якоре не украшение: он запрещает приехавшие следом модификаторы.
    expect(await migration007()).toMatch(/ADD COLUMN IF NOT EXISTS\s+block_reason\s+text\s*;/);
  });

  it('причина блокировки — СВОЯ колонка, а не sleep_reason', async () => {
    // Гашение ставит задание вида 'sleep', а путь отказа такого задания
    // (completeJob) обнуляет sleep_reason:
    // `sleep_reason = CASE closed.kind WHEN 'sleep' THEN NULL ELSE ... END`.
    // Причина блокировки, сложенная туда, стиралась бы ровно тогда, когда
    // гашение сорвалось, — то есть там, где объяснение нужнее всего. Этот файл
    // колонку сна не трогает вовсе.
    expect(await migration007()).not.toContain('sleep_reason');
  });

  it('потолок на аккаунт — своя таблица модуля', async () => {
    expect(await migration007()).toMatch(/CREATE TABLE IF NOT EXISTS\s+product_user_limits/);
  });

  it('ключ таблицы — владелец, и он text', async () => {
    // text, а не varchar: у OAuth/email-пользователей идентификатор — UUID на
    // 36 символов. PRIMARY KEY, а не индекс: потолок читается подзапросом без
    // ORDER BY, и вторая строка давала бы потолок наугад.
    expect(await migration007()).toMatch(/user_id\s+text\s+PRIMARY KEY/);
  });

  it('потолок обязан быть положительным', async () => {
    // Без CHECK строка с нулём означала бы аккаунт, которому нельзя ничего, —
    // запрет, неотличимый для владельца от обычного отказа по потолку.
    expect(await migration007()).toMatch(
      /max_products\s+int\s+NOT NULL\s+CHECK\s*\(\s*max_products\s*>\s*0\s*\)/,
    );
  });

  it('умолчание НЕ копируется в строку: строк заводится ноль', async () => {
    // Строка появляется только у тех, кому потолок подняли. INSERT в этом файле
    // — это либо копия умолчания в каждый аккаунт (тогда правка умолчания
    // превращается в правку данных), либо повторяемая при каждом старте API
    // правка данных, то есть ловушка 004 с бесплатным месяцем.
    expect(await migration007()).not.toMatch(/INSERT\s+INTO\s+product_user_limits/i);
    expect(await migration007()).not.toMatch(/UPDATE\s+product_user_limits/i);
  });

  it('каждое ограничение навешивается идемпотентно', async () => {
    // Тот же сторож, что в 002 и 004: ADD CONSTRAINT не знает IF NOT EXISTS, и
    // без снятия одноимённого повторный прогон падал бы — а applyMigration
    // такой отказ только пишет в лог.
    const sql = await migration007();
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
    // Файл исполняется при КАЖДОМ старте API, и цена незащищённого оператора
    // здесь не «ошибка», а молчаливый отказ: applyMigration ловит исключение,
    // пишет строку в лог и едет дальше.
    const list = statements(await migration007());
    expect(list.length).toBeGreaterThan(0);
    for (const s of list) {
      expect(s).toMatch(
        /ADD COLUMN IF NOT EXISTS|DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS/,
      );
    }
  });
});
