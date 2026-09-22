import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './products.service';
import { ProductToolService, describeTurn } from './product-tool.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('инструмент продуктов против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };

  const OWNER = '79030169187';
  const ALIEN = '70000000000';

  /**
   * Заводит продукт напрямую в базе: провижининг здесь не проверяется.
   *
   * `checkout_path` и `runner_token_hash` заполняются мусором не для вида:
   * в 001 они NOT NULL И БЕЗ DEFAULT, поэтому INSERT без них не проходит
   * вовсе — падает вся девятка, ещё не дойдя до поиска. У хеша вдобавок
   * UNIQUE, так что значение выводится из слага (слаг тоже уникален) —
   * константа развалила бы второй INSERT в тестах на два продукта.
   */
  const mkProduct = async (o: {
    user?: string; name: string; slug: string; domain?: string | null;
    kind?: string; status?: string;
  }) => {
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, domain, kind, status,
                             checkout_path, runner_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        o.user ?? OWNER, o.name, o.slug, o.domain ?? null,
        o.kind ?? 'site', o.status ?? 'running',
        `/srv/${o.slug}`, `hash-${o.slug}`,
      ],
    );
    return r.rows[0].id as string;
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }
    // Гард на чужую базу: beforeEach делает TRUNCATE и адрес не разбирает, а на
    // той же ноде живёт база стенда test.linkeon.io с теми же таблицами.
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) {
      throw new Error('PROVISIONING_PG_URL указывает на НЕпустую базу — нужна одноразовая');
    }
  });

  afterAll(async () => {
    await pool?.query('TRUNCATE products, product_turns RESTART IDENTITY CASCADE');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE products, product_turns RESTART IDENTITY CASCADE');
  });

  describe('поиск продукта', () => {
    it('находит по куску имени', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      const m = await svc.resolve(OWNER, 'цветов');
      expect(m.map((p) => p.id)).toEqual([id]);
    });

    it('находит по слагу и по домену', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers', domain: 'flowers.p.linkeon.io' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect((await svc.resolve(OWNER, 'flowers')).map((p) => p.id)).toEqual([id]);
      expect((await svc.resolve(OWNER, 'flowers.p.linkeon.io')).map((p) => p.id)).toEqual([id]);
    });

    it('находит по идентификатору', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect((await svc.resolve(OWNER, id)).map((p) => p.id)).toEqual([id]);
    });

    it('регистр не имеет значения', async () => {
      const id = await mkProduct({ name: 'Магазин Цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect((await svc.resolve(OWNER, 'МАГАЗИН')).map((p) => p.id)).toEqual([id]);
    });

    // Главный сценарий спеки: два магазина, назвали «магазин».
    it('отдаёт ВСЕ совпадения, а не первое', async () => {
      const a = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const b = await mkProduct({ name: 'Магазин книг', slug: 'books' });
      const svc = new ProductToolService(pg as any, {} as any);
      const m = await svc.resolve(OWNER, 'магазин');
      expect(m.map((p) => p.id).sort()).toEqual([a, b].sort());
    });

    it('чужие продукты не находятся ничем — ни именем, ни идентификатором', async () => {
      const alien = await mkProduct({ user: ALIEN, name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect(await svc.resolve(OWNER, 'магазин')).toEqual([]);
      expect(await svc.resolve(OWNER, alien)).toEqual([]);
      expect(await svc.resolve(OWNER, 'flowers')).toEqual([]);
    });

    it('архивированные не находятся', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [id]);
      const svc = new ProductToolService(pg as any, {} as any);
      expect(await svc.resolve(OWNER, 'магазин')).toEqual([]);
    });

    // Без экранирования '%' пользовательский поиск «100%» превращается в
    // LIKE '%100\%%' → совпадает со ВСЕМ, и ассистент получает «неоднозначно»
    // на пустом месте. То же с '_' — он в LIKE значит «любой один символ».
    it('проценты и подчёркивания в запросе — обычные символы', async () => {
      await mkProduct({ name: 'Скидки 100% на всё', slug: 'sale' });
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect((await svc.resolve(OWNER, '100%')).map((p) => p.name)).toEqual(['Скидки 100% на всё']);
      expect(await svc.resolve(OWNER, 'м_газин')).toEqual([]);
    });

    it('пустой запрос не ищет ничего', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      expect(await svc.resolve(OWNER, '   ')).toEqual([]);
    });
  });
});

describe('разбор исхода хода', () => {
  it('done — сделано, с расходом', () => {
    const d = describeTurn({ id: 't1', status: 'done', result: 'Добавил раздел', error: null, tokens_spent: 4200 });
    expect(d.outcome).toBe('done');
    expect(d.ok).toBe(true);
    expect(d.tokensSpent).toBe(4200);
  });

  // Главная опасность работы. ok:false — не украшение: контроллер MCP
  // выставляет isError по !ok, то есть модель видит откат как неуспех, а не
  // как результат с грустным текстом, который легко пересказать «готово».
  it('reverted — ОТКАТ, и это НЕ успех', () => {
    const d = describeTurn({ id: 't2', status: 'reverted', result: null, error: 'health check failed', tokens_spent: 0 });
    expect(d.outcome).toBe('reverted');
    expect(d.ok).toBe(false);
  });

  it('failed — не сделано', () => {
    const d = describeTurn({ id: 't3', status: 'failed', result: null, error: 'build error', tokens_spent: 0 });
    expect(d.outcome).toBe('failed');
    expect(d.ok).toBe(false);
  });

  it('три конца различимы между собой', () => {
    const outs = ['done', 'reverted', 'failed'].map((s) =>
      describeTurn({ id: 'x', status: s, result: null, error: null, tokens_spent: 0 }).outcome,
    );
    expect(new Set(outs).size).toBe(3);
  });

  // «Не дошло» — это ход, который продукт не забрал. Отдельно от running:
  // running значит «работают», queued значит «никто не взял», и это разные
  // новости для человека.
  it('queued и running — разные незаконченные состояния', () => {
    expect(describeTurn({ id: 'x', status: 'queued', result: null, error: null, tokens_spent: 0 }).outcome).toBe('queued');
    expect(describeTurn({ id: 'x', status: 'running', result: null, error: null, tokens_spent: 0 }).outcome).toBe('running');
  });

  it('незаконченный ход не объявляется ни успехом, ни провалом', () => {
    for (const s of ['queued', 'running']) {
      const d = describeTurn({ id: 'x', status: s, result: null, error: null, tokens_spent: 0 });
      expect(d.ok).toBe(true);
      expect(d.finished).toBe(false);
    }
  });

  it('законченные помечены finished', () => {
    for (const s of ['done', 'reverted', 'failed']) {
      expect(describeTurn({ id: 'x', status: s, result: null, error: null, tokens_spent: 0 }).finished).toBe(true);
    }
  });

  // count(*) и bigint приезжают из node-pg СТРОКОЙ. Без явного Number()
  // расход склеился бы строкой при сложении, а '0' прошёл бы как истинный.
  it('расход приходит строкой из драйвера и становится числом', () => {
    const d = describeTurn({ id: 'x', status: 'done', result: null, error: null, tokens_spent: '4200' as any });
    expect(d.tokensSpent).toBe(4200);
    expect(typeof d.tokensSpent).toBe('number');
  });
});
