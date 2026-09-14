import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
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
 * ПРО ПРИБОР. Сторож «заведомо невалидный TypeScript» в этом репозитории
 * бесполезен и молча зелен: tsconfig.json ставит isolatedModules, ts-jest
 * работает транспайлером и типы не проверяет ВООБЩЕ (измерено:
 * `const x: number = 'строка'` не краснит ни одного теста). Типы ловит только
 * `npx tsc --noEmit`, и гонять его надо отдельно. Рабочие сторожа — неразбор
 * исходника и заведомо сломанное поведение; первый, кстати, даёт
 * `Tests: 107 passed, 107 total` при 224 в чистом прогоне: строка полностью
 * зелёная, красное видно только в `Test Suites:` и в упавшем ИТОГЕ.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. `FOR UPDATE SKIP LOCKED` этим файлом не измеряется:
 * каждый claim — ОДИН оператор, то есть транзакция длиной в себя самого, и
 * без SKIP LOCKED ожидающий получает лок на микросекунды, а потом EvalPlanQual
 * перечитывает строку, видит status='running' и всё равно уходит ни с чем.
 * Победитель ровно один в обоих случаях, и разницу во времени на такой длине
 * не измерить. Сторожем остаётся регексп в provisioning.job.spec.ts.
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
  });

  afterAll(async () => {
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
    kind?: 'site' | 'bot';
    status?: string;
    port?: number | null;
    /** Интервал ДО now(); по умолчанию продукт только что создан. */
    createdAgo?: string;
    /** null — раннер не выходил на связь ни разу. */
    seenAgo?: string | null;
    archived?: boolean;
    secrets?: Record<string, string> | null;
    provisionError?: string | null;
  };

  async function product(o: Seed = {}) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `p-${seq++}`;
    const box = o.secrets ? secrets.encrypt(o.secrets, id) : null;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path,
                             runner_token_hash, secrets_encrypted, port, provision_error,
                             runner_seen_at, created_at, archived_at)
       VALUES ($1, 'u-1', 'продукт', $2, $3, $4, '/product', $5, $6, $7, $8,
               CASE WHEN $9::text IS NULL THEN NULL ELSE now() - $9::interval END,
               now() - $10::interval,
               CASE WHEN $11::bool THEN now() ELSE NULL END)`,
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
        o.provisionError ?? null,
        o.seenAgo ?? null,
        o.createdAgo ?? '1 second',
        o.archived ?? false,
      ],
    );
    return { id, slug };
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
    return p;
  }

  async function expectUntouched(p: { id: string }) {
    const r = await getProduct(p.id);
    expect(r.status).toBe('running');
    expect(r.port).toBe(9999);
    expect(r.provision_error).toBeNull();
    expect(r.archived_at).toBeNull();
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

  it('4. пять ОДНОВРЕМЕННЫХ claim на одно задание дают ровно одного победителя', async () => {
    // Задание, доставшееся двоим, означало бы два развёртывания в один
    // каталог. Второй агент обязан уйти ни с чем, а не ждать и получить то же
    // самое следом.
    const other = await bystander();
    const p = await product({ slug: 'race1' });
    const j = await job(p.id);
    const svc = makeSvc();

    const started = Date.now();
    const claims = await Promise.all([0, 1, 2, 3, 4].map(() => svc.claimJob()));
    const elapsed = Date.now() - started;

    const winners = claims.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.jobId).toBe(j);
    // Проигравшие уходят сразу, а не встают в очередь за победителем. Порог
    // грубый намеренно: он ловит блокирующее ожидание, а не миллисекунды.
    expect(elapsed).toBeLessThan(3000);
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

  it('7. состояние, поменявшееся РОВНО в окне пробы, перевод не переживает', async () => {
    // Между выборкой и записью проходит вся проба — до PROBE_TIMEOUT_MS.
    // Хук в fetchFn подменяет состояние ровно в этом окне, как это делает
    // живой пользователь или соседний инстанс.

    // (а) «повторить» нажато во время пробы: продукт остаётся в provisioning,
    //     и задание по-прежнему выдаётся. Перевод в running отнял бы у
    //     claimJob право выдать его — кнопка нажата, ничего не произошло.
    const a = await product({ slug: 'race-retry', seenAgo: '10 seconds' });
    let jid = '';
    await expect(
      makeSvc(async () => {
        jid = await job(a.id);
        return { status: 200 };
      }).promoteReady(),
    ).resolves.toBe(0);
    expect((await getProduct(a.id)).status).toBe('provisioning');
    expect((await makeSvc().claimJob())!.jobId).toBe(jid);

    // (б) таймаут отработал во время пробы: похороненный не воскресает, и
    //     причина не затирается.
    await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
    // Отметка раннера СВЕЖАЯ: иначе promoteReady отсеет продукт ещё до пробы,
    // хук не позовётся и «гонка» выродится в проверку heartbeat.
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
    const afterB = await getProduct(b.id);
    expect(afterB.status).toBe('failed');
    expect(afterB.provision_error).toMatch(/раннер на связи/);

    // (в) продукт архивирован во время пробы: archived_at при статусе running
    //     — состояние, из которого нет выхода.
    await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
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

  it('11. два инстанса не переводят и не хоронят один продукт дважды', async () => {
    // Прод запущен в кластерном режиме. Число инстансов нигде не
    // зафиксировано — параллельные обороты это одно `pm2 scale` от
    // реальности, и предупреждения при этом не будет.

    // (а) одновременный промоут одного продукта: ровно один перевод.
    const a = await product({ slug: 'two-promote', kind: 'bot', seenAgo: '10 seconds' });
    const promotions = await Promise.all([
      makeSvc().promoteReady(),
      makeSvc().promoteReady(),
    ]);
    expect(promotions.reduce((x, y) => x + y, 0)).toBe(1);
    expect((await getProduct(a.id)).status).toBe('running');

    // (б) промоут с медленной пробой против таймаута: состояние согласовано.
    //     Либо продукт переведён и причина снята, либо похоронен и причина
    //     записана. «Running с текстом про таймаут» и «failed при promoted=1»
    //     — обе лжи, которые здесь уже воспроизводились.
    await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
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
    const afterB = await getProduct(b.id);
    expect(promoted + buried).toBe(1);
    if (promoted === 1) {
      expect(afterB.status).toBe('running');
      expect(afterB.provision_error).toBeNull();
    } else {
      expect(afterB.status).toBe('failed');
      expect(afterB.provision_error).toMatch(/раннер на связи/);
    }

    // (в) два одновременных таймаута хоронят один раз.
    await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
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

  it('12. отчёт правит ТОЛЬКО свой продукт: посторонний реестр не трогается', async () => {
    // САМЫЙ ДОРОГОЙ СЦЕНАРИЙ ФАЙЛА. `UPDATE products ... FROM closed` — это
    // СОЕДИНЕНИЕ, а не поиск по ключу: убери условие соединения (или допиши
    // `OR TRUE`), и один отчёт агента похоронит весь реестр. Регексп-сторож в
    // job.spec `OR TRUE` переживает, а в базе с ОДНИМ продуктом оба варианта
    // неотличимы — поэтому посторонние продукты обязаны лежать в фикстурах.
    const one = await bystander();
    const two = await bystander();
    const idle = await product({ slug: 'untouched-provisioning', seenAgo: null });

    const p = await product({ slug: 'report-fail', port: 7000 });
    const j = await job(p.id, { status: 'running', startedAgo: '1 minute' });
    const svc = makeSvc();
    const log = watchLog(svc);

    await svc.completeJob(j, { ok: false, error: 'порт занят' });

    expect((await getProduct(p.id)).status).toBe('failed');
    expect((await getProduct(p.id)).provision_error).toBe('порт занят');
    expect((await getJob(j)).status).toBe('failed');
    expect(log.warn).not.toHaveBeenCalled();
    await expectUntouched(one);
    await expectUntouched(two);
    // Незанятый продукт тоже не должен ни похорониться, ни получить порт.
    const после = await getProduct(idle.id);
    expect(после.status).toBe('provisioning');
    expect(после.provision_error).toBeNull();

    // Успешный путь портит реестр иначе — портом. Проверяется отдельно.
    const q = await product({ slug: 'report-ok' });
    const jq = await job(q.id, { status: 'running', startedAgo: '1 minute' });
    await svc.completeJob(jq, { ok: true, port: 8003 });
    expect((await getProduct(q.id)).port).toBe(8003);
    await expectUntouched(one);
    await expectUntouched(two);
    expect((await getProduct(idle.id)).port).toBeNull();
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
});
