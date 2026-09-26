import { Injectable } from '@nestjs/common';
import { domainToASCII } from 'url';
import { PgService } from '../common/services/pg.service';
import { readableDomain } from '../products/domain-name';
import { testUsersFilterSql } from './admin.service';

/**
 * РАЗДЕЛ АДМИНКИ «САЙТЫ И БОТЫ» — продукты всех пользователей одним списком.
 *
 * До него общего списка продуктов у администратора не было вовсе (об этом
 * прямо пишут 007_selfservice.sql и BlockService): жалоба приходила с доменом,
 * и понять, чей это продукт, жив ли он и что с ним делали, можно было только
 * запросом в psql. Действий здесь нет намеренно — гашение и снятие остаются
 * маршрутами products/block и products/unblock (ключ — id из этой выдачи).
 *
 * Сервис только читает. Своим провайдером, а не дописью в AdminService (тот
 * уже за две с половиной тысячи строк) и не в ProductsService (тот обслуживает
 * кабинет владельца и по правилу COLUMNS не отдаёт ни машину, ни чужих
 * владельцев).
 */

/** Потолок строк списка. Продуктов сегодня десятки; потолок — от случайной тысячи. */
export const PRODUCTS_CAP = 500;

/**
 * Потолок длины prompt и result хода в карточке, в знаках. Результат хода —
 * это отчёт агента, иногда с кусками файлов; пятьдесят таких целиком — мегабайты
 * ответа ради того, чтобы глазами пробежать ленту.
 */
export const TEXT_CAP = 2000;

/** Сколько последних ходов и заданий показывает карточка. */
export const CARD_TURNS = 50;
export const CARD_JOBS = 20;

const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 365;

/** Потолок поискового запроса: сверх него это уже не поиск, а вставленный текст. */
const MAX_QUERY_LENGTH = 200;

/** Фильтры списка — как они приходят из query-параметров после контроллера. */
export interface AdminProductsQuery {
  q?: string;
  /** Статусы через запятую; повторённый ключ express отдаёт массивом. */
  status?: string | string[];
  kind?: string;
  periodDays?: number;
  includeTest?: boolean;
  includeArchived?: boolean;
}

export interface AdminProductRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  status: string;
  /** Адрес платформы (slug.p.linkeon.io); у бота пуст. */
  domain: string | null;
  /** Свой домен — заявка в ЛЮБОМ состоянии, не только active, как в кабинете. */
  customDomain: { domain: string; domainUnicode: string; status: string } | null;
  owner: { userId: string; name: string | null; email: string | null };
  host: { id: string; publicIp: string | null } | null;
  createdAt: string;
  archivedAt: string | null;
  paidUntil: string | null;
  runnerSeenAt: string | null;
  sleepReason: string | null;
  blockReason: string | null;
  provisionError: string | null;
  lastTurnAt: string | null;
  lastActivityAt: string | null;
  turnsInPeriod: number;
  tokensInPeriod: number;
}

export interface AdminProductDomain {
  domain: string;
  domainUnicode: string;
  names: string[];
  status: string;
  error: string | null;
  errorReason: string | null;
  checkedAt: string | null;
}

export interface AdminProductTurn {
  id: string;
  channel: string;
  status: string;
  prompt: string;
  result: string | null;
  tokensSpent: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AdminProductJob {
  id: string;
  kind: string;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AdminProductCard {
  product: AdminProductRow;
  domain: AdminProductDomain | null;
  turns: AdminProductTurn[];
  jobs: AdminProductJob[];
}

/** Имя из анкеты. Имя из одних пробелов — это «имени нет», а не пустая подпись. */
const OWNER_NAME = `NULLIF(TRIM(a.profile_data->>'name'), '')`;

/**
 * Почта владельца: анкетная, а если её нет — почта входа. У аккаунтов,
 * заведённых почтой или OAuth, user_id — UUID, а ai_profiles_consolidated.email
 * заполнен не всегда; без запасной почты такая строка — UUID без единого
 * человеческого признака. Тот же порядок, что в карточке пользователя
 * (AdminService.getUserActivity).
 */
const OWNER_EMAIL = `COALESCE(NULLIF(TRIM(a.email), ''), ident.email)`;

/** Последняя активность: позднее из последнего хода и отметки раннера. NULL не побеждает. */
const LAST_ACTIVITY = `GREATEST(lt.created_at, p.runner_seen_at)`;

/**
 * Строка продукта — ОДНА на список и карточку: карточка обязана показывать
 * продукт ровно так же, как строка, по которой в неё пришли. $1 — период в днях.
 *
 * ПОЧЕМУ ПОДЗАПРОСЫ ПО ХОДАМ LATERAL, А НЕ GROUP BY ПО ВСЕЙ ТАБЛИЦЕ. Индекс у
 * ходов один — idx_product_turns_product (product_id, created_at DESC), и оба
 * подзапроса идут по нему: последний ход — один шаг индекса, счётчики периода —
 * диапазон внутри своего продукта. GROUP BY product_id по окну периода читал бы
 * product_turns целиком (индекса по одному created_at нет) на каждый заход в
 * раздел, и цена росла бы с историей правок всех продуктов, а не с их числом.
 *
 * Последний ход — за всё время, а не в окне: продукт, который правили два
 * месяца назад, не «никогда не правился». Время хода — created_at (когда
 * попросили): по нему же идёт индекс и окно периода.
 *
 * Остальные соединения — по ключам: product_domains по PK product_id (строк на
 * продукт не больше одной — дублей в выдаче нет), product_hosts по PK,
 * ai_profiles_consolidated по UNIQUE user_id, user_identities — по индексу
 * idx_user_identities_user и LIMIT 1 (адресов входа бывает несколько, и
 * простой JOIN размножил бы строку продукта).
 *
 * Новых индексов раздел не заводит: runner_seen_at и status не
 * проиндексированы нарочно — отметку раннера пишут HOT-обновлениями (см.
 * TurnsService.touchRunner), и индекс по ней это бы сломал ради страницы,
 * которую открывает один человек.
 */
const ROW_SQL = `
  SELECT p.id, p.name, p.slug, p.kind, p.status, p.domain,
         p.created_at, p.archived_at, p.paid_until, p.runner_seen_at,
         p.sleep_reason, p.block_reason, p.provision_error,
         p.user_id AS owner_user_id,
         ${OWNER_NAME} AS owner_name,
         ${OWNER_EMAIL} AS owner_email,
         h.id AS host_id,
         -- host(), а не ::text: inet печатает себя с маской, «10.0.0.5/32».
         host(h.public_ip) AS host_public_ip,
         d.domain AS custom_domain,
         d.status AS custom_domain_status,
         lt.created_at AS last_turn_at,
         ${LAST_ACTIVITY} AS last_activity_at,
         pt.turns AS turns_in_period,
         pt.tokens AS tokens_in_period
    FROM products p
    LEFT JOIN product_domains d ON d.product_id = p.id
    LEFT JOIN product_hosts h ON h.id = p.host_id
    LEFT JOIN ai_profiles_consolidated a ON a.user_id = p.user_id
    LEFT JOIN LATERAL (
      SELECT ui.email
        FROM user_identities ui
       WHERE ui.user_id = p.user_id AND NULLIF(ui.email, '') IS NOT NULL
       ORDER BY ui.email_verified DESC, ui.created_at
       LIMIT 1
    ) ident ON true
    LEFT JOIN LATERAL (
      SELECT t.created_at
        FROM product_turns t
       WHERE t.product_id = p.id
       ORDER BY t.created_at DESC
       LIMIT 1
    ) lt ON true
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS turns, COALESCE(sum(t.tokens_spent), 0)::bigint AS tokens
        FROM product_turns t
       WHERE t.product_id = p.id AND t.created_at >= now() - $1::int * interval '1 day'
    ) pt`;

/** '%', '_' и сама '\' — служебные символы LIKE; без экранирования «100%» совпадает со всем. */
const escapeLike = (s: string) => s.replace(/([\\%_])/g, '\\$1');

/** Дата из базы → ISO-строка. node-pg отдаёт timestamptz объектом Date. */
const iso = (v: any): string | null => (v == null ? null : new Date(v).toISOString());

/** Обрезанный базой текст получает многоточие — признак, что это не весь текст. */
const cut = (s: string | null, wasLonger: boolean): string | null =>
  s == null ? null : wasLonger ? `${s}…` : s;

@Injectable()
export class AdminProductsService {
  constructor(private readonly pg: PgService) {}

  /**
   * Период в днях: нечисло — 30, дробь отбрасывается, остальное прижимается к
   * 1…365. NaN в `$1::int` — это ошибка Postgres, а не пустой раздел.
   */
  private static periodDays(v: unknown): number {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : DEFAULT_PERIOD_DAYS;
    return Math.min(Math.max(n, 1), MAX_PERIOD_DAYS);
  }

  /** Статусы из строки через запятую (или повторённого ключа). Пустые куски не фильтр. */
  private static statuses(v: unknown): string[] {
    const raw = Array.isArray(v) ? v.join(',') : typeof v === 'string' ? v : '';
    return [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  /**
   * Условие поиска. Один шаблон на все текстовые поля — имя, слаг, адрес
   * платформы, свой домен, владелец (номер или UUID, имя, почта).
   *
   * Идентификатор продукта — только точным совпадением: подстрока по UUID
   * «находила» бы любой продукт по одной букве a–f.
   *
   * Свой домен в базе лежит punycode (форма 008), а в жалобу его вставляют
   * так, как видели в браузере, — «пример.рф». Поэтому запрос с не-ASCII
   * символами ищется ещё и в punycode-форме. Совпадает она целыми метками:
   * «пример» найдёт «пример.рф», а «приме» — нет.
   */
  private static searchWhere(q: string, params: any[]): string {
    const lower = q.toLowerCase();
    params.push(`%${escapeLike(q)}%`);
    const like = `$${params.length}`;
    const conds = [
      `p.name ILIKE ${like}`,
      `p.slug ILIKE ${like}`,
      `p.domain ILIKE ${like}`,
      `d.domain ILIKE ${like}`,
      `p.user_id ILIKE ${like}`,
      `${OWNER_NAME} ILIKE ${like}`,
      `${OWNER_EMAIL} ILIKE ${like}`,
    ];
    params.push(lower);
    conds.push(`p.id::text = $${params.length}`);
    // Только для не-ASCII: чисто латинский запрос в punycode не меняется, а
    // цифры WHATWG-разбор превратил бы в IPv4-адрес («7999000» → «0.122.13.184»).
    const puny = /[^\x00-\x7f]/.test(lower) ? domainToASCII(lower) : '';
    if (puny) {
      params.push(`%${escapeLike(puny)}%`);
      conds.push(`d.domain ILIKE $${params.length}`);
    }
    return `(${conds.join(' OR ')})`;
  }

  private static toRow(r: any): AdminProductRow {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      kind: r.kind,
      status: r.status,
      domain: r.domain ?? null,
      customDomain: r.custom_domain
        ? {
            domain: r.custom_domain,
            // Браузер сам punycode в юникод не переводит, в Postgres нет
            // IDN-функций — перевод здесь, тем же readableDomain, что у кабинета.
            domainUnicode: readableDomain(r.custom_domain),
            status: r.custom_domain_status,
          }
        : null,
      owner: { userId: r.owner_user_id, name: r.owner_name ?? null, email: r.owner_email ?? null },
      host: r.host_id ? { id: r.host_id, publicIp: r.host_public_ip ?? null } : null,
      createdAt: iso(r.created_at),
      archivedAt: iso(r.archived_at),
      paidUntil: iso(r.paid_until),
      runnerSeenAt: iso(r.runner_seen_at),
      sleepReason: r.sleep_reason ?? null,
      blockReason: r.block_reason ?? null,
      provisionError: r.provision_error ?? null,
      lastTurnAt: iso(r.last_turn_at),
      lastActivityAt: iso(r.last_activity_at),
      // count приезжает числом (::int), сумма bigint — строкой: в number её
      // переводим сами, иначе фронт складывал бы строки.
      turnsInPeriod: Number(r.turns_in_period) || 0,
      tokensInPeriod: Number(r.tokens_in_period) || 0,
    };
  }

  /**
   * Список продуктов. Архивные и продукты тестовых аккаунтов скрыты по
   * умолчанию — у владельца это большая часть продуктов, и без фильтра раздел
   * показывает не клиентов, а прогоны. Порядок — по последней активности
   * (молчащие в конце), дальше новые выше; id — чтобы порядок не плясал между
   * обновлениями страницы.
   */
  async list(opts: AdminProductsQuery = {}): Promise<{ periodDays: number; products: AdminProductRow[] }> {
    const periodDays = AdminProductsService.periodDays(opts.periodDays);
    const params: any[] = [periodDays];
    const where = [testUsersFilterSql('p.user_id', opts.includeTest)];
    if (!opts.includeArchived) where.push('p.archived_at IS NULL');

    // Незнакомая форма фильтр не ставит: у раздела нет «вкладки по
    // умолчанию», и снятый фильтр здесь — это просто все продукты.
    if (opts.kind === 'site' || opts.kind === 'bot') {
      params.push(opts.kind);
      where.push(`p.kind = $${params.length}`);
    }

    // Незнакомый статус, наоборот, фильтр ставит и честно даёт пустоту:
    // «показать sleepng» не должно молча показывать всё.
    const statuses = AdminProductsService.statuses(opts.status);
    if (statuses.length) {
      params.push(statuses);
      where.push(`p.status = ANY($${params.length}::text[])`);
    }

    const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, MAX_QUERY_LENGTH) : '';
    if (q) where.push(AdminProductsService.searchWhere(q, params));

    const r = await this.pg.query(
      `${ROW_SQL}
        WHERE ${where.join(' AND ')}
        ORDER BY ${LAST_ACTIVITY} DESC NULLS LAST, p.created_at DESC, p.id DESC
        LIMIT ${PRODUCTS_CAP}`,
      params,
    );
    return { periodDays, products: r.rows.map((row: any) => AdminProductsService.toRow(row)) };
  }

  /**
   * Карточка продукта. Ищется по id БЕЗ фильтров списка: сюда приходят по
   * конкретному продукту — из списка с включёнными флагами или по ссылке, — и
   * архивный или тестовый продукт здесь тот самый, который хотят посмотреть.
   *
   * null — продукта нет; 404 из этого делает контроллер. id проверен им же
   * (assertUuid): мусор в `p.id = $2` — это 22P02 и 500, а не «не найдено».
   */
  async card(id: string, opts: { periodDays?: number } = {}): Promise<AdminProductCard | null> {
    const periodDays = AdminProductsService.periodDays(opts.periodDays);
    const r = await this.pg.query(`${ROW_SQL} WHERE p.id = $2`, [periodDays, id]);
    if (!r.rows[0]) return null;

    const [domainRes, turnsRes, jobsRes] = await Promise.all([
      this.pg.query(
        `SELECT domain, names, status, error, error_reason, checked_at
           FROM product_domains WHERE product_id = $1`,
        [id],
      ),
      // Обрезает база, а не JS: иначе полный результат каждого из пятидесяти
      // ходов ехал бы из Postgres целиком ради двух тысяч знаков. left() и
      // length() считают знаки, а не байты, — кириллица режется по букве.
      this.pg.query(
        `SELECT id, channel, status,
                left(prompt, ${TEXT_CAP}) AS prompt, length(prompt) > ${TEXT_CAP} AS prompt_cut,
                left(result, ${TEXT_CAP}) AS result, length(result) > ${TEXT_CAP} AS result_cut,
                tokens_spent, error, started_at, finished_at
           FROM product_turns
          WHERE product_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT ${CARD_TURNS}`,
        [id],
      ),
      // Индекса по product_id у заданий нет (только частичный уникальный по
      // активным), так что это проход по таблице. Заданий у продукта единицы —
      // заведение, сон и пробуждение по аренде, домен, — и таблица на всех
      // продуктах остаётся маленькой. Вырастет — индекс (product_id,
      // created_at DESC) отдельной миграцией модуля продуктов.
      this.pg.query(
        `SELECT id, kind, status, error, created_at, finished_at
           FROM product_provision_jobs
          WHERE product_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT ${CARD_JOBS}`,
        [id],
      ),
    ]);

    const d = domainRes.rows[0];
    return {
      product: AdminProductsService.toRow(r.rows[0]),
      domain: d
        ? {
            domain: d.domain,
            domainUnicode: readableDomain(d.domain),
            names: d.names ?? [],
            status: d.status,
            error: d.error ?? null,
            errorReason: d.error_reason ?? null,
            checkedAt: iso(d.checked_at),
          }
        : null,
      turns: turnsRes.rows.map((t: any) => ({
        id: t.id,
        channel: t.channel,
        status: t.status,
        prompt: cut(t.prompt, t.prompt_cut === true),
        result: cut(t.result, t.result_cut === true),
        tokensSpent: t.tokens_spent == null ? null : Number(t.tokens_spent),
        error: t.error ?? null,
        startedAt: iso(t.started_at),
        finishedAt: iso(t.finished_at),
      })),
      jobs: jobsRes.rows.map((j: any) => ({
        id: j.id,
        kind: j.kind,
        status: j.status,
        error: j.error ?? null,
        createdAt: iso(j.created_at),
        finishedAt: iso(j.finished_at),
      })),
    };
  }
}
