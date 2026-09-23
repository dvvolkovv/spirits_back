import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import { MIGRATIONS } from './products.service';
import { ProductToolService, describeTurn } from './product-tool.service';
import { TurnsService, SLEEPING_REFUSAL, BLOCKED_REFUSAL } from './turns.service';
import { PRODUCT_TOOL_WAIT_MS } from '../common/relay-budget';

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

  describe('действие list', () => {
    it('показывает свои продукты с адресом и состоянием', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers', domain: 'flowers.p.linkeon.io' });
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.ok).toBe(true);
      expect(out.products).toHaveLength(1);
      expect(out.products[0]).toMatchObject({
        name: 'Магазин цветов', domain: 'flowers.p.linkeon.io', status: 'running', kind: 'site',
      });
    });

    it('чужих продуктов не видно', async () => {
      await mkProduct({ user: ALIEN, name: 'Чужой магазин', slug: 'alien' });
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.products).toEqual([]);
    });

    // У бота домена нет вовсе: create() пишет domain только сайтам. Подсказка
    // обязана это учитывать, иначе ассистент скажет «адрес не указан» как про
    // поломку.
    it('у бота домена нет, и это сказано словами', async () => {
      await mkProduct({ name: 'Бот поддержки', slug: 'supbot', kind: 'bot', domain: null });
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.products[0].domain).toBeNull();
      expect(out.say).toMatch(/бот/i);
    });

    it('пустой список — это не ошибка', async () => {
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.ok).toBe(true);
      expect(out.products).toEqual([]);
      expect(out.say).toMatch(/нет|ни одного/i);
    });

    it('архивированные не показываются', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [id]);
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.products).toEqual([]);
    });

    // Порядок — часть ответа: ассистент пересказывает список как есть, и
    // «первый» в его фразе обязан быть самым свежим, а не тем, что Postgres
    // вернул из кучи. Без ORDER BY порядок не определён вовсе.
    //
    // ПОРЯДОК ВСТАВКИ НАРОЧНО НЕ СОВПАДАЕТ С ХРОНОЛОГИЧЕСКИМ. Первая редакция
    // этого теста вставляла продукты по возрастанию created_at и была ЛОЖНЫМ
    // сторожем: измерено пробником — со снятым ORDER BY база вернула ровно тот
    // же порядок, что и с ним (4,3,2,1,0), потому что физический порядок кучи
    // случайно совпал с нужным. Тест зеленел при полностью снятой защите.
    //
    // Здесь вставка идёт вперемешку (2,0,4,1,3), поэтому ни физический порядок,
    // ни обратный ему на ответ не похожи, и сортировку подменить нечем.
    it('свежие продукты идут первыми', async () => {
      const byAge: Record<number, string> = {};
      // Часы «назад»: индекс 0 — самый старый, 4 — самый свежий.
      for (const i of [2, 0, 4, 1, 3]) {
        const r = await pool.query(
          `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, created_at)
           VALUES ($1, $2, $3, 'site', 'running', $4, $5, now() - ($6 || ' hour')::interval)
           RETURNING id`,
          [OWNER, `Магазин ${i}`, `shop${i}`, `/srv/shop${i}`, `hash-shop${i}`, String(5 - i)],
        );
        byAge[i] = r.rows[0].id;
      }
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'list' });
      expect(out.products.map((p: any) => p.id)).toEqual([4, 3, 2, 1, 0].map((i) => byAge[i]));
    });

    it('неизвестное действие — отказ, а не молчание', async () => {
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'delete' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('bad_action');
    });
  });

  describe('действие edit', () => {
    /** Настоящий TurnsService на том же пуле: заглушка не исполняет предусловия. */
    const realTurns = (balanceOk = true) =>
      new TurnsService(pg as any, {
        checkTokenBalance: async () => ({ ok: balanceOk }),
        deductTokens: async (_u: string, n: number) => n,
      } as any);

    it('потолок ожидания взят из общей константы, а не выбран свой', () => {
      const svc = new ProductToolService(pg as any, {} as any);
      expect((svc as any).waitMs).toBe(PRODUCT_TOOL_WAIT_MS);
    });

    it('ставит ровно ОДИН ход', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      (svc as any).waitMs = 0; // не ждём исхода — здесь проверяется постановка
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'Добавь раздел «О нас»' });
      expect(out.turnId).toBeTruthy();
      const n = await pool.query('SELECT count(*) FROM product_turns');
      expect(Number(n.rows[0].count)).toBe(1);
    });

    it('текст правки доезжает до хода дословно', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      (svc as any).waitMs = 0;
      await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'Добавь раздел «О нас»' });
      const r = await pool.query('SELECT prompt, channel FROM product_turns');
      expect(r.rows[0].prompt).toBe('Добавь раздел «О нас»');
      expect(r.rows[0].channel).toBe('web');
    });

    it('два магазина на «магазин» — УТОЧНЯЕТ, а не выбирает', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await mkProduct({ name: 'Магазин книг', slug: 'books' });
      const svc = new ProductToolService(pg as any, realTurns());
      // Потолок в ноль не ради скорости зелёного прогона — ради ВНЯТНОСТИ
      // красного. Измерено: со снятой веткой уточнения тест уходит в боевое
      // ожидание (150 с), умирает на таймауте jest в 60 с и рапортует
      // «timeout» вместо «поставлен ход, которого быть не должно». Сюда
      // ожидание не доходит вовсе, если ветка на месте.
      (svc as any).waitMs = 0;
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'магазин', prompt: 'что-нибудь' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('ambiguous');
      expect(out.matches).toHaveLength(2);
      const n = await pool.query('SELECT count(*) FROM product_turns');
      expect(Number(n.rows[0].count)).toBe(0); // ход НЕ поставлен
    });

    it('не нашли — отказ со списком того, что есть', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'кофейня', prompt: 'что-нибудь' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('not_found');
      expect(out.products).toHaveLength(1);
    });

    it('чужой продукт по его идентификатору — не найден', async () => {
      const alien = await mkProduct({ user: ALIEN, name: 'Чужой магазин', slug: 'alien' });
      const svc = new ProductToolService(pg as any, realTurns());
      const out: any = await svc.execute(OWNER, { action: 'edit', product: alien, prompt: 'сломай' });
      expect(out.reason).toBe('not_found');
      const n = await pool.query('SELECT count(*) FROM product_turns');
      expect(Number(n.rows[0].count)).toBe(0);
    });

    it('без текста правки ход не ставится', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      // Потолок в ноль — ради ВНЯТНОСТИ красного, тем же приёмом, что в тесте
      // про уточнение. Измерено: со снятым .trim() ход ставится, тест уходит в
      // боевое ожидание (150 с) и умирает на таймауте jest в 60 с, рапортуя
      // «Exceeded timeout» вместо «поставлен ход, которого быть не должно».
      (svc as any).waitMs = 0;
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: '  ' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('no_prompt');
      const n = await pool.query('SELECT count(*) FROM product_turns');
      expect(Number(n.rows[0].count)).toBe(0);
    });

    it('спящий — отказ С предложением пополнить', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers', status: 'sleeping' });
      const svc = new ProductToolService(pg as any, realTurns());
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'правка' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('sleeping');
      expect(out.canTopUp).toBe(true);
      expect(out.say).toContain(SLEEPING_REFUSAL);
    });

    it('погашенный — отказ БЕЗ предложения пополнить', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers', status: 'blocked' });
      const svc = new ProductToolService(pg as any, realTurns());
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'правка' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('blocked');
      expect(out.canTopUp).toBe(false);
      expect(out.say).toContain(BLOCKED_REFUSAL);
    });

    it('спящий и погашенный различимы по признаку пополнения', async () => {
      await mkProduct({ name: 'Спящий', slug: 'a', status: 'sleeping' });
      await mkProduct({ name: 'Погашенный', slug: 'b', status: 'blocked' });
      const svc = new ProductToolService(pg as any, realTurns());
      const s: any = await svc.execute(OWNER, { action: 'edit', product: 'спящий', prompt: 'x' });
      const b: any = await svc.execute(OWNER, { action: 'edit', product: 'погашенный', prompt: 'x' });
      expect(s.reason).not.toBe(b.reason);
      expect(s.canTopUp).not.toBe(b.canTopUp);
    });

    it('нет токенов — свой отказ, не слитый со спящим', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns(false));
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'правка' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('no_tokens');
      expect(out.canTopUp).toBe(true);
    });

    it('агент уже занят — отказ, второй ход не ставится', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status)
         VALUES ($1, $2, 'web', 'первая', 'running')`,
        [id, OWNER],
      );
      const svc = new ProductToolService(pg as any, realTurns());
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'вторая' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('busy');
      const n = await pool.query('SELECT count(*) FROM product_turns');
      expect(Number(n.rows[0].count)).toBe(1);
    });

    it('дождался конца — отдаёт исход хода, а не «поставлено»', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      (svc as any).waitMs = 4_000;
      (svc as any).pollMs = 100;
      // Пока инструмент ждёт, «раннер» дописывает ход как откат.
      setTimeout(() => {
        pool.query(
          `UPDATE product_turns SET status = 'reverted', error = 'health check failed', finished_at = now()
            WHERE product_id = $1`,
          [id],
        );
      }, 300);
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'правка' });
      expect(out.outcome).toBe('reverted');
      expect(out.ok).toBe(false);
    });

    it('не дождался — честное «идёт» с идентификатором хода', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, realTurns());
      (svc as any).waitMs = 300;
      (svc as any).pollMs = 100;
      const out: any = await svc.execute(OWNER, { action: 'edit', product: 'цветов', prompt: 'правка' });
      expect(out.finished).toBe(false);
      expect(out.outcome).toBe('queued');
      expect(out.turnId).toBeTruthy();
      expect(out.say).toMatch(/status/);
    });
  });

  describe('действие status', () => {
    it('по продукту отдаёт исход последнего хода', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, result, tokens_spent, finished_at)
         VALUES ($1, $2, 'web', 'правка', 'done', 'Готово', 4200, now())`,
        [id, OWNER],
      );
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', product: 'цветов' });
      expect(out.outcome).toBe('done');
      expect(out.tokensSpent).toBe(4200);
    });

    it('откат в истории остаётся откатом', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, error, finished_at)
         VALUES ($1, $2, 'web', 'правка', 'reverted', 'health check failed', now())`,
        [id, OWNER],
      );
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', product: 'цветов' });
      expect(out.outcome).toBe('reverted');
      expect(out.ok).toBe(false);
    });

    it('берёт САМЫЙ СВЕЖИЙ ход, а не первый попавшийся', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, finished_at, created_at)
         VALUES ($1, $2, 'web', 'старая', 'done', now() - interval '2 hour', now() - interval '2 hour')`,
        [id, OWNER],
      );
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, error, finished_at, created_at)
         VALUES ($1, $2, 'web', 'свежая', 'failed', 'build error', now(), now())`,
        [id, OWNER],
      );
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', product: 'цветов' });
      expect(out.outcome).toBe('failed');
    });

    it('по идентификатору хода — тот самый ход', async () => {
      const id = await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const t = await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, finished_at)
         VALUES ($1, $2, 'web', 'старая', 'done', now()) RETURNING id`,
        [id, OWNER],
      );
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, error, finished_at)
         VALUES ($1, $2, 'web', 'свежая', 'failed', 'build error', now())`,
        [id, OWNER],
      );
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', turnId: t.rows[0].id });
      expect(out.outcome).toBe('done');
    });

    it('чужой ход по его идентификатору не отдаётся', async () => {
      const alien = await mkProduct({ user: ALIEN, name: 'Чужой', slug: 'alien' });
      const t = await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, finished_at)
         VALUES ($1, $2, 'web', 'чужая', 'done', now()) RETURNING id`,
        [alien, ALIEN],
      );
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', turnId: t.rows[0].id });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('not_found');
    });

    it('ходов не было — так и сказано', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', product: 'цветов' });
      expect(out.reason).toBe('no_turns');
      expect(out.say).toMatch(/не было|ни одной/i);
    });

    it('неоднозначное имя — уточняет, а не выбирает', async () => {
      await mkProduct({ name: 'Магазин цветов', slug: 'flowers' });
      await mkProduct({ name: 'Магазин книг', slug: 'books' });
      const svc = new ProductToolService(pg as any, {} as any);
      const out: any = await svc.execute(OWNER, { action: 'status', product: 'магазин' });
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('ambiguous');
      expect(out.matches).toHaveLength(2);
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
