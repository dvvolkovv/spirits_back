/**
 * Раздел админки «Сайты и боты» против живого Postgres.
 *
 * Сводка продуктов всех пользователей — один запрос на пять таблиц и два
 * подзапроса по ходам. Почти всё, что в нём можно сломать, юнит-тест с
 * подменённым pg не исполняет вовсе: ILIKE и его экранирование, NULLS LAST,
 * окно периода, GREATEST с NULL, LEFT JOIN, размножающий строки. Поэтому файл
 * гоняет настоящий SQL на одноразовой базе.
 *
 * Что закреплено:
 *  - форма строки — ровно та, что читает фронт (AdminProductRow), даты — ISO;
 *  - поиск — по имени, слагу, адресу платформы, своему домену (кириллическому
 *    тоже: в базе он лежит punycode), по владельцу; % и _ ищутся буквально;
 *  - архивные и тестовые аккаунты скрыты по умолчанию и показываются флагами;
 *  - ходы и токены считаются в окне периода, последний ход — за всё время;
 *  - порядок — по последней активности, молчащие в конце, дальше новые;
 *  - карточка открывается по id — и для архивного, и для тестового; тексты
 *    ходов обрезаны, ходы и задания — последние и с потолком.
 *
 * КАК ГОНЯТЬ. База ОДНОРАЗОВАЯ: beforeEach делает TRUNCATE, в том числе
 * профилей и входов. ai_profiles_consolidated и user_identities в список
 * миграций продуктов не входят и заводятся здесь минимальными копиями — как в
 * rent.review.spec.ts, с теми колонками, что читает сервис. Гард в beforeAll
 * проверяет пустоту всех трёх таблиц, а не одной products: на базе стенда
 * products пуста, а профили там — живые пользователи.
 *
 *   PROVISIONING_PG_URL=postgres://<роль>:<пароль>@127.0.0.1:5432/<база> \
 *     npx jest src/admin/admin-products.spec.ts --runInBand
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from '../products/products.service';
import { AdminProductsService } from './admin-products.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

const WIPE =
  'TRUNCATE products, product_provision_jobs, product_turns, product_domains, product_host_agent, ' +
  'product_hosts, ai_profiles_consolidated, user_identities RESTART IDENTITY CASCADE';

maybe('админка «Сайты и боты»: сервис против живого Postgres', () => {
  jest.setTimeout(60_000);

  // Числа договора с фронтом — литералами, а не импортом констант сервиса:
  // иначе правка константы молча сдвинула бы и проверку.
  const PRODUCTS_CAP = 500;
  const TEXT_CAP = 2000;

  let pool: Pool;
  let pg: { query: (sql: string, params?: any[]) => Promise<any> };
  const svc = () => new AdminProductsService(pg as any);

  /** Обычный владелец: не в списке тестовых и не под маской 790300xxxxx. */
  const OWNER = '79161234567';
  /** Владелец, вошедший почтой: user_id — UUID, а не телефон. */
  const UUID_OWNER = '5b0b6a36-6a3f-4a0a-9a5e-2f0e4f7a1c11';

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, '..', 'products', 'migrations', f), 'utf8'));
    }
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_profiles_consolidated (
       id serial PRIMARY KEY,
       user_id text NOT NULL UNIQUE,
       tokens bigint NOT NULL DEFAULT 0,
       updated_at timestamptz DEFAULT now())`);
    // Минимальная копия из rent.review.spec.ts этих колонок не несёт, а база
    // может оказаться общей с тем прогоном.
    await pool.query(`ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS email text`);
    await pool.query(
      `ALTER TABLE ai_profiles_consolidated ADD COLUMN IF NOT EXISTS profile_data jsonb DEFAULT '{}'::jsonb`,
    );
    await pool.query(`CREATE TABLE IF NOT EXISTS user_identities (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id text NOT NULL,
       provider text NOT NULL,
       provider_sub text NOT NULL,
       email text,
       email_verified boolean NOT NULL DEFAULT false,
       created_at timestamptz DEFAULT now())`);
    for (const t of ['products', 'ai_profiles_consolidated', 'user_identities']) {
      const n = await pool.query(`SELECT count(*) FROM ${t}`);
      if (Number(n.rows[0].count) > 0) {
        throw new Error(`PROVISIONING_PG_URL указывает на НЕпустую базу (${t}) — нужна одноразовая`);
      }
    }
  });

  afterAll(async () => {
    // За собой убираем: соседние сьюты требуют пустую products, а 005 при их
    // накатке отказывает на живом продукте без машины.
    await pool?.query(WIPE);
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query(WIPE);
  });

  // ——— фикстуры ———

  let seq = 0;

  const mkHost = (id = 'own', ip = '139.59.210.42') =>
    pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix, agent_token_hash, capacity, audience)
       VALUES ($1, $2, $3, 'p.linkeon.io', $4, 20, 'own')`,
      [id, `root@${ip}`, ip, `hash-${id}`],
    );

  type ProductSeed = {
    slug?: string;
    name?: string;
    user?: string;
    kind?: 'site' | 'bot';
    status?: string;
    /** undefined — адрес по слагу у сайта и пусто у бота. */
    domain?: string | null;
    /** undefined — машина own. */
    host?: string | null;
    /** Сколько назад: интервал Postgres, '2 days'. */
    created?: string;
    archived?: string | null;
    seen?: string | null;
    sleepReason?: string | null;
    blockReason?: string | null;
    provisionError?: string | null;
  };

  const mkProduct = async (o: ProductSeed = {}) => {
    const slug = o.slug ?? `p${++seq}`;
    const kind = o.kind ?? 'site';
    const r = await pool.query(
      `INSERT INTO products (user_id, name, slug, kind, status, domain, host_id, checkout_path,
                             runner_token_hash, created_at, archived_at, runner_seen_at,
                             sleep_reason, block_reason, provision_error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               now() - $10::interval, now() - $11::interval, now() - $12::interval,
               $13, $14, $15)
       RETURNING id`,
      [
        o.user ?? OWNER,
        o.name ?? `Продукт ${slug}`,
        slug,
        kind,
        o.status ?? 'running',
        o.domain !== undefined ? o.domain : kind === 'site' ? `${slug}.p.linkeon.io` : null,
        o.host !== undefined ? o.host : 'own',
        `/srv/${slug}`,
        `hash-${slug}`,
        o.created ?? '1 hour',
        o.archived ?? null,
        o.seen ?? null,
        o.sleepReason ?? null,
        o.blockReason ?? null,
        o.provisionError ?? null,
      ],
    );
    return r.rows[0].id as string;
  };

  type TurnSeed = {
    ago?: string;
    tokens?: number;
    status?: string;
    prompt?: string;
    result?: string | null;
    error?: string | null;
    channel?: 'web' | 'telegram';
  };

  /** Ход по умолчанию завершён: 'queued'/'running' у продукта может быть лишь один. */
  const mkTurn = async (productId: string, o: TurnSeed = {}) => {
    const r = await pool.query(
      `INSERT INTO product_turns (product_id, user_id, channel, prompt, result, status, tokens_spent, error,
                                  created_at, started_at, finished_at)
       SELECT p.id, p.user_id, $2, $3, $4, $5, $6, $7,
              now() - $8::interval, now() - $8::interval + interval '5 seconds',
              now() - $8::interval + interval '1 minute'
         FROM products p WHERE p.id = $1
       RETURNING id`,
      [
        productId,
        o.channel ?? 'web',
        o.prompt ?? 'поправь шапку',
        o.result === undefined ? 'готово' : o.result,
        o.status ?? 'done',
        o.tokens ?? 0,
        o.error ?? null,
        o.ago ?? '1 hour',
      ],
    );
    return r.rows[0].id as string;
  };

  /** Строка своего домена. names — по форме 008: корень и www. */
  const mkDomain = (
    productId: string,
    domain: string,
    status: string,
    extra: { error?: string; reason?: string; checked?: string } = {},
  ) =>
    pool.query(
      `INSERT INTO product_domains (product_id, domain, names, token, status, error, error_reason, checked_at)
       VALUES ($1, $2, $3, 'lk-x', $4, $5, $6, now() - $7::interval)`,
      [
        productId,
        domain,
        [domain, `www.${domain}`],
        status,
        extra.error ?? null,
        extra.error === undefined ? null : extra.reason ?? 'issue_failed',
        extra.checked ?? null,
      ],
    );

  const mkProfile = (userId: string, o: { name?: string; email?: string } = {}) =>
    pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, email, profile_data) VALUES ($1, $2, $3::jsonb)`,
      [userId, o.email ?? null, JSON.stringify(o.name === undefined ? {} : { name: o.name })],
    );

  const mkIdentity = (userId: string, email: string, verified: boolean, provider = 'email') =>
    pool.query(
      `INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, provider, `${provider}-${email}`, email, verified],
    );

  const productRow = async (id: string) =>
    (
      await pool.query(
        `SELECT created_at, archived_at, paid_until, runner_seen_at FROM products WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const turnTime = async (turnId: string) =>
    (await pool.query(`SELECT created_at FROM product_turns WHERE id = $1`, [turnId])).rows[0].created_at as Date;

  const ids = (res: { products: Array<{ id: string }> }) => res.products.map((p) => p.id);
  const sorted = (xs: string[]) => [...xs].sort();

  // ——— список ———

  describe('строка списка', () => {
    it('несёт продукт, владельца, машину и активность одной формой, даты — ISO', async () => {
      await mkHost();
      await mkProfile(OWNER, { name: 'Дмитрий', email: 'd@example.com' });
      const id = await mkProduct({
        slug: 'flowers',
        name: 'Магазин цветов',
        seen: '5 minutes',
        provisionError: 'в прошлый раз не собрался',
      });
      const turn = await mkTurn(id, { ago: '2 days', tokens: 1200 });

      const res = await svc().list({});

      const db = await productRow(id);
      expect(res).toEqual({
        periodDays: 30,
        products: [
          {
            id,
            name: 'Магазин цветов',
            slug: 'flowers',
            kind: 'site',
            status: 'running',
            domain: 'flowers.p.linkeon.io',
            customDomain: null,
            owner: { userId: OWNER, name: 'Дмитрий', email: 'd@example.com' },
            host: { id: 'own', publicIp: '139.59.210.42' },
            createdAt: db.created_at.toISOString(),
            archivedAt: null,
            paidUntil: db.paid_until.toISOString(),
            runnerSeenAt: db.runner_seen_at.toISOString(),
            sleepReason: null,
            blockReason: null,
            provisionError: 'в прошлый раз не собрался',
            lastTurnAt: (await turnTime(turn)).toISOString(),
            lastActivityAt: db.runner_seen_at.toISOString(),
            turnsInPeriod: 1,
            tokensInPeriod: 1200,
          },
        ],
      });
    });

    it('причины сна и блокировки приезжают как есть', async () => {
      await mkHost();
      await mkProduct({ slug: 'sleepy', status: 'sleeping', sleepReason: 'не хватило токенов на аренду' });
      await mkProduct({ slug: 'bad', status: 'blocked', blockReason: 'фишинг по жалобе' });

      const rows = (await svc().list({})).products;
      const by = (slug: string) => rows.find((r) => r.slug === slug);
      expect(by('sleepy')).toMatchObject({ status: 'sleeping', sleepReason: 'не хватило токенов на аренду', blockReason: null });
      expect(by('bad')).toMatchObject({ status: 'blocked', blockReason: 'фишинг по жалобе', sleepReason: null });
    });

    it('свой домен — только при строке product_domains, статус как есть, имя для глаз рядом', async () => {
      await mkHost();
      const plain = await mkProduct({ slug: 'plain' });
      const cyr = await mkProduct({ slug: 'cyr' });
      const broken = await mkProduct({ slug: 'broken' });
      await mkDomain(cyr, 'xn--e1afmkfd.xn--p1ai', 'awaiting_dns');
      await mkDomain(broken, 'dmitryvolkov.ru', 'failed', { error: 'Let’s Encrypt отказал', checked: '1 hour' });

      const rows = (await svc().list({})).products;
      const by = (id: string) => rows.find((r) => r.id === id);
      expect(by(plain).customDomain).toBeNull();
      // Кабинет показывает владельцу только active; админке нужна заявка в
      // любом состоянии — именно её и приходят разбирать.
      expect(by(cyr).customDomain).toEqual({
        domain: 'xn--e1afmkfd.xn--p1ai',
        domainUnicode: 'пример.рф',
        status: 'awaiting_dns',
      });
      expect(by(broken).customDomain).toEqual({
        domain: 'dmitryvolkov.ru',
        domainUnicode: 'dmitryvolkov.ru',
        status: 'failed',
      });
    });

    it('машина — из реестра, у продукта без машины host: null', async () => {
      await mkHost('own', '139.59.210.42');
      await mkHost('clients', '10.0.0.5');
      const a = await mkProduct({ slug: 'a', host: 'own' });
      const b = await mkProduct({ slug: 'b', host: 'clients' });
      const c = await mkProduct({ slug: 'c', host: null });

      const rows = (await svc().list({})).products;
      const by = (id: string) => rows.find((r) => r.id === id);
      expect(by(a).host).toEqual({ id: 'own', publicIp: '139.59.210.42' });
      // host(), а не ::text: inet печатает себя с маской, «10.0.0.5/32».
      expect(by(b).host).toEqual({ id: 'clients', publicIp: '10.0.0.5' });
      expect(by(c).host).toBeNull();
    });

    it('владелец: имя из анкеты, почта — анкетная, иначе почта входа; строк не множит', async () => {
      await mkHost();
      await mkProfile(OWNER, { name: '  ', email: 'owner@example.com' });
      await mkProfile(UUID_OWNER, { name: 'Анна' });
      // Вошла почтой, и адресов входа два: подтверждённый — первым.
      await mkIdentity(UUID_OWNER, 'old@mail.test', false, 'email');
      await mkIdentity(UUID_OWNER, 'anna@mail.test', true, 'google');
      const mine = await mkProduct({ slug: 'mine' });
      const hers = await mkProduct({ slug: 'hers', user: UUID_OWNER });
      const ghost = await mkProduct({ slug: 'ghost', user: '79990001122' });

      const rows = (await svc().list({})).products;
      expect(rows).toHaveLength(3);
      const by = (id: string) => rows.find((r) => r.id === id);
      // Имя из одних пробелов — это «имени нет», а не пустая подпись.
      expect(by(mine).owner).toEqual({ userId: OWNER, name: null, email: 'owner@example.com' });
      expect(by(hers).owner).toEqual({ userId: UUID_OWNER, name: 'Анна', email: 'anna@mail.test' });
      expect(by(ghost).owner).toEqual({ userId: '79990001122', name: null, email: null });
    });
  });

  describe('что скрыто по умолчанию', () => {
    it('архивные — только с includeArchived', async () => {
      await mkHost();
      const live = await mkProduct({ slug: 'live' });
      const gone = await mkProduct({ slug: 'gone', archived: '1 day' });

      expect(ids(await svc().list({}))).toEqual([live]);
      const all = await svc().list({ includeArchived: true });
      expect(sorted(ids(all))).toEqual(sorted([live, gone]));
      const archived = all.products.find((r) => r.id === gone);
      expect(archived.archivedAt).toBe((await productRow(gone)).archived_at.toISOString());
    });

    it('тестовые аккаунты — только с includeTest; UUID-владелец тестовым не считается', async () => {
      await mkHost();
      const real = await mkProduct({ slug: 'real' });
      const byEmail = await mkProduct({ slug: 'byemail', user: UUID_OWNER });
      const listed = await mkProduct({ slug: 'listed', user: '70000000000' });
      const synthetic = await mkProduct({ slug: 'synthetic', user: '79030012345' });

      expect(sorted(ids(await svc().list({})))).toEqual(sorted([real, byEmail]));
      expect(sorted(ids(await svc().list({ includeTest: true })))).toEqual(
        sorted([real, byEmail, listed, synthetic]),
      );
    });
  });

  describe('поиск', () => {
    let flowers: string;
    let books: string;
    let helpdesk: string;

    beforeEach(async () => {
      await mkHost();
      await mkProfile(OWNER, { name: 'Дмитрий Волков', email: 'dv@example.com' });
      await mkProfile(UUID_OWNER, { name: 'Анна' });
      await mkIdentity(UUID_OWNER, 'anna@mail.test', true);
      flowers = await mkProduct({ slug: 'flowers', name: 'Магазин цветов' });
      books = await mkProduct({ slug: 'books', name: 'Книжная лавка', user: UUID_OWNER, domain: 'books-legacy.c.linkeon.io' });
      helpdesk = await mkProduct({ slug: 'helpdesk', name: 'Бот поддержки', kind: 'bot', user: '79990001122' });
      await mkDomain(flowers, 'dmitryvolkov.ru', 'active');
      await mkDomain(books, 'xn--e1afmkfd.xn--p1ai', 'awaiting_dns');
    });

    const find = async (q: string) => ids(await svc().list({ q }));

    it('по имени — без учёта регистра', async () => {
      expect(await find('ЦВЕТОВ')).toEqual([flowers]);
    });

    it('по слагу', async () => {
      expect(await find('helpd')).toEqual([helpdesk]);
    });

    it('по адресу платформы', async () => {
      expect(await find('legacy.c.linkeon')).toEqual([books]);
    });

    it('по своему домену — и punycode, и кириллицей, как его пишут в жалобе', async () => {
      expect(await find('volkov.r')).toEqual([flowers]);
      expect(await find('xn--e1afmkfd')).toEqual([books]);
      expect(await find('ПРИМЕР.рф')).toEqual([books]);
    });

    it('по владельцу — номеру, имени, почте анкеты и почте входа', async () => {
      expect(await find('7999000')).toEqual([helpdesk]);
      expect(await find('волков')).toEqual([flowers]);
      expect(await find('example.com')).toEqual([flowers]);
      expect(await find('anna@mail')).toEqual([books]);
      expect(await find(UUID_OWNER.slice(0, 8))).toEqual([books]);
    });

    it('по идентификатору продукта — точным совпадением', async () => {
      expect(await find(books)).toEqual([books]);
      expect(await find(books.toUpperCase())).toEqual([books]);
    });

    it('ничего не нашлось — пустой список; пустой запрос — не фильтр', async () => {
      expect(await find('нет-такого')).toEqual([]);
      expect(sorted(await find('   '))).toEqual(sorted([flowers, books, helpdesk]));
    });
  });

  describe('поиск: служебные символы LIKE ищутся буквально', () => {
    beforeEach(() => mkHost());

    it('% и _', async () => {
      const pct = await mkProduct({ slug: 'sale1', name: 'Скидка 100%' });
      await mkProduct({ slug: 'sale2', name: 'Скидка 1000' });
      const under = await mkProduct({ slug: 'under1', name: 'a_b' });
      await mkProduct({ slug: 'under2', name: 'axb' });

      expect(ids(await svc().list({ q: '100%' }))).toEqual([pct]);
      expect(ids(await svc().list({ q: 'a_b' }))).toEqual([under]);
    });

    it('обратная косая — тоже буквально, и без ошибки SQL', async () => {
      const slash = await mkProduct({ slug: 'slash', name: 'C:\\temp' });
      await mkProduct({ slug: 'noslash', name: 'C:temp' });

      expect(ids(await svc().list({ q: '\\' }))).toEqual([slash]);
      expect(ids(await svc().list({ q: ':\\t' }))).toEqual([slash]);
    });
  });

  describe('фильтры статуса и формы', () => {
    beforeEach(() => mkHost());

    it('статусы — списком через запятую, пробелы и пустые куски не мешают', async () => {
      const running = await mkProduct({ slug: 'r', status: 'running' });
      const sleeping = await mkProduct({ slug: 's', status: 'sleeping' });
      const blocked = await mkProduct({ slug: 'b', status: 'blocked' });
      const failed = await mkProduct({ slug: 'f', status: 'failed' });
      const all = [running, sleeping, blocked, failed];

      expect(sorted(ids(await svc().list({ status: 'running,sleeping' })))).toEqual(sorted([running, sleeping]));
      expect(ids(await svc().list({ status: 'running' }))).toEqual([running]);
      expect(sorted(ids(await svc().list({ status: ' blocked , ,failed ' })))).toEqual(sorted([blocked, failed]));
      expect(sorted(ids(await svc().list({ status: ['running', 'failed'] })))).toEqual(sorted([running, failed]));
      expect(sorted(ids(await svc().list({ status: '' })))).toEqual(sorted(all));
      // Незнакомый статус — честная пустота, а не снятый фильтр.
      expect(ids(await svc().list({ status: 'nope' }))).toEqual([]);
    });

    it('форма: site | bot; незнакомое значение фильтр не ставит', async () => {
      const site = await mkProduct({ slug: 'site1', kind: 'site' });
      const bot = await mkProduct({ slug: 'bot1', kind: 'bot' });

      expect(ids(await svc().list({ kind: 'bot' }))).toEqual([bot]);
      expect(ids(await svc().list({ kind: 'site' }))).toEqual([site]);
      expect(sorted(ids(await svc().list({ kind: 'garbage' })))).toEqual(sorted([site, bot]));
    });
  });

  describe('период', () => {
    let busy: string;
    let quiet: string;
    let latest: string;

    beforeEach(async () => {
      await mkHost();
      busy = await mkProduct({ slug: 'busy' });
      latest = await mkTurn(busy, { ago: '2 days', tokens: 100 });
      await mkTurn(busy, { ago: '10 days', tokens: 1000 });
      await mkTurn(busy, { ago: '45 days', tokens: 10000 });
      await mkTurn(busy, { ago: '200 days', tokens: 100000 });
      // Соседский ход не должен попасть в чужие счётчики.
      quiet = await mkProduct({ slug: 'quiet' });
      await mkTurn(quiet, { ago: '1 day', tokens: 5 });
    });

    const stats = async (periodDays?: number) => {
      const res = await svc().list({ periodDays });
      const by = (id: string) => res.products.find((r) => r.id === id);
      return {
        periodDays: res.periodDays,
        busy: [by(busy).turnsInPeriod, by(busy).tokensInPeriod],
        quiet: [by(quiet).turnsInPeriod, by(quiet).tokensInPeriod],
      };
    };

    it('ходы и токены — в окне периода, по умолчанию 30 дней', async () => {
      expect(await stats()).toEqual({ periodDays: 30, busy: [2, 1100], quiet: [1, 5] });
      expect(await stats(7)).toEqual({ periodDays: 7, busy: [1, 100], quiet: [1, 5] });
      expect(await stats(90)).toEqual({ periodDays: 90, busy: [3, 11100], quiet: [1, 5] });
    });

    it('период прижимается к 1…365, нечисло — умолчание, дробь отбрасывается', async () => {
      expect((await stats(0)).periodDays).toBe(1);
      expect((await stats(-5)).periodDays).toBe(1);
      expect(await stats(1000)).toEqual({ periodDays: 365, busy: [4, 111100], quiet: [1, 5] });
      expect((await stats(NaN)).periodDays).toBe(30);
      expect((await stats(7.9)).periodDays).toBe(7);
    });

    it('последний ход — за всё время, а не в окне', async () => {
      const old = await mkProduct({ slug: 'old' });
      const only = await mkTurn(old, { ago: '45 days', tokens: 7 });

      const res = await svc().list({ periodDays: 7 });
      const by = (id: string) => res.products.find((r) => r.id === id);
      expect(by(old)).toMatchObject({
        turnsInPeriod: 0,
        tokensInPeriod: 0,
        lastTurnAt: (await turnTime(only)).toISOString(),
        lastActivityAt: (await turnTime(only)).toISOString(),
      });
      expect(by(busy).lastTurnAt).toBe((await turnTime(latest)).toISOString());
    });
  });

  describe('последняя активность и порядок', () => {
    beforeEach(() => mkHost());

    it('активность — позднее из последнего хода и отметки раннера; без обоих — null', async () => {
      const seenLater = await mkProduct({ slug: 'seen', seen: '1 minute' });
      await mkTurn(seenLater, { ago: '3 days' });
      const turnLater = await mkProduct({ slug: 'turn', seen: '3 days' });
      const t = await mkTurn(turnLater, { ago: '1 minute' });
      const silent = await mkProduct({ slug: 'silent' });

      const rows = (await svc().list({})).products;
      const by = (id: string) => rows.find((r) => r.id === id);
      expect(by(seenLater).lastActivityAt).toBe((await productRow(seenLater)).runner_seen_at.toISOString());
      expect(by(turnLater).lastActivityAt).toBe((await turnTime(t)).toISOString());
      expect(by(silent)).toMatchObject({ lastTurnAt: null, runnerSeenAt: null, lastActivityAt: null });
    });

    it('сначала свежая активность, молчащие в конце — по дате заведения, новые выше', async () => {
      const turnNow = await mkProduct({ slug: 'e', seen: '2 days', created: '30 days' });
      await mkTurn(turnNow, { ago: '10 minutes' });
      const seenHour = await mkProduct({ slug: 'a', seen: '1 hour', created: '20 days' });
      const turnDay = await mkProduct({ slug: 'b', created: '10 days' });
      await mkTurn(turnDay, { ago: '1 day' });
      const newSilent = await mkProduct({ slug: 'c', created: '1 hour' });
      const oldSilent = await mkProduct({ slug: 'd', created: '3 days' });

      expect(ids(await svc().list({}))).toEqual([turnNow, seenHour, turnDay, newSilent, oldSilent]);
    });

    it(`выдача обрезана на ${PRODUCTS_CAP} строк — отбираются первые по тому же порядку`, async () => {
      await pool.query(
        `INSERT INTO products (user_id, name, slug, kind, status, checkout_path, runner_token_hash, created_at)
         SELECT $1, 'bulk ' || g, 'bulk' || g, 'bot', 'running', '/srv/bulk' || g, 'hash-bulk' || g,
                now() - interval '1 hour'
           FROM generate_series(1, $2::int) g`,
        [OWNER, PRODUCTS_CAP],
      );
      // Самый старый, но единственный живой — обязан попасть в выдачу первым.
      const active = await mkProduct({ slug: 'active', created: '100 days', seen: '1 minute' });
      // Молчащий, но самый новый — вторым: за край отсекаются старые молчащие.
      const fresh = await mkProduct({ slug: 'fresh', kind: 'bot', created: '1 minute' });

      const res = await svc().list({});
      expect(res.products).toHaveLength(PRODUCTS_CAP);
      expect(res.products.slice(0, 2).map((r) => r.id)).toEqual([active, fresh]);
    });
  });

  // ——— карточка ———

  describe('карточка', () => {
    beforeEach(() => mkHost());

    it('продукт — той же формы, что строка списка; домен, ходы и задания рядом', async () => {
      await mkProfile(OWNER, { name: 'Дмитрий', email: 'd@example.com' });
      const id = await mkProduct({ slug: 'card', seen: '5 minutes' });
      await mkDomain(id, 'dmitryvolkov.ru', 'failed', { error: 'сертификат не выпущен', reason: 'issue_failed', checked: '2 hours' });
      const turn = await mkTurn(id, { ago: '1 hour', tokens: 321, status: 'failed', result: null, error: 'раннер упал', channel: 'telegram' });
      const job = (
        await pool.query(
          `INSERT INTO product_provision_jobs (product_id, kind, status, error, created_at, finished_at)
           VALUES ($1, 'domain', 'failed', 'отказ Let''s Encrypt', now() - interval '2 hours', now() - interval '110 minutes')
           RETURNING id, created_at, finished_at`,
          [id],
        )
      ).rows[0];

      const card = await svc().card(id);
      const [inList] = (await svc().list({})).products;

      expect(card.product).toEqual(inList);
      const d = (await pool.query(`SELECT checked_at FROM product_domains WHERE product_id = $1`, [id])).rows[0];
      expect(card.domain).toEqual({
        domain: 'dmitryvolkov.ru',
        domainUnicode: 'dmitryvolkov.ru',
        names: ['dmitryvolkov.ru', 'www.dmitryvolkov.ru'],
        status: 'failed',
        error: 'сертификат не выпущен',
        errorReason: 'issue_failed',
        checkedAt: d.checked_at.toISOString(),
      });
      const t = (await pool.query(`SELECT started_at, finished_at FROM product_turns WHERE id = $1`, [turn])).rows[0];
      expect(card.turns).toEqual([
        {
          id: turn,
          channel: 'telegram',
          status: 'failed',
          prompt: 'поправь шапку',
          result: null,
          tokensSpent: 321,
          error: 'раннер упал',
          startedAt: t.started_at.toISOString(),
          finishedAt: t.finished_at.toISOString(),
        },
      ]);
      expect(card.jobs).toEqual([
        {
          id: job.id,
          kind: 'domain',
          status: 'failed',
          error: "отказ Let's Encrypt",
          createdAt: job.created_at.toISOString(),
          finishedAt: job.finished_at.toISOString(),
        },
      ]);
    });

    it('без своего домена — domain: null, без ходов и заданий — пустые списки', async () => {
      const id = await mkProduct({ slug: 'bare' });
      // У соседа домен есть: карточка обязана не подхватить чужую строку.
      const neighbour = await mkProduct({ slug: 'neighbour' });
      await mkDomain(neighbour, 'neighbour.ru', 'active');

      const card = await svc().card(id);
      expect(card.domain).toBeNull();
      expect(card.product.customDomain).toBeNull();
      expect(card.turns).toEqual([]);
      expect(card.jobs).toEqual([]);
      expect((await svc().card(neighbour)).domain).toMatchObject({ domain: 'neighbour.ru', status: 'active' });
    });

    it(`тексты хода обрезаны до ${TEXT_CAP} знаков с многоточием, короткие — как есть`, async () => {
      const id = await mkProduct({ slug: 'long' });
      await mkTurn(id, { ago: '3 minutes', prompt: 'я'.repeat(TEXT_CAP + 1), result: 'r'.repeat(5000) });
      await mkTurn(id, { ago: '2 minutes', prompt: 'ы'.repeat(TEXT_CAP), result: null });

      const [exact, long] = (await svc().card(id)).turns;
      expect(exact.prompt).toBe('ы'.repeat(TEXT_CAP));
      expect(exact.result).toBeNull();
      expect(long.prompt).toBe('я'.repeat(TEXT_CAP) + '…');
      expect(long.result).toBe('r'.repeat(TEXT_CAP) + '…');
    });

    it('ходов — последние 50, заданий — последние 20, новые сверху', async () => {
      const id = await mkProduct({ slug: 'many' });
      await pool.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status, created_at)
         SELECT $1, $2, 'web', 'ход ' || g, 'done', now() - g * interval '1 minute'
           FROM generate_series(1, 55) g`,
        [id, OWNER],
      );
      await pool.query(
        `INSERT INTO product_provision_jobs (product_id, kind, status, error, created_at)
         SELECT $1, 'wake', 'done', 'задание ' || g, now() - g * interval '1 minute'
           FROM generate_series(1, 25) g`,
        [id],
      );

      const card = await svc().card(id);
      expect(card.turns.map((t) => t.prompt)).toEqual(Array.from({ length: 50 }, (_, i) => `ход ${i + 1}`));
      expect(card.jobs.map((j) => j.error)).toEqual(Array.from({ length: 20 }, (_, i) => `задание ${i + 1}`));
    });

    it('чужие ходы и задания в карточку не попадают', async () => {
      const mine = await mkProduct({ slug: 'mine' });
      const other = await mkProduct({ slug: 'other' });
      await mkTurn(other, { prompt: 'чужой ход' });
      await pool.query(`INSERT INTO product_provision_jobs (product_id, kind, status) VALUES ($1, 'sleep', 'done')`, [other]);

      const card = await svc().card(mine);
      expect(card.turns).toEqual([]);
      expect(card.jobs).toEqual([]);
    });

    it('открывается и для архивного продукта, и для продукта тестового аккаунта', async () => {
      const archived = await mkProduct({ slug: 'arch', archived: '1 day' });
      const test = await mkProduct({ slug: 'test', user: '79030169187' });

      expect((await svc().card(archived)).product).toMatchObject({ id: archived, slug: 'arch' });
      expect((await svc().card(archived)).product.archivedAt).not.toBeNull();
      expect((await svc().card(test)).product).toMatchObject({ id: test, owner: { userId: '79030169187' } });
    });

    it('неизвестный продукт — null', async () => {
      expect(await svc().card('00000000-0000-4000-8000-000000000000')).toBeNull();
    });
  });
});
