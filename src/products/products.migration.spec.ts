import { ProductsService } from './products.service';

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
  // отсутствующим.
  return sql.replace(/--[^\n]*/g, '');
}

/**
 * Значения именованного CHECK-словаря, отсортированные: сверка получается ровно
 * про состав, а не про порядок перечисления.
 *
 * Имя ограничения в якоре обязательно: словарей по колонке status в файле два —
 * у products и у очереди заданий, — и безымянный поиск подобрал бы чужой.
 */
function dictionary(sql: string, constraint: string, column: string): string[] {
  const m = sql.match(
    new RegExp(`ADD CONSTRAINT\\s+${constraint}\\s+CHECK\\s*\\(\\s*${column} IN \\(([^)]*)\\)`),
  );
  if (!m) throw new Error(`в миграции 002 нет CHECK-словаря ${constraint} по колонке ${column}`);
  return m[1]
    .split(',')
    .map((v) => v.trim().replace(/'/g, ''))
    .sort();
}

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
    expect(applied).toEqual(['001_products.sql', '002_provisioning.sql']);
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
    expect(dictionary(await migration002(), 'products_status_check', 'status')).toEqual([
      'archived',
      'degraded',
      'failed',
      'provisioning',
      'running',
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
