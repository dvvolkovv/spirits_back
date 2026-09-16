import { ConflictException, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { ProductsService } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { SecretsService } from './secrets.service';

/**
 * ЕДИНСТВЕННЫЙ ФАЙЛ В ЭТОМ КАТАЛОГЕ, ГДЕ SQL ИСПОЛНЯЕТСЯ.
 *
 * Остальные три спеки подменяют pg целиком и потому сторожат ФОРМУ запроса:
 * подстроку, алиас, порядок параметров. За шесть задач накопилось пять мест,
 * где форма сохранена, а поведение разошлось, и каждое было найдено разовым
 * ручным прогоном на живой базе — то есть не закреплено ничем. Этот файл
 * закрепляет их исполнением.
 *
 * Два образца того, что мимо моков проходит зелёным:
 *
 *   - `claimed ... RETURNING id AS product_id` вместо настоящего product_id.
 *     Регексп-сторож совпадает, 208 юнит-тестов зелёные, а на живой базе
 *     задание уезжает в running, CTE issued не находит продукт, claimJob
 *     возвращает «очередь пуста» — и продукт заперт навсегда, без строки в
 *     логе. Глубже: PostgreSQL не исполняет CTE, на который никто не
 *     ссылается, поэтому FOR UPDATE SKIP LOCKED исчезает из плана вместе с
 *     ним. Блокировку держит ССЫЛКА между частями запроса, а не текст.
 *
 *   - `UPDATE products ... FROM closed WHERE products.id = closed.product_id
 *     OR TRUE`. Это соединение, а не поиск по ключу: `OR TRUE` регексп
 *     переживает, а один отчёт агента хоронит ВЕСЬ реестр, включая
 *     непричастные продукты. Ровно поэтому в фикстурах completeJob обязан
 *     лежать посторонний продукт — без него мутация невидима.
 *
 * ИЗМЕРЕНО МУТАЦИЯМИ (PostgreSQL 16, тестовая нода). Каждая строка ниже —
 * правка provisioning.service.ts, которая СОХРАНЯЕТ ФОРМУ: 208 юнит-тестов
 * остаются зелёными, краснеет только этот файл.
 *
 *   claimed RETURNING `id AS product_id`        → 1, 2, 3, 4, 7
 *   completeJob: `... OR TRUE` в соединении     → 12
 *   замок `WHERE product_id = $1`               → 12, 14, 15, 16
 *   EXISTS в claimJob без сверки продукта       → 5
 *   таймаут, ветка 1: нет условия соединения    → 8
 *   таймаут, ветка 2: NOT EXISTS без корреляции → 9
 *   фолбэк на p.created_at обесценен            → 9
 *   подзапрос срока скоррелирован по j.id       → 10
 *   picked становится неиспользуемым CTE        → 3, 4, 5
 *
 * Две правки из плана — снять фолбэк `COALESCE(..., p.created_at)` и
 * переставить его операнды — краснят ОБА прогона: provisioning.promote.spec.ts
 * пришпиливает это выражение регекспом целиком. Их поведенческие двойники,
 * которые регексп переживают, в списке выше (последние две строки).
 *
 * ПРО ПРИБОР. Сторож «заведомо невалидный TypeScript» здесь бесполезен и
 * молча зелен: tsconfig.json ставит isolatedModules, ts-jest работает
 * транспайлером и типы не проверяет ВООБЩЕ (измерено: `const x: number =
 * 'строка'` не краснит ни одного теста). Рабочие сторожа — неразбор исходника
 * и заведомо сломанное поведение; первый, кстати, даёт
 * `Tests: 107 passed, 107 total` при 224 в чистом прогоне: строка полностью
 * зелёная, красное видно только в `Test Suites:` и в упавшем ИТОГЕ.
 *
 * ГДЕ ПРОВЕРЯЮТСЯ ТИПЫ. Гейт — `npx nest build` (он же `npm run build`, он же
 * шаг деплоя), а НЕ `npx tsc --noEmit`. Разница не формальная:
 *   - `tsc --noEmit` берёт tsconfig.json, то есть вместе со спеками, и на
 *     чистом дереве даёт шесть ошибок, пять из них в спеках. Как гейт он
 *     бесполезен — красный всегда, новая ошибка тонет в старых;
 *   - `nest build` берёт tsconfig.build.json, где спеки исключены шаблоном
 *     проверяет ровно прод-код.
 * На этой задаче гейт был КРАСНЫМ: `typeof fetch` в provisioning.service.ts
 * давал TS2556 и rc=1 (починено там же, см. комментарий у fetchFn). Деплой
 * этого не замечал: `npm run build 2>&1 | tail -3` под `set -e` без `pipefail`
 * отдаёт код возврата `tail`, а не сборки.
 *
 * КАК ГОНЯТЬ. База обязана быть ОДНОРАЗОВОЙ — beforeEach делает TRUNCATE и
 * адрес не разбирает (см. гард на непустую базу в beforeAll):
 *
 *   sudo -u postgres psql -c "CREATE ROLE provint LOGIN PASSWORD 'provint';" \
 *                        -c "CREATE DATABASE provint OWNER provint;"
 *   PROVISIONING_PG_URL=postgres://provint:provint@127.0.0.1:5432/provint \
 *     npx jest --testPathIgnorePatterns=/node_modules/ \
 *              --testPathPattern='src/products/provisioning.integration'
 *   sudo -u postgres psql -c "DROP DATABASE provint;" -c "DROP ROLE provint;"
 *
 * ЧЕГО ЗДЕСЬ НЕТ. `FOR UPDATE SKIP LOCKED` не измеряется ОДНОВРЕМЕННЫМИ
 * claim — и это не придирка, а измерение: со снятым SKIP LOCKED пятёрка
 * параллельных claim оставляет файл зелёным. Причина в том, что каждый claim —
 * ОДИН оператор, то есть транзакция длиной в себя самого: ожидающий получает
 * лок на микросекунды, потом EvalPlanQual перечитывает строку, видит
 * status='running' и уходит ни с чем. Победитель ровно один в обоих случаях.
 *
 * Держит лок, однако, не обязательно наш же claim. Сценарий 4б берёт на строку
 * задания ПОСТОРОННИЙ `SELECT ... FOR UPDATE` в отдельной транзакции и держит
 * его две секунды. Измерено: со SKIP LOCKED claim возвращается за 10 мс с
 * null, без него — ждёт 2004 мс и забирает задание. Детерминированно, без
 * гонок.
 */

// Без адреса базы файл пропускается целиком, чтобы обычный прогон не требовал
// Postgres. На тестовой ноде отрабатывает за секунды.
const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

// Ключ из secrets.spec.ts: НЕоднородный намеренно — на 'a'.repeat(64)
// выживала мутация «ключ из первой половины hex дважды».
const KEY = '00112233445566778899aabbccddeeff0f1e2d3c4b5a69788796a5b4c3d2e1f0';

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

maybe('провижининг против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  /**
   * Сервис требует от pg ровно `query(sql, params)` — вот тонкая обёртка над
   * настоящим драйвером. Именно Pool, а не один Client: половина сценариев
   * ниже про ОДНОВРЕМЕННЫЕ запросы, а на одном соединении они выстроились бы
   * в очередь и все гонки выродились бы в последовательность.
   */
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };
  let secrets: SecretsService;

  const makeSvc = (probe?: (url: string, init?: any) => Promise<{ status: number }>) => {
    const svc = new ProvisioningService(pg as any, secrets);
    (svc as any).fetchFn = probe ?? (async () => ({ status: 200 }));
    return svc;
  };

  /** Заглушённый логгер плюс доступ к его вызовам: rowCount виден только там. */
  const watchLog = (svc: ProvisioningService) => ({
    warn: jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 16 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    secrets = new SecretsService({
      get: (k: string) => (k === 'PRODUCT_SECRETS_KEY' ? KEY : undefined),
    } as any);
    // Схема накатывается ТЕМИ ЖЕ файлами, что и в проде. Переписанный руками
    // DDL разъехался бы с миграциями молча, и файл проверял бы выдуманную базу.
    for (const f of ['001_products.sql', '002_provisioning.sql']) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }
    // ГАРД НА ЧУЖУЮ БАЗУ. beforeEach делает TRUNCATE и адрес не разбирает, а
    // на той же тестовой ноде живёт база стенда test.linkeon.io, где эти три
    // таблицы уже созданы: один PROVISIONING_PG_URL, скопированный не из той
    // строки, стирает продукты и ходы стенда без единого вопроса. Сегодня цена
    // нулевая (таблицы стенда пусты), но живые продукты там появятся, и тогда
    // эта проверка будет единственным, что стоит между прогоном и стендом.
    // Считается ДО первого TRUNCATE и только один раз — дальше таблицу
    // наполняем мы сами.
    const n = await pool.query('SELECT count(*) FROM products');
    if (Number(n.rows[0].count) > 0) {
      throw new Error(
        'PROVISIONING_PG_URL указывает на НЕпустую базу — нужна одноразовая, ' +
          'иначе TRUNCATE в beforeEach сотрёт чужие продукты (рецепт — в шапке файла)',
      );
    }
  });

  afterAll(async () => {
    // ЗА СОБОЙ УБИРАЕМ. beforeAll требует ПУСТУЮ таблицу (гард на чужую базу),
    // а фикстуры последнего сценария остаются в базе — то есть без этой
    // уборки ВТОРОЙ прогон в той же одноразовой базе красный всегда, и красный
    // целиком: падает beforeAll, а с ним все 33 теста. На первой же батарее
    // мутаций это выглядело как идеальная ловля — прибор врал, а не сторожил.
    await pool?.query(
      'TRUNCATE products, product_provision_jobs, product_turns RESTART IDENTITY CASCADE',
    );
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE products, product_provision_jobs, product_turns RESTART IDENTITY CASCADE',
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ——— фикстуры ———

  let seq = 0;

  type Seed = {
    slug?: string;
    /** По умолчанию своё у каждого продукта: имя не должно совпадать ни со
     *  слагом, ни с именем соседа — иначе перепутанные строки неразличимы. */
    name?: string;
    kind?: 'site' | 'bot';
    status?: string;
    port?: number | null;
    /** Интервал ДО now(); по умолчанию продукт только что создан. */
    createdAgo?: string;
    /** null — раннер не выходил на связь ни разу. */
    seenAgo?: string | null;
    secrets?: Record<string, string> | null;
  };

  async function product(o: Seed = {}) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `p-${seq++}`;
    const name = o.name ?? `имя ${slug}`;
    const box = o.secrets ? secrets.encrypt(o.secrets, id) : null;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path,
                             runner_token_hash, secrets_encrypted, port,
                             runner_seen_at, created_at)
       VALUES ($1, 'u-1', $10, $2, $3, $4, '/product', $5, $6, $7,
               CASE WHEN $8::text IS NULL THEN NULL ELSE now() - $8::interval END,
               now() - $9::interval)`,
      [
        id,
        slug,
        o.kind ?? 'site',
        o.status ?? 'provisioning',
        // Стартовый хеш у каждого продукта СВОЙ: колонка UNIQUE, а сценарии
        // ниже отличают «хеш повернулся» от «остался прежним».
        crypto.randomBytes(32).toString('hex'),
        box,
        o.port ?? null,
        o.seenAgo ?? null,
        o.createdAgo ?? '1 second',
        name,
      ],
    );
    return { id, slug, name };
  }

  type JobSeed = {
    status?: string;
    createdAgo?: string;
    startedAgo?: string | null;
    finishedAgo?: string | null;
    error?: string | null;
  };

  async function job(productId: string, o: JobSeed = {}) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO product_provision_jobs (id, product_id, status, error, created_at, started_at, finished_at)
       VALUES ($1, $2, $3, $4, now() - $5::interval,
               CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::interval END,
               CASE WHEN $7::text IS NULL THEN NULL ELSE now() - $7::interval END)`,
      [
        id,
        productId,
        o.status ?? 'queued',
        o.error ?? null,
        o.createdAgo ?? '1 second',
        o.startedAgo ?? null,
        o.finishedAgo ?? null,
      ],
    );
    return id;
  }

  const getProduct = async (id: string) =>
    (await pool.query('SELECT * FROM products WHERE id = $1', [id])).rows[0];
  const getJob = async (id: string) =>
    (await pool.query('SELECT * FROM product_provision_jobs WHERE id = $1', [id])).rows[0];

  /**
   * ПОСТОРОННИЙ ПРОДУКТ. Работающий, с портом, без ошибок — ни в одном
   * сценарии не участвует и обязан остаться нетронутым. Без него мутация
   * «соединение без условия» (`... OR TRUE`) невидима: в базе с одним
   * продуктом соединение по ключу и соединение по всему дают одну и ту же
   * строку.
   */
  async function bystander() {
    const p = await product({ slug: `bystander-${seq++}`, status: 'running', port: 9999 });
    await job(p.id, { status: 'done', startedAgo: '2 hours', finishedAgo: '2 hours' });
    // Снимок ВСЕЙ строки, а не трёх интересных колонок: перечисление колонок
    // проверяет ровно то, о чём автор уже подумал, и пропускает остальное.
    // Живой пример — runner_token_hash: мутация, отдающая хеш не тому
    // продукту, списком status/port/provision_error не ловится вообще.
    return { ...p, row: await getProduct(p.id) };
  }

  async function expectUntouched(p: { id: string; row: any }) {
    expect(await getProduct(p.id)).toEqual(p.row);
  }

  // ═══════════════════════════ claimJob ═══════════════════════════

  it('1. запрос выдачи исполняется, и каждое поле приезжает своим именем', async () => {
    // Мок отдаёт свою строку независимо от того, что перечислено в RETURNING,
    // поэтому потеря алиаса `AS box` была невидима всему job.spec: колонка
    // приезжала бы как secrets_encrypted, row.box стал бы undefined, и бот
    // уехал бы в контейнер БЕЗ ТОКЕНА — молча, с успешным заведением.
    // Расшифровка сходится только если box действительно Buffer из bytea и
    // только если product_id тот самый (он же AAD).
    const other = await bystander();
    const p = await product({ slug: 'claim-one', kind: 'bot', secrets: { BOT_TOKEN: '123:abc' } });
    const j = await job(p.id);

    const claimed = await makeSvc().claimJob();

    expect(claimed).not.toBeNull();
    expect(claimed).toEqual({
      jobId: j,
      productId: p.id,
      slug: 'claim-one',
      // Имя приезжает из НАСТОЯЩЕЙ колонки и отличается от слага: агент несёт
      // его в каркас продукта, и забытая колонка в CTE issued дала бы
      // undefined в заголовке сайта или в имени бота.
      name: 'имя claim-one',
      kind: 'bot',
      runnerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      secrets: { BOT_TOKEN: '123:abc' },
    });
    expect(Buffer.isBuffer((await getProduct(p.id)).secrets_encrypted)).toBe(true);

    const after = await getJob(j);
    expect(after.status).toBe('running');
    expect(after.started_at).toBeInstanceOf(Date);
    // Хеш повернулся ИМЕННО у продукта выданного задания.
    expect((await getProduct(p.id)).runner_token_hash).toBe(sha(claimed!.runnerToken));
    await expectUntouched(other);
  });

  it('2. очередь разбирается с головы: пять claim подряд идут по created_at', async () => {
    // `ORDER BY created_at DESC` — это LIFO: первый заведённый продукт при
    // непрерывном потоке не дожидается никогда. Форму сторожит job.spec,
    // здесь проверяется, что порядок действительно такой на живой сортировке.
    const slugs = ['fifo-0', 'fifo-1', 'fifo-2', 'fifo-3', 'fifo-4'];
    for (let i = 0; i < slugs.length; i++) {
      const p = await product({ slug: slugs[i] });
      await job(p.id, { createdAgo: `${(slugs.length - i) * 10} seconds` });
    }
    const svc = makeSvc();

    const got: string[] = [];
    for (let i = 0; i < slugs.length; i++) got.push((await svc.claimJob())!.slug);

    expect(got).toEqual(slugs);
    expect(await svc.claimJob()).toBeNull();
  });

  it('3. пять ОДНОВРЕМЕННЫХ claim на пять заданий расходятся по разным продуктам', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      const p = await product({ slug: `race5-${i}` });
      await job(p.id);
      made.push(p);
    }
    const svc = makeSvc();

    const claims = await Promise.all([0, 1, 2, 3, 4].map(() => svc.claimJob()));

    expect(claims.filter(Boolean)).toHaveLength(5);
    expect(new Set(claims.map((c) => c!.productId)).size).toBe(5);
    expect(new Set(claims.map((c) => c!.jobId)).size).toBe(5);
    const hashes = claims.map((c) => sha(c!.runnerToken));
    expect(new Set(hashes).size).toBe(5);
    // Ровно пять продуктов носят новый хеш, и это именно те пять.
    const withHash = await pool.query(
      'SELECT id FROM products WHERE runner_token_hash = ANY($1::text[]) ORDER BY id',
      [hashes],
    );
    expect(withHash.rows.map((r: any) => r.id).sort()).toEqual(made.map((p) => p.id).sort());
  });

  it('4а. пять ОДНОВРЕМЕННЫХ claim на одно задание дают ровно одного победителя', async () => {
    // Задание, доставшееся двоим, означало бы два развёртывания в один
    // каталог.
    //
    // ЭТОТ сценарий про SKIP LOCKED ничего не говорит — измерено: со снятым
    // SKIP LOCKED он остаётся зелёным. Победитель тут один по другой причине
    // (EvalPlanQual, см. шапку). Про SKIP LOCKED — 4б.
    const other = await bystander();
    const p = await product({ slug: 'race1' });
    const j = await job(p.id);
    const svc = makeSvc();

    const claims = await Promise.all([0, 1, 2, 3, 4].map(() => svc.claimJob()));

    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.jobId).toBe(j);
    expect((await getJob(j)).status).toBe('running');
    // Ровно ОДИН продукт получил новый хеш — и это хеш победителя.
    const withHash = await pool.query(
      'SELECT id, runner_token_hash FROM products WHERE runner_token_hash = $1',
      [sha(winners[0]!.runnerToken)],
    );
    expect(withHash.rows).toHaveLength(1);
    expect(withHash.rows[0].id).toBe(p.id);
    await expectUntouched(other);
  });

  it('4б. задание, залоченное ПОСТОРОННИМ, пропускается, а не ждёт его', async () => {
    // Единственное место, где SKIP LOCKED вообще наблюдаем. Одновременными
    // claim его не поймать (см. 4а и шапку), но лок держит не обязательно наш
    // же claim: у соседнего инстанса это может быть административный запрос,
    // ручной psql, долгая транзакция миграции.
    //
    // Измерено обеими сторонами: со `FOR UPDATE SKIP LOCKED` — 10 мс и null;
    // с голым `FOR UPDATE` — 2004 мс ожидания и задание ЗАХВАЧЕНО, то есть
    // выдача встаёт колом ровно на столько, сколько посторонний держит строку.
    // Детерминированно и без гонок: держатель берёт лок ДО claim.
    const p = await product({ slug: 'foreign-lock' });
    const j = await job(p.id);

    // СВОЁ соединение: лок живёт в транзакции, а не в пуле.
    const holder = await pool.connect();
    let released = false;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM product_provision_jobs WHERE id = $1 FOR UPDATE', [j]);
      // Отпускаем через 2 секунды и НЕ дожидаясь claim: если claim встанет в
      // очередь за локом, он всё-таки дождётся — и тест увидит это по времени
      // и по захваченному заданию, а не повиснет навсегда.
      const unlock = new Promise<void>((r) =>
        setTimeout(async () => {
          await holder.query('ROLLBACK');
          released = true;
          r();
        }, 2000),
      );

      const started = Date.now();
      const claimed = await makeSvc().claimJob();
      const elapsed = Date.now() - started;

      expect(claimed).toBeNull();
      // Ни времени ожидания, ни следов захвата: задание осталось в очереди и
      // достанется следующему обороту, когда посторонний отпустит строку.
      expect(elapsed).toBeLessThan(1000);
      expect(released).toBe(false);
      expect((await getJob(j)).status).toBe('queued');
      expect((await getJob(j)).started_at).toBeNull();

      await unlock;
      // Отпущенное задание снова выдаётся — пропуск был временным, а не
      // потерей задания.
      expect((await makeSvc().claimJob())!.jobId).toBe(j);
    } finally {
      if (!released) await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('5. claim на пустой очереди не оставляет свой хеш ни у одного продукта', async () => {
    // Токен считается ДО запроса, чтобы всё уместилось в один оператор,
    // поэтому слово runner_token_hash в SQL есть всегда. Записи при этом
    // происходить не должно: CTE issued обновляет только строки из claimed, а
    // claimed пуста. Мок этого не различает вовсе.
    // Продукт в provisioning БЕЗ задания нужен именно здесь: без него EXISTS,
    // потерявший сверку `p.id = j.product_id`, остался бы ложным и мутация
    // была бы невидима. С ним он истинен — и задание похороненного продукта
    // уезжает агенту.
    await product({ slug: 'idle-1' });
    const done = await product({ slug: 'idle-2' });
    await job(done.id, { status: 'done', finishedAgo: '1 minute' });
    const dead = await product({ slug: 'idle-3', status: 'failed' });
    await job(dead.id); // queued, но продукт похоронен — выдаче не подлежит
    const before = await pool.query('SELECT id, runner_token_hash FROM products ORDER BY id');

    expect(await makeSvc().claimJob()).toBeNull();

    const after = await pool.query('SELECT id, runner_token_hash FROM products ORDER BY id');
    expect(after.rows).toEqual(before.rows);
    expect(after.rows).toHaveLength(3);
  });

  // ═══════════════════ promoteReady и таймаут ═══════════════════

  it('6. граница свежести heartbeat: 119 секунд — связь, 121 — уже нет', async () => {
    // Здесь проверяются ЖИВЫЕ ТИПЫ: runner_seen_at приезжает из драйвера
    // объектом Date, а не строкой из фикстуры, и heartbeatFresh обязан его
    // понять. Строка ISO из мока прошла бы и через сравнение строк.
    const fresh = await product({ slug: 'hb-fresh', kind: 'bot', seenAgo: '119 seconds' });
    const stale = await product({ slug: 'hb-stale', kind: 'bot', seenAgo: '121 seconds' });

    const seen = await pool.query('SELECT runner_seen_at FROM products WHERE id = $1', [fresh.id]);
    expect(seen.rows[0].runner_seen_at).toBeInstanceOf(Date);

    await expect(makeSvc().promoteReady()).resolves.toBe(1);

    expect((await getProduct(fresh.id)).status).toBe('running');
    expect((await getProduct(stale.id)).status).toBe('provisioning');
  });

  // Сценарий 7 — три ОТДЕЛЬНЫХ теста, а не три фазы в одном. Фазы прятали
  // друг друга: падение первой уносило остальные, и по номеру «7» было не
  // понять, какая из трёх защит снята. Общее у всех трёх — хук в fetchFn,
  // подменяющий состояние РОВНО в окне пробы (между выборкой и записью
  // проходит до PROBE_TIMEOUT_MS, и всё это время состояние меняет кто угодно).
  // Отметка раннера везде СВЕЖАЯ: иначе promoteReady отсеет продукт ещё до
  // пробы, хук не позовётся и «гонка» выродится в проверку heartbeat.

  it('7а. «повторить» нажато во время пробы — продукт не уезжает в running', async () => {
    // Перевод в running отнял бы у claimJob право выдать задание (там EXISTS
    // по p.status = 'provisioning'), и повтор умер бы молча: кнопка нажата,
    // ничего не произошло, ошибки нет нигде.
    const a = await product({ slug: 'race-retry', seenAgo: '10 seconds' });
    let jid = '';

    await expect(
      makeSvc(async () => {
        jid = await job(a.id);
        return { status: 200 };
      }).promoteReady(),
    ).resolves.toBe(0);

    expect((await getProduct(a.id)).status).toBe('provisioning');
    // Главное следствие: задание по-прежнему выдаётся.
    expect((await makeSvc().claimJob())!.jobId).toBe(jid);
  });

  it('7б. таймаут отработал во время пробы — похороненный не воскресает', async () => {
    // Иначе вернувшаяся проба поднимает продукт в running с затёртой
    // причиной, а в логе остаётся «провижининг просрочен» про продукт,
    // который числится рабочим.
    const b = await product({
      slug: 'race-timeout',
      seenAgo: '10 seconds',
      createdAgo: '99 minutes',
    });
    await job(b.id, { status: 'done', startedAgo: '99 minutes', finishedAgo: '98 minutes' });
    const killer = makeSvc();
    watchLog(killer);

    await expect(
      makeSvc(async () => {
        await killer.failStaleProvisioning();
        return { status: 200 };
      }).promoteReady(),
    ).resolves.toBe(0);

    const after = await getProduct(b.id);
    expect(after.status).toBe('failed');
    expect(after.provision_error).toMatch(/раннер на связи/);
  });

  it('7в. продукт архивирован во время пробы — archived_at при running недостижим', async () => {
    const c = await product({ slug: 'race-archive', seenAgo: '10 seconds' });

    await expect(
      makeSvc(async () => {
        await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [c.id]);
        return { status: 200 };
      }).promoteReady(),
    ).resolves.toBe(0);

    expect((await getProduct(c.id)).status).toBe('provisioning');
  });

  it('8. причина различает живого раннера и молчащего — в обеих ветках таймаута', async () => {
    // Перестановка веток CASE означает ровно ту ложь, ради которой CASE и
    // написан: живой раннер получал бы «срок заведения истёк», мёртвый —
    // «агент не отчитался». Мок направление не исполняет, здесь оно
    // считается настоящей трёхзначной логикой (runner_seen_at NULL даёт NULL,
    // а не FALSE, и уходит в ELSE).
    const alive = await product({ slug: 'why-alive', seenAgo: '10 seconds' });
    await job(alive.id, { createdAgo: '99 minutes' });
    const mute = await product({ slug: 'why-mute', seenAgo: null });
    await job(mute.id, { createdAgo: '99 minutes' });
    const closedAlive = await product({
      slug: 'why-closed-alive',
      seenAgo: '10 seconds',
      createdAgo: '99 minutes',
    });
    await job(closedAlive.id, {
      status: 'done',
      startedAgo: '99 minutes',
      finishedAgo: '98 minutes',
    });
    const closedMute = await product({
      slug: 'why-closed-mute',
      seenAgo: '9 days',
      createdAgo: '99 minutes',
    });
    await job(closedMute.id, {
      status: 'done',
      startedAgo: '99 minutes',
      finishedAgo: '98 minutes',
    });
    const svc = makeSvc();
    watchLog(svc);

    await expect(svc.failStaleProvisioning()).resolves.toBe(4);

    expect((await getProduct(alive.id)).provision_error).toBe(
      'агент не отчитался о завершении заведения (срок 10 мин)',
    );
    expect((await getProduct(mute.id)).provision_error).toBe('срок заведения истёк (10 мин)');
    expect((await getProduct(closedAlive.id)).provision_error).toBe(
      'задание закрыто, раннер на связи, но публичный адрес не отвечает',
    );
    expect((await getProduct(closedMute.id)).provision_error).toBe(
      'задание закрыто, продукт не ожил: раннер не выходит на связь',
    );
    // Само зависшее задание снимается, иначе частичный индекс
    // product_provision_jobs_one_active запрещает повтор навсегда.
    const jobs = await pool.query(
      "SELECT status FROM product_provision_jobs WHERE product_id = $1",
      [alive.id],
    );
    expect(jobs.rows[0].status).toBe('failed');
  });

  it('9. продукт ВООБЩЕ без задания: 99 минут хоронится, только что созданный — нет', async () => {
    // create вставляет продукт и задание двумя операторами без транзакции, и
    // смерть процесса между ними оставляет продукт без задания. Без фолбэка
    // COALESCE(..., p.created_at) подзапрос даёт NULL, сравнение даёт NULL, и
    // такой продукт не хоронится НИКОГДА.
    const old = await product({ slug: 'orphan-old', createdAgo: '99 minutes', seenAgo: null });
    const fresh = await product({ slug: 'orphan-new', seenAgo: null });
    // ЧУЖОЕ активное задание. NOT EXISTS во второй ветке обязан быть
    // скоррелирован с ЭТИМ продуктом: без сверки j.product_id = p.id одно
    // чужое задание в очереди запирает весь реестр — ни один продукт больше
    // не хоронится никогда. Форму этого условия в silent-ветке юнит-спека не
    // проверяет вовсе.
    const busy = await product({ slug: 'orphan-busy' });
    await job(busy.id);
    const svc = makeSvc();
    watchLog(svc);

    await expect(svc.failStaleProvisioning()).resolves.toBe(1);

    expect((await getProduct(old.id)).status).toBe('failed');
    expect((await getProduct(old.id)).provision_error).toMatch(/задание закрыто/);
    expect((await getProduct(fresh.id)).status).toBe('provisioning');
    expect((await getProduct(fresh.id)).provision_error).toBeNull();
    expect((await getProduct(busy.id)).status).toBe('provisioning');
  });

  it('10. повтор СТАРОГО продукта с только что закрытым заданием не хоронится', async () => {
    // Продукт девятидневной давности, которому нажали «повторить»: срок
    // обязан считаться по САМОМУ СВЕЖЕМУ заданию, а p.created_at — только
    // фолбэк для продукта совсем без заданий. Переставь операнды COALESCE — и
    // повтор хоронится через секунды после закрытия задания.
    const p = await product({ slug: 'retry-old', createdAgo: '9 days', seenAgo: '10 seconds' });
    await job(p.id, { status: 'failed', createdAgo: '9 days', finishedAgo: '9 days' });
    await job(p.id, { status: 'done', createdAgo: '30 seconds', startedAgo: '20 seconds', finishedAgo: '5 seconds' });
    const svc = makeSvc();
    watchLog(svc);

    await expect(svc.failStaleProvisioning()).resolves.toBe(0);

    expect((await getProduct(p.id)).status).toBe('provisioning');
    expect((await getProduct(p.id)).provision_error).toBeNull();
  });

  // Сценарий 11 — три ОТДЕЛЬНЫХ теста по той же причине, что и 7. Общая
  // посылка: прод запущен в кластерном режиме, число инстансов нигде в
  // репозитории не зафиксировано, и параллельные обороты — одно `pm2 scale` от
  // реальности, без единого предупреждения.

  it('11а. одновременный промоут одного продукта даёт ровно один перевод', async () => {
    const a = await product({ slug: 'two-promote', kind: 'bot', seenAgo: '10 seconds' });

    const promotions = await Promise.all([makeSvc().promoteReady(), makeSvc().promoteReady()]);

    // Сумма, а не «оба по единице»: второй обязан увидеть rowCount 0 и не
    // засчитать перевод, которого не было.
    expect(promotions.reduce((x, y) => x + y, 0)).toBe(1);
    expect((await getProduct(a.id)).status).toBe('running');
  });

  it('11б. промоут с медленной пробой против таймаута даёт согласованное состояние', async () => {
    // Либо продукт переведён и причина снята, либо похоронен и причина
    // записана. «Running с текстом про таймаут» и «failed при promoted = 1» —
    // обе лжи, и обе здесь уже воспроизводились.
    const b = await product({ slug: 'two-race', createdAgo: '99 minutes', seenAgo: '10 seconds' });
    await job(b.id, { status: 'done', startedAgo: '99 minutes', finishedAgo: '98 minutes' });
    const slow = makeSvc(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { status: 200 };
    });
    watchLog(slow);
    const killer = makeSvc();
    watchLog(killer);

    const [promoted, buried] = await Promise.all([
      slow.promoteReady(),
      killer.failStaleProvisioning(),
    ]);

    const after = await getProduct(b.id);
    expect(promoted + buried).toBe(1);
    if (promoted === 1) {
      expect(after.status).toBe('running');
      expect(after.provision_error).toBeNull();
    } else {
      expect(after.status).toBe('failed');
      expect(after.provision_error).toMatch(/раннер на связи/);
    }
  });

  it('11в. два одновременных таймаута хоронят один раз', async () => {
    const c = await product({ slug: 'two-bury', seenAgo: null });
    await job(c.id, { createdAgo: '99 minutes' });
    const s1 = makeSvc();
    const s2 = makeSvc();
    watchLog(s1);
    watchLog(s2);

    const buries = await Promise.all([s1.failStaleProvisioning(), s2.failStaleProvisioning()]);

    expect(buries.reduce((x, y) => x + y, 0)).toBe(1);
    expect((await getProduct(c.id)).status).toBe('failed');
  });

  // ═══════════════════════════ completeJob ═══════════════════════════

  /**
   * САМЫЙ ДОРОГОЙ СЦЕНАРИЙ ФАЙЛА, поэтому он разложен на два пути.
   *
   * `UPDATE products ... FROM closed` — это СОЕДИНЕНИЕ, а не поиск по ключу:
   * убери условие соединения (или допиши `OR TRUE`), и один отчёт агента
   * похоронит весь реестр. Регексп-сторож в job.spec `OR TRUE` переживает, а в
   * базе с ОДНИМ продуктом соединение по ключу и соединение по всему дают одну
   * и ту же строку — поэтому посторонние продукты обязаны лежать в фикстурах.
   *
   * Пути портят реестр ПО-РАЗНОМУ: отказный — статусом и причиной, успешный —
   * портом. Одной фазой их проверять нельзя, подмена в успешном осталась бы за
   * первым падением.
   */
  const untouchedRegistry = async () => ({
    one: await bystander(),
    two: await bystander(),
    idle: await product({ slug: `untouched-${seq++}`, seenAgo: null }),
  });

  it('12а. отказный отчёт правит ТОЛЬКО свой продукт', async () => {
    const reg = await untouchedRegistry();
    const idleBefore = await getProduct(reg.idle.id);
    const p = await product({ slug: 'report-fail', port: 7000 });
    const j = await job(p.id, { status: 'running', startedAgo: '1 minute' });
    const svc = makeSvc();
    const log = watchLog(svc);

    await svc.completeJob(j, { ok: false, error: 'порт занят' });

    expect((await getProduct(p.id)).status).toBe('failed');
    expect((await getProduct(p.id)).provision_error).toBe('порт занят');
    expect((await getJob(j)).status).toBe('failed');
    expect(log.warn).not.toHaveBeenCalled();
    await expectUntouched(reg.one);
    await expectUntouched(reg.two);
    // Продукт в provisioning — отдельный случай: он под отчёт «подходит» по
    // статусу, и соединение без условия хоронит именно его.
    expect(await getProduct(reg.idle.id)).toEqual(idleBefore);
  });

  it('12б. успешный отчёт не раздаёт свой порт всему реестру', async () => {
    const reg = await untouchedRegistry();
    const idleBefore = await getProduct(reg.idle.id);
    const q = await product({ slug: 'report-ok' });
    const jq = await job(q.id, { status: 'running', startedAgo: '1 minute' });
    const svc = makeSvc();
    const log = watchLog(svc);

    await svc.completeJob(jq, { ok: true, port: 8003 });

    expect((await getProduct(q.id)).port).toBe(8003);
    expect((await getJob(jq)).status).toBe('done');
    expect(log.warn).not.toHaveBeenCalled();
    await expectUntouched(reg.one);
    await expectUntouched(reg.two);
    expect(await getProduct(reg.idle.id)).toEqual(idleBefore);
  });

  it('13. повторный отчёт поверх ЖИВОГО продукта не меняет ни статус, ни порт, ни причину', async () => {
    // Ретрай POST-а при обрыве связи воспроизводит это без злоумышленника.
    // Измерено: продукт в running с портом 8003 повторный {ok:false} хоронил
    // в failed, а повторный {ok:true} без порта оставлял без порта.
    const p = await product({ slug: 'already-live', status: 'running', port: 8003 });
    const j = await job(p.id, {
      status: 'done',
      startedAgo: '5 minutes',
      finishedAgo: '4 minutes',
    });
    const svc = makeSvc();
    const log = watchLog(svc);

    await svc.completeJob(j, { ok: false, error: 'таймаут' });
    await svc.completeJob(j, { ok: true });

    const after = await getProduct(p.id);
    expect(after.status).toBe('running');
    expect(after.port).toBe(8003);
    expect(after.provision_error).toBeNull();
    // Задание тоже не переоткрывается и причину не приобретает.
    expect((await getJob(j)).status).toBe('done');
    expect((await getJob(j)).error).toBeNull();
    // След в логе: без него единственный признак ушедшего в никуда отчёта —
    // тишина.
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(String(log.warn.mock.calls[0][0])).toContain(j);
  });

  it('14. отчёт бота без порта у продукта с NULL-портом — одна строка, а не ноль', async () => {
    // `SET port = COALESCE($2, port)` при обоих NULL всё равно обязан задеть
    // строку: rowCount 0 означал бы «отчёт не доехал», и в лог ушло бы
    // предупреждение о незапущенном задании. Через мок это неотличимо — там
    // rowCount задаёт сам мок.
    const p = await product({ slug: 'bot-noport', kind: 'bot', port: null });
    const j = await job(p.id, { status: 'running', startedAgo: '1 minute' });
    const svc = makeSvc();
    const log = watchLog(svc);

    await svc.completeJob(j, { ok: true });

    expect(log.warn).not.toHaveBeenCalled();
    expect((await getJob(j)).status).toBe('done');
    expect((await getProduct(p.id)).port).toBeNull();
    // Статус продукта отчёт не меняет: выход из provisioning — по измеримому
    // факту, а не по словам агента.
    expect((await getProduct(p.id)).status).toBe('provisioning');
  });

  it('15. два одновременных отчёта по одному заданию: ровно один победитель', async () => {
    const p = await product({ slug: 'double-report' });
    const j = await job(p.id, { status: 'running', startedAgo: '1 minute' });
    const a = makeSvc();
    const b = makeSvc();
    const la = watchLog(a);
    const lb = watchLog(b);

    await Promise.all([
      a.completeJob(j, { ok: false, error: 'причина-А' }),
      b.completeJob(j, { ok: false, error: 'причина-Б' }),
    ]);

    // Ровно один отчёт доехал — второй нашёл задание уже закрытым.
    expect(la.warn.mock.calls.length + lb.warn.mock.calls.length).toBe(1);
    const prod = await getProduct(p.id);
    const jb = await getJob(j);
    expect(jb.status).toBe('failed');
    expect(prod.status).toBe('failed');
    // Причина в задании и в продукте — ОДНА. Разъехавшиеся означали бы, что
    // проигравший успел дописать половину.
    expect(prod.provision_error).toBe(jb.error);
    expect(['причина-А', 'причина-Б']).toContain(prod.provision_error);
  });

  it('16. замок адресуется по id ЗАДАНИЯ, а не по product_id', async () => {
    // products.id и product_provision_jobs.id — оба uuid, поэтому
    // `WHERE product_id = $1` типами сойдётся, обновит ноль строк и не
    // пожалуется: отчёт агента пропал бы молча навсегда. Пришпилены ОБА
    // направления — иначе подмена колонки просто переворачивает смысл теста.
    const p = await product({ slug: 'lock-by-id' });
    const j = await job(p.id, { status: 'running', startedAgo: '1 minute' });
    expect(j).not.toBe(p.id);
    const svc = makeSvc();
    const log = watchLog(svc);

    // id ПРОДУКТА заданием не является: отчёт обязан уйти в никуда.
    await svc.completeJob(p.id, { ok: true, port: 7777 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((await getProduct(p.id)).port).toBeNull();
    expect((await getJob(j)).status).toBe('running');

    // id ЗАДАНИЯ — является.
    await svc.completeJob(j, { ok: true, port: 8003 });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect((await getProduct(p.id)).port).toBe(8003);
    expect((await getJob(j)).status).toBe('done');
  });

  // ═══════════════ ограничения самой схемы и create() ═══════════════

  it('17. частичный индекс one_active действительно запрещает второе задание', async () => {
    // На этом индексе висит вся аргументация сценария 8 и половина
    // комментариев в provisioning.service.ts: «зависшее задание снимается,
    // иначе индекс запрещает повтор навсегда». До сих пор он не исполнялся
    // НИГДЕ — сторожем был текстовой поиск по DDL в products.migration.spec.ts,
    // то есть ровно тот жанр, против которого написан этот файл. Измерено:
    // убери CREATE UNIQUE INDEX из 002_provisioning.sql — юнит краснеет
    // текстовым сторожем, интеграционный остаётся зелёным.
    const p = await product({ slug: 'one-active' });
    await job(p.id, { createdAgo: '99 minutes' });

    // Второе активное задание не проходит — и именно по имени, которое
    // хардкодят обработчики ошибок.
    const second = await pool
      .query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [
        p.id,
      ])
      .then(() => null)
      .catch((e: any) => e);
    expect(second).not.toBeNull();
    expect(second.code).toBe('23505');
    expect(second.constraint).toBe('product_provision_jobs_one_active');

    // Закрытое заданием НЕ считается активным: после таймаута повтор проходит.
    // Без этой половины тест узаконил бы индекс, из-под которого нет выхода.
    const svc = makeSvc();
    watchLog(svc);
    await expect(svc.failStaleProvisioning()).resolves.toBe(1);

    await expect(
      pool.query(`INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`, [
        p.id,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  // create() до сих пор не вызывался файлом НИ РАЗУ, и это стоило дорого:
  // переименование UNIQUE на products.slug даёт зелёными ОБА прогона, а в
  // проде занятый слаг начинает отдавать 500 (страница ошибки) вместо 409
  // («слаг занят, выберите другой»). Имя ограничения рождается в PostgreSQL —
  // мок такое проверить не может по устройству.

  it('18а. заведение доезжает до базы целиком: продукт, задание и bytea', async () => {
    // bytea записан КОДОМ, а не фикстурой: encrypt при заведении, INSERT и
    // decrypt при выдаче сходятся только все вместе и только если AAD —
    // тот самый productId, сгенерированный ДО вставки.
    const svc = makeSvc();

    const { productId } = await svc.create({
      userId: 'u-1',
      name: 'первый',
      slug: 'taken-slug',
      kind: 'bot',
      secrets: { BOT_TOKEN: '123:abc' },
    });

    const row = await getProduct(productId);
    expect(row.status).toBe('provisioning');
    expect(row.kind).toBe('bot');
    expect(row.checkout_path).toBe('/product');
    expect(Buffer.isBuffer(row.secrets_encrypted)).toBe(true);
    const j = await pool.query('SELECT status FROM product_provision_jobs WHERE product_id = $1', [
      productId,
    ]);
    expect(j.rows).toEqual([{ status: 'queued' }]);
    const claimed = await makeSvc().claimJob();
    expect(claimed!.productId).toBe(productId);
    expect(claimed!.secrets).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('18б. занятый слаг отбивается 409 ещё до выпуска токена', async () => {
    const svc = makeSvc();
    await svc.create({ userId: 'u-1', name: 'первый', slug: 'taken-slug', kind: 'site', secrets: {} });

    const e = await svc
      .create({ userId: 'u-2', name: 'второй', slug: 'taken-slug', kind: 'site', secrets: {} })
      .then(() => null)
      .catch((err: any) => err);

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(String(e.message)).toMatch(/слаг/);
    // Висячего продукта после отказа не остаётся.
    const all = await pool.query('SELECT count(*) FROM products WHERE slug = $1', ['taken-slug']);
    expect(Number(all.rows[0].count)).toBe(1);
  });

  it('18в. слаг, занятый ПОСЛЕ проверки, ловится по имени ограничения', async () => {
    // Единственный путь, на котором проверяется захардкоженное
    // `products_slug_key`. Проверка занятости в create() читает состояние ДО
    // вставки, и соседний запрос успевает занять слаг между ними. Гонка здесь
    // не случайная, а воспроизведённая точно: подмена происходит внутри
    // ответа на тот самый SELECT count(*).
    //
    // Узость условия — не осторожность: безусловный ConflictException
    // превратил бы падение базы и нарушение CHECK в спокойное «слаг занят» без
    // следа в логах, поэтому ниже проверяется ещё и то, что ЧУЖОЕ нарушение
    // 23505 наружу 409 не отдаёт.
    let raced = false;
    const racingPg = {
      query: async (sql: string, params?: any[]) => {
        const r = await pool.query(sql, params);
        if (!raced && /SELECT count\(\*\) FROM products WHERE slug/.test(sql)) {
          raced = true;
          await product({ slug: params![0] });
        }
        return r;
      },
    };
    const svc = new ProvisioningService(racingPg as any, secrets);

    const e = await svc
      .create({ userId: 'u-9', name: 'гонка', slug: 'raced-slug', kind: 'site', secrets: {} })
      .then(() => null)
      .catch((err: any) => err);

    expect(raced).toBe(true);
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    // Ровно один продукт с этим слагом — тот, что занял его в гонке.
    const all = await pool.query('SELECT count(*) FROM products WHERE slug = $1', ['raced-slug']);
    expect(Number(all.rows[0].count)).toBe(1);
  });

  it('18г. чужое нарушение UNIQUE наружу 409 не отдаёт', async () => {
    // Второй UNIQUE на этой таблице — products_runner_token_hash_key.
    // Столкновение sha256 от 32 случайных байт означает не занятый слаг, а
    // что-то, что обязано быть видно как 500. Безусловный catch эту разницу
    // стирает, и падение базы выглядело бы как «выберите другой слаг».
    const svc = makeSvc();
    const fixed = crypto.createHash('sha256').update('константа').digest('hex');
    const spy = jest.spyOn(crypto, 'createHash');
    await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash)
       VALUES ('u-1', 'занял хеш', 'hash-taken', 'site', 'provisioning', '/product', $1)`,
      [fixed],
    );
    spy.mockImplementation(
      () => ({ update: () => ({ digest: () => fixed }) }) as any,
    );

    const e = await svc
      .create({ userId: 'u-2', name: 'другой', slug: 'hash-clash', kind: 'site', secrets: {} })
      .then(() => null)
      .catch((err: any) => err);

    expect(e).not.toBeNull();
    expect(e).not.toBeInstanceOf(ConflictException);
    expect(e.code).toBe('23505');
    expect(e.constraint).toBe('products_runner_token_hash_key');
  });
  // ═══════════════════════════ retry ═══════════════════════════

  /** Сорванное заведение: продукт в failed с причиной и закрытым заданием. */
  async function failedProduct(o: { slug?: string; reason?: string } = {}) {
    const p = await product({ slug: o.slug ?? `failed-${seq++}`, status: 'failed' });
    await pool.query('UPDATE products SET provision_error = $2 WHERE id = $1', [
      p.id,
      o.reason ?? 'срок заведения истёк (10 мин)',
    ]);
    await job(p.id, { status: 'failed', startedAgo: '20 minutes', finishedAgo: '10 minutes' });
    return p;
  }

  const jobsOf = async (productId: string) =>
    (
      await pool.query(
        'SELECT status FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at',
        [productId],
      )
    ).rows.map((r: any) => r.status);

  it('19а. повтор возвращает продукт в очередь, и задание сразу выдаётся агенту', async () => {
    const other = await bystander();
    const p = await failedProduct({ slug: 'retry-ok', reason: 'контейнер не собрался' });

    await makeSvc().retry(p.id, 'u-1');

    const row = await getProduct(p.id);
    expect(row.status).toBe('provisioning');
    // Причина прошлого отказа переживает повтор — см. 002_provisioning.sql.
    // Чистит её promoteReady при удачном переводе, и только он.
    expect(row.provision_error).toBe('контейнер не собрался');
    // Старое задание осталось закрытым, новое встало в очередь.
    expect(await jobsOf(p.id)).toEqual(['failed', 'queued']);

    // Смычка со всем остальным конвейером: заведение, до которого агент не
    // добирается, — это кнопка без последствий. Ровно тот тупик, из-за
    // которого promoteReady проверяет отсутствие активного задания.
    const claimed = await makeSvc().claimJob();
    expect(claimed!.productId).toBe(p.id);
    await expectUntouched(other);
  });

  it('19б. чужой продукт не перезаводится', async () => {
    const p = await failedProduct({ slug: 'retry-alien' });
    const before = await getProduct(p.id);

    await expect(makeSvc().retry(p.id, 'u-чужой')).rejects.toBeInstanceOf(NotFoundException);

    // Ни строки продукта, ни задания: снятое `user_id = $2` дало бы чужому
    // пользователю право гонять заведение на чужом продукте.
    expect(await getProduct(p.id)).toEqual(before);
    expect(await jobsOf(p.id)).toEqual(['failed']);
  });

  it('19в. повтор не трогает продукт, который не в отказе', async () => {
    // Работающий сайт, отправленный на повтор, перестаёт получать ходы
    // (claimNext отбирает только по running) — а снаружи он жив и отвечает.
    for (const status of ['running', 'provisioning', 'stopped']) {
      const p = await product({ slug: `retry-${status}-${seq++}`, status });
      const before = await getProduct(p.id);

      await expect(makeSvc().retry(p.id, 'u-1')).rejects.toBeInstanceOf(NotFoundException);

      expect(await getProduct(p.id)).toEqual(before);
      expect(await jobsOf(p.id)).toEqual([]);
    }
  });

  it('19г. архивный продукт из отказа не воскрешается', async () => {
    const p = await failedProduct({ slug: 'retry-archived' });
    await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [p.id]);
    const before = await getProduct(p.id);

    await expect(makeSvc().retry(p.id, 'u-1')).rejects.toBeInstanceOf(NotFoundException);

    expect(await getProduct(p.id)).toEqual(before);
    expect(await jobsOf(p.id)).toEqual(['failed']);
  });

  it('19д. конфликт по активному заданию НЕ оставляет продукт в provisioning', async () => {
    // Главный сторож формы «один оператор». Двумя запросами на пуле
    // (транзакции нет) UPDATE проходит, INSERT падает на частичном индексе —
    // и продукт остаётся в provisioning БЕЗ активного задания... точнее, с
    // чужим активным, которое ему уже не поможет: promoteReady ждёт закрытия
    // задания, claimJob требует provisioning, а кнопка «повторить» мертва,
    // потому что статус больше не failed. Одним оператором откатывается всё.
    const p = await failedProduct({ slug: 'retry-conflict' });
    await job(p.id, { status: 'running', startedAgo: '1 minute' });
    const before = await getProduct(p.id);

    const e = await makeSvc()
      .retry(p.id, 'u-1')
      .then(() => null)
      .catch((err: any) => err);

    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getStatus()).toBe(409);
    expect(await getProduct(p.id)).toEqual(before);
    expect(await jobsOf(p.id)).toEqual(['failed', 'running']);
  });

  it('19е. два ОДНОВРЕМЕННЫХ повтора дают ровно одно задание', async () => {
    // Двойной клик по кнопке. Единственное требование — не два развёртывания
    // в один каталог; каким именно отказом отбивается проигравший, значения
    // не имеет, поэтому здесь сверяется состояние базы, а не код ответа.
    const p = await failedProduct({ slug: 'retry-double' });

    const outcomes = await Promise.all(
      [makeSvc(), makeSvc()].map((svc) =>
        svc
          .retry(p.id, 'u-1')
          .then(() => 'ok')
          .catch((e: any) => e.constructor.name),
      ),
    );

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(await jobsOf(p.id)).toEqual(['failed', 'queued']);
    expect((await getProduct(p.id)).status).toBe('provisioning');
  });

  it('20. выдача клиенту несёт форму продукта и причину отказа', async () => {
    // Колонки завела миграция 002, а перечисление в ProductsService про них не
    // знало — и до кабинета они не доезжали: карточка отказа показывала
    // «сервер не передал причину» при заполненной колонке в базе, а бот
    // выглядел сайтом. На сервере это не ломало НИЧЕГО, и покраснеть было
    // нечему: серверу обе колонки не нужны, нужны они только клиенту.
    //
    // Поэтому сценарий здесь, а не на заглушке pg: там проверялся бы текст
    // запроса, то есть форма. Здесь спрашивается то, что клиент получит.
    await failedProduct({ slug: 'vydacha-otkaz', reason: 'нет места на диске' });
    await product({ slug: 'vydacha-bot', kind: 'bot', status: 'running' });

    const rows = await new ProductsService(pg as any).list('u-1');
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));

    expect(bySlug['vydacha-otkaz'].provision_error).toBe('нет места на диске');
    expect(bySlug['vydacha-otkaz'].kind).toBe('site');
    expect(bySlug['vydacha-bot'].kind).toBe('bot');

    // Сторож секретов стоит рядом с новыми колонками нарочно: дописывать
    // перечисление в следующий раз будут здесь же.
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('secrets_encrypted');
      expect(Object.keys(row)).not.toContain('runner_token_hash');
    }
  });
});
