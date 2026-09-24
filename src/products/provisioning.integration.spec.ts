import {
  ConflictException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import {
  BlockService,
  JOB_KILLED_BY_BLOCK,
  JOB_KILLED_BY_UNBLOCK,
  TURN_KILLED_BY_BLOCK,
} from './block.service';
import { HostGuard } from './host.guard';
import { HostsService } from './hosts.service';
import { DEFAULT_MAX_PRODUCTS, LimitsService } from './limits.service';
import { MIGRATIONS, ProductsService } from './products.service';
import { ProvisioningService } from './provisioning.service';
import { RentService } from './rent.service';
import { SecretsService } from './secrets.service';
import { BLOCKED_REFUSAL, SLEEPING_REFUSAL, TurnsService } from './turns.service';

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

  /**
   * НАСТОЯЩИЕ HostsService и LimitsService на том же пуле, а не заглушки.
   * Выбор машины и предел аккаунта — по одному запросу каждый, и всё, что в них
   * можно сломать (потолок в SQL, счёт по своей машине, ORDER BY, скалярные
   * счётчики причин, COALESCE умолчания, отбор по archived_at), заглушка не
   * исполняет вовсе. Заглушка предела, отдающая «можно» на любой вход, сделала
   * бы каждый сценарий ниже зелёным при полностью отсутствующей реализации.
   */
  const makeSvc = (probe?: (url: string, init?: any) => Promise<{ status: number }>) => {
    const svc = new ProvisioningService(pg as any, secrets, new HostsService(pg as any), new LimitsService(pg as any));
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
    // Схема накатывается ТЕМИ ЖЕ файлами и В ТОМ ЖЕ ПОРЯДКЕ, что и в проде —
    // по общему списку MIGRATIONS, а не по своей копии. Переписанный руками DDL
    // разъехался бы с миграциями молча, и файл проверял бы выдуманную базу;
    // собственный список файлов расходился бы так же — забытая в нём новая
    // миграция даёт «column does not exist» в сценарии, который к ней
    // отношения не имеет.
    for (const f of MIGRATIONS) {
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
      'TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts, product_user_limits RESTART IDENTITY CASCADE',
    );
    await pool?.end();
  });

  beforeEach(async () => {
    // product_host_agent — в том же списке: отметка о жизни агента переживает
    // сценарий и молча делает следующий зелёным. Сценарий «отметки нет вовсе»
    // (агента не пускают по токену) иначе проверял бы чужую отметку.
    //
    // product_hosts — по той же причине и с той же ценой: реестр машин
    // переживает сценарий, а «машина own заводится» проверялось бы на машине,
    // заведённой соседом. Обе таблицы в ОДНОМ операторе — products ссылается на
    // product_hosts, и порознь TRUNCATE отобьётся внешним ключом.
    //
    // product_user_limits — третья того же рода и добавлена ВМЕСТЕ с таблицей,
    // а не после первой неприятности: поднятый потолок переживал бы сценарий, и
    // соседний «третий продукт отбивается» зеленел бы (или краснел) на чужом
    // исключении. Внешнего ключа у неё нет, в CASCADE она попадает просто как
    // член списка.
    await pool.query(
      'TRUNCATE products, product_provision_jobs, product_turns, product_host_agent, product_hosts, product_user_limits RESTART IDENTITY CASCADE',
    );
  });

  afterEach(() => jest.restoreAllMocks());

  // ——— фикстуры ———

  let seq = 0;

  type Seed = {
    slug?: string;
    /**
     * Владелец. По умолчанию 'u-1' — тот же, что был вписан в фикстуру
     * константой до появления предела на аккаунт.
     *
     * Поле заведено ради сценариев 87–95: предел считает продукты ОДНОГО
     * владельца, и «сосед не занимает моё место» на фикстуре с одним
     * захардкоженным владельцем не выражается вовсе.
     */
    userId?: string;
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
    /**
     * ПУБЛИЧНЫЙ ДОМЕН. По умолчанию — слаг в зоне СВОЕЙ машины, ровно как его
     * пишет create(); у бота NULL по форме.
     *
     * Умолчание здесь не удобство, а воспроизведение прода: проба promoteReady
     * собирает адрес из `products.domain` (зона своя у каждой машины реестра,
     * склеивать её из константы больше нельзя). Фикстура, оставлявшая домен
     * пустым, описывала бы сайт, до которого не может дойти и владелец, —
     * такой продукт не переводится в running вовсе, и половина сценариев
     * проверяла бы этот отказ вместо того, ради чего написана.
     *
     * `null` — сайт БЕЗ домена: аномалия, которую надо было уметь описать
     * (сценарий 51о).
     */
    domain?: string | null;
    /**
     * МЕТКА МАШИНЫ. По умолчанию 'own', и машина заводится в реестре сама.
     *
     * Умолчание здесь не удобство, а воспроизведение прода: с куска 4а живой
     * продукт без метки — аномалия, 005 на нём нарочно отказывает, а выдача
     * заданий его не видит вовсе (`p.host_id = NULL` не равно ничему).
     * Фикстура, оставляющая метку пустой, проверяла бы базу, которой на проде
     * не бывает, — и главный сценарий куска был бы зелен на любой реализации,
     * потому что никому не досталось бы ничего.
     *
     * `null` — продукт БЕЗ метки: состояние до накатки 005 (сценарии 40–42) и
     * дыра, которую закрывает задача 4 (create() метку ещё не ставит, 46г).
     */
    host?: string | null;
  };

  /**
   * Машина в реестре по требованию: строка заводится, если её ещё нет.
   *
   * Отдельно от addHost, у которого другая работа — завести машину С ЗАДАННЫМИ
   * свойствами и упасть, если так нельзя (потолок, дубль адреса, дубль хеша).
   * Здесь же нужна ровно строка, на которую сошлётся внешний ключ продукта.
   */
  const HOST_IPS = new Map<string, string>([['own', '139.59.210.42']]);
  let ensuredSeq = 0;
  const suffixOf = (id: string) => (id === 'own' ? 'p.linkeon.io' : 'c.linkeon.io');
  async function ensureHost(id: string) {
    let ip = HOST_IPS.get(id);
    if (!ip) {
      // Своя подсеть, не пересекающаяся с 10.0.0.x у addHost: адрес машины
      // UNIQUE, и столкновение двух фикстур давало бы отказ вставки в сценарии,
      // который про адреса не знает вовсе.
      ip = `10.99.0.${++ensuredSeq}`;
      HOST_IPS.set(id, ip);
    }
    await pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix,
                                  agent_token_hash, capacity, audience)
       VALUES ($1, $2, $3, $4, $5, 20, $6)
       ON CONFLICT DO NOTHING`,
      [
        id,
        `root@${ip}`,
        ip,
        suffixOf(id),
        sha(`токен ${id}`),
        id === 'own' ? 'own' : 'clients',
      ],
    );
    return { id, ip, suffix: suffixOf(id) };
  }

  async function product(o: Seed = {}) {
    const id = crypto.randomUUID();
    const slug = o.slug ?? `p-${seq++}`;
    const name = o.name ?? `имя ${slug}`;
    const box = o.secrets ? secrets.encrypt(o.secrets, id) : null;
    // Адрес машины пишется ВМЕСТЕ с меткой, а не вместо неё: на проде обе
    // колонки заполняет один INSERT заведения, и сопоставление 005 по адресу
    // проверяется на продукте, у которого адрес есть.
    const host = o.host === null ? null : await ensureHost(o.host ?? 'own');
    const kind = o.kind ?? 'site';
    // Домен собирается из зоны ВЫБРАННОЙ машины — тем же правилом, что в
    // create(). Продукт без машины домена не получает: собирать его не из чего.
    const domain =
      o.domain !== undefined
        ? o.domain
        : kind === 'site' && host
          ? `${slug}.${host.suffix}`
          : null;
    await pool.query(
      `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path,
                             runner_token_hash, secrets_encrypted, port,
                             runner_seen_at, created_at, host_id, host_ip, domain)
       VALUES ($1, $14, $10, $2, $3, $4, '/product', $5, $6, $7,
               CASE WHEN $8::text IS NULL THEN NULL ELSE now() - $8::interval END,
               now() - $9::interval, $11, $12, $13)`,
      [
        id,
        slug,
        kind,
        o.status ?? 'provisioning',
        // Стартовый хеш у каждого продукта СВОЙ: колонка UNIQUE, а сценарии
        // ниже отличают «хеш повернулся» от «остался прежним».
        crypto.randomBytes(32).toString('hex'),
        box,
        o.port ?? null,
        o.seenAgo ?? null,
        o.createdAgo ?? '1 second',
        name,
        host?.id ?? null,
        host?.ip ?? null,
        domain,
        o.userId ?? 'u-1',
      ],
    );
    return { id, slug, name, domain };
  }

  type JobSeed = {
    status?: string;
    /**
     * Вид работы. ПО УМОЛЧАНИЮ НЕ ПЕРЕДАЁТСЯ ВОВСЕ — колонка не перечисляется
     * в INSERT, и значение ставит DEFAULT базы. Это не экономия: единственный
     * INSERT заведения (provisioning.service.ts) вида тоже не передаёт, и
     * фикстура обязана воспроизводить именно его, иначе «задание без вида
     * доезжает как заведение» проверялось бы на строке, в которую вид вписали
     * руками.
     */
    kind?: 'provision' | 'sleep' | 'wake';
    createdAgo?: string;
    startedAgo?: string | null;
    finishedAgo?: string | null;
    error?: string | null;
  };

  async function job(productId: string, o: JobSeed = {}) {
    const id = crypto.randomUUID();
    // Колонка kind ЛИБО перечислена, ЛИБО отсутствует в операторе — никакого
    // COALESCE со строкой 'provision'. Подставленное умолчание доказывало бы
    // подстановку в фикстуре, а не DEFAULT в схеме.
    const kindCol = o.kind ? ', kind' : '';
    const kindVal = o.kind ? ', $8' : '';
    await pool.query(
      `INSERT INTO product_provision_jobs (id, product_id, status, error, created_at, started_at, finished_at${kindCol})
       VALUES ($1, $2, $3, $4, now() - $5::interval,
               CASE WHEN $6::text IS NULL THEN NULL ELSE now() - $6::interval END,
               CASE WHEN $7::text IS NULL THEN NULL ELSE now() - $7::interval END${kindVal})`,
      [
        id,
        productId,
        o.status ?? 'queued',
        o.error ?? null,
        o.createdAgo ?? '1 second',
        o.startedAgo ?? null,
        o.finishedAgo ?? null,
        ...(o.kind ? [o.kind] : []),
      ],
    );
    return id;
  }

  /**
   * МАШИНА В РЕЕСТРЕ. На верхнем уровне, а не внутри своего describe: с куска
   * 4а живой продукт без машины — аномалия, и 005 на нём отказывает нарочно,
   * поэтому машина нужна и сценариям про рестарт API.
   */
  let hostSeq = 2;
  const addHost = (o: {
    id: string;
    ip?: string;
    hash?: string;
    capacity?: number;
    audience?: string;
    suffix?: string;
    acceptsNew?: boolean;
  }) => {
    const ip = o.ip ?? `10.0.0.${hostSeq++}`;
    return pool.query(
      `INSERT INTO product_hosts (id, ssh_target, public_ip, domain_suffix,
                                  agent_token_hash, capacity, accepts_new, audience)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        o.id,
        `root@${ip}`,
        ip,
        o.suffix ?? 'c.linkeon.io',
        o.hash ?? sha(o.id),
        o.capacity ?? 20,
        o.acceptsNew ?? true,
        o.audience ?? 'clients',
      ],
    );
  };

  const hosts = async () => (await pool.query('SELECT * FROM product_hosts ORDER BY id')).rows;

  /** Текст файла миграции — тот же, что накатывает модуль при старте API. */
  const migrationSql = (file: string) =>
    fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8');

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

    const claimed = await makeSvc().claimJob('own');

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
      // Вид ЗАДАНИЯ приезжает из базы. Колонка NOT NULL DEFAULT 'provision', а
      // фикстура `job()` вида не передаёт — то есть это ещё и живая проверка
      // того, что задание, поставленное БЕЗ вида (а других INSERT-ов у
      // заведения нет), доезжает до агента как заведение. Мок такого не
      // доказывает: он отдаёт ровно то, что в него положили.
      jobKind: 'provision',
      port: null,
      runnerToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      secrets: { BOT_TOKEN: '123:abc' },
      // Расширение контракта (свой домен): имена приезжают в каждом задании —
      // у продукта без своего домена пустым списком; режим у заводящегося —
      // прокси. Поведение обоих полей — в domains.jobs.spec.ts.
      customNames: [],
      vhostMode: 'proxy',
    });
    expect(Buffer.isBuffer((await getProduct(p.id)).secrets_encrypted)).toBe(true);

    const after = await getJob(j);
    expect(after.status).toBe('running');
    expect(after.started_at).toBeInstanceOf(Date);
    // Хеш повернулся ИМЕННО у продукта выданного задания.
    expect((await getProduct(p.id)).runner_token_hash).toBe(sha(claimed!.runnerToken!));
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
    for (let i = 0; i < slugs.length; i++) got.push((await svc.claimJob('own'))!.slug);

    expect(got).toEqual(slugs);
    expect(await svc.claimJob('own')).toBeNull();
  });

  it('3. пять ОДНОВРЕМЕННЫХ claim на пять заданий расходятся по разным продуктам', async () => {
    const made = [];
    for (let i = 0; i < 5; i++) {
      const p = await product({ slug: `race5-${i}` });
      await job(p.id);
      made.push(p);
    }
    const svc = makeSvc();

    const claims = await Promise.all([0, 1, 2, 3, 4].map(() => svc.claimJob('own')));

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

    const claims = await Promise.all([0, 1, 2, 3, 4].map(() => svc.claimJob('own')));

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
      const claimed = await makeSvc().claimJob('own');
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
      expect((await makeSvc().claimJob('own'))!.jobId).toBe(j);
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

    expect(await makeSvc().claimJob('own')).toBeNull();

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
    expect((await makeSvc().claimJob('own'))!.jobId).toBe(jid);
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
    await ensureHost('own');
    const svc = makeSvc();

    const { productId } = await svc.create({
      userId: 'u-1',
      isAdmin: true,
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
    // МЕТКУ МАШИНЫ СТАВИТ САМО ЗАВЕДЕНИЕ (задача 4). До неё продукт не был
    // виден ни одному агенту: задание висело в очереди, через десять минут его
    // хоронил сборщик зависших, и владелец читал про истёкший срок. Здесь это
    // видно сквозным ходом — заведённый продукт немедленно достаётся агенту
    // своей машины, без единой правки руками.
    expect(row.host_id).toBe('own');
    const claimed = await makeSvc().claimJob('own');
    expect(claimed!.productId).toBe(productId);
    expect(claimed!.secrets).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('18в. заведение прописывает домен, адрес хоста и адрес проверки здоровья', async () => {
    // НАЙДЕНО ЖИВОЙ ПРОВЕРКОЙ, тестами поймать было нечем. Ручной
    // product-provision.sh три эти колонки заполнял, автозаведение — ни одну,
    // и всё выглядело исправным: сайт поднялся, отдал 200 со сходящимся sha,
    // встал в running.
    //
    // Ломалось в двух местах, и оба молчат:
    //   domain      — кабинет рисует ссылку из него, пустой = владелец не
    //                 может дойти до своего работающего сайта. promoteReady
    //                 собирает адрес проверки из слага сам, поэтому переход
    //                 в running проходил и ничего не сообщал.
    //   health_url  — waitHealthy(null) возвращает ИСТИНУ («адреса нет,
    //                 считаем здоровым»). У каждого автозаведённого продукта
    //                 проверка после правки проходила всегда, и автооткат не
    //                 мог сработать ни разу.
    await ensureHost('own');
    const svc = makeSvc();

    const site = await svc.create({
      userId: 'u-1',
      isAdmin: true,
      name: 'сайт',
      slug: 'polya-site',
      kind: 'site',
      secrets: {},
    });
    const bot = await svc.create({
      userId: 'u-1',
      isAdmin: true,
      name: 'бот',
      slug: 'polya-bot',
      kind: 'bot',
      secrets: {},
    });

    const s = await getProduct(site.productId);
    expect(s.domain).toBe('polya-site.p.linkeon.io');
    expect(s.host_ip).toBe('139.59.210.42');
    // Адрес внутри контейнера, а не порт на петле хоста: раннер живёт внутри
    // и до 127.0.0.1:8003 хоста не дотянется.
    expect(s.health_url).toBe('http://127.0.0.1:3000/health');

    // У бота домена нет по форме, а не по недосмотру — он не принимает
    // входящих соединений. Проверка здоровья ему нужна ровно так же.
    const b = await getProduct(bot.productId);
    expect(b.domain).toBeNull();
    expect(b.health_url).toBe('http://127.0.0.1:3000/health');
  });

  it('18б. занятый слаг отбивается 409 ещё до выпуска токена', async () => {
    await ensureHost('own');
    const svc = makeSvc();
    await svc.create({ userId: 'u-1', isAdmin: true, name: 'первый', slug: 'taken-slug', kind: 'site', secrets: {} });

    const e = await svc
      .create({ userId: 'u-2', isAdmin: true, name: 'второй', slug: 'taken-slug', kind: 'site', secrets: {} })
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
    await ensureHost('own');
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
    const svc = new ProvisioningService(racingPg as any, secrets, new HostsService(racingPg as any), new LimitsService(racingPg as any));

    const e = await svc
      .create({ userId: 'u-9', isAdmin: true, name: 'гонка', slug: 'raced-slug', kind: 'site', secrets: {} })
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
    // Машина заводится ДО подмены crypto: ensureHost считает sha256 токена
    // настоящим createHash, а спай ниже подменяет его на константу.
    await ensureHost('own');
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
      .create({ userId: 'u-2', isAdmin: true, name: 'другой', slug: 'hash-clash', kind: 'site', secrets: {} })
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
    const claimed = await makeSvc().claimJob('own');
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

  it('20а. выдача клиенту не несёт внутреннюю топологию машины продуктов', async () => {
    // Не секреты, но и не дело кабинета: адрес хоста, путь чекаута, команды
    // сборки и перезапуска, адрес health и id сессии Claude. Их читают агент
    // хоста и раннер внутри контейнера — каждый своим запросом. Сторож здесь,
    // а не только на заглушке pg: проверка текста запроса переживает
    // `SELECT *`, а эта — нет.
    await product({ slug: 'vydacha-topologiya', status: 'running' });

    const rows = await new ProductsService(pg as any).list('u-1');

    expect(rows).toHaveLength(1);
    for (const column of [
      'host_ip',
      'checkout_path',
      'build_cmd',
      'restart_cmd',
      'health_url',
      'repo_url',
      'claude_session_id',
      'port',
    ]) {
      expect(Object.keys(rows[0])).not.toContain(column);
    }
    // В обратную сторону: то, что рисует карточка, обязано приезжать. Один
    // только запрет зеленел бы и на выдаче, где не осталось ничего.
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        // Гашение администратором (миграция 007). По той же причине, что и
        // sleep_reason: статус 'blocked' сам по себе владельцу не объясняет
        // ничего, а общего списка продуктов у администратора нет — спросить
        // владельцу больше негде.
        'block_reason',
        'created_at',
        'domain',
        'id',
        'kind',
        'name',
        // Аренда (миграция 004): до какого числа оплачено и почему спит.
        // Без них карточка показывает «остановлен» без объяснения, и владелец
        // читает штатный сон как нашу поломку.
        'paid_until',
        'provision_error',
        'runner_seen_at',
        'sleep_reason',
        'slug',
        'status',
        'user_id',
      ].sort(),
    );
  });

  it('20б. заведённому продукту аренда оплачена на месяц вперёд', async () => {
    // Первый месяц бесплатно — решение владельца, и держится оно ровно на
    // DEFAULT у колонки: INSERT в provisioning.service.ts её не перечисляет.
    // Сторож против «срок появится когда-нибудь потом»: с пустым paid_until
    // продукт выпадает из отбора сборщика (`paid_until <= now()` на NULL даёт
    // не-совпадение) и хостится бесплатно вечно, без единой строки в логе.
    //
    // Проверяется на живой базе, а не по тексту миграции: DEFAULT, не
    // доехавший до базы, читается в файле совершенно так же, как доехавший.
    await product({ slug: 'srok-oplaty', status: 'running' });

    const [row] = await new ProductsService(pg as any).list('u-1');

    const days = (new Date(row.paid_until).getTime() - Date.now()) / 86_400_000;
    // Окно в сутки с запасом: месяц — календарный, в феврале он короче.
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
  });

  it('20в. повторная накатка миграций не сдвигает уже выданный срок', async () => {
    // Модуль накатывает свою схему при КАЖДОМ старте API. Правка данных вида
    // `UPDATE products SET paid_until = now() + interval '1 month'
    //  WHERE paid_until IS NULL` выглядит разовой, но при живом продукте с
    // истёкшим сроком (или при новом, у которого колонку не заполнили) она
    // перевыдавала бы бесплатный месяц на каждом рестарте. Здесь проверяется
    // ИСПОЛНЕНИЕМ: срок уводится в прошлое, файлы миграций накатываются заново,
    // срок обязан остаться в прошлом.
    // Машина и метка приезжают из фикстуры: с куска 4а рестарт накатывает ещё
    // и 005, а она нарочно отказывает на живом продукте без машины. Живой
    // продукт без машины — аномалия, и сценарий про срок оплаты не должен
    // проверять базу, которой на проде не бывает.
    const p = await product({ slug: 'povtor-migracii', status: 'running' });
    await pool.query(`UPDATE products SET paid_until = now() - interval '5 days' WHERE id = $1`, [
      p.id,
    ]);

    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }

    const after = await pool.query('SELECT paid_until FROM products WHERE id = $1', [p.id]);
    expect(new Date(after.rows[0].paid_until).getTime()).toBeLessThan(Date.now());
  });

  it('20г. продукт, заведённый ДО выката, получает срок самой накаткой', async () => {
    // Случай demo и shop2 — единственный, ради которого в плане стояла
    // отдельная правка данных. Она не нужна: `ADD COLUMN ... DEFAULT` в
    // PostgreSQL проставляет существующим строкам значение, вычисленное в
    // момент ALTER. Утверждение НЕ вычитывается из документации, а
    // проверяется исполнением: поведение зависит от волатильности выражения
    // по умолчанию, и «должно работать» здесь стоит ровно столько же, сколько
    // «тесты зелёные» в куске 2 стоили против отключённого автоотката.
    //
    // База возвращается в состояние до 004 буквально: продукт заводится, когда
    // колонки ещё нет.
    await pool.query('ALTER TABLE products DROP COLUMN paid_until');
    const rent = fs.readFileSync(path.join(__dirname, 'migrations', '004_rent.sql'), 'utf8');
    try {
      const p = await product({ slug: 'do-vykata', status: 'running' });

      await pool.query(rent);

      const r = await pool.query('SELECT paid_until FROM products WHERE id = $1', [p.id]);
      const days = (new Date(r.rows[0].paid_until).getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
    } finally {
      // Колонку возвращаем при любом исходе. Иначе все следующие сценарии
      // падают на «column does not exist», и красным оказывается не то, что
      // сломалось. Повторная накатка безопасна — этим же файлом и проверяется.
      await pool.query(rent);
    }
  });

  it('20д. рестарт API при СПЯЩЕМ продукте не отбивает ни одной миграции', async () => {
    // Сон — не редкость и не авария, а штатное состояние неоплаченного
    // продукта, то есть ровно то, ради чего заведён кусок 3. А накатка схемы
    // при каждом старте API прогоняет ВЕСЬ список, включая 002, — и 002
    // навешивает СВОЙ словарь статусов на живые строки заново.
    //
    // Если словарь 002 не знает значения, которое умеет ставить 004, то первый
    // же уснувший продукт делает 002 мёртвой: ADD CONSTRAINT падает на его
    // строке, весь файл (простой протокол = неявная транзакция) откатывается,
    // applyMigration пишет строку в лог и едет дальше. Ни отказа старта, ни
    // тревоги — только недостающие впредь статьи 002.
    //
    // Проверяется ИСПОЛНЕНИЕМ: по тексту миграции такой отказ не виден совсем,
    // оба файла по отдельности безупречны и идемпотентны.
    // Машина и метка — из фикстуры, по той же причине, что в 20в: спящий
    // продукт на проде стоит на машине, как и всякий другой, а 005 на продукте
    // без машины отказывает нарочно.
    const p = await product({ slug: 'restart-asleep', status: 'running' });
    await pool.query(`UPDATE products SET status = 'sleeping' WHERE id = $1`, [p.id]);

    const refused: string[] = [];
    for (const f of MIGRATIONS) {
      try {
        await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
      } catch (e: any) {
        refused.push(`${f}: ${e.message}`);
      }
    }

    expect(refused).toEqual([]);
    // И продукт после рестарта по-прежнему спит: откатившаяся 002 не должна
    // была ни разбудить его, ни оставить таблицу без словаря.
    expect((await getProduct(p.id)).status).toBe('sleeping');
  });

  it('20е. рестарт API при БЛОКИРОВАННОМ продукте не отбивает ни одной миграции', async () => {
    // ТОТ ЖЕ КЛАСС, ЧТО 20д, И ТА ЖЕ ЦЕНА. Блокировка — штатное состояние
    // (администратор погасил недопустимый сайт, и продукт живёт так, пока
    // разбираются), а накатка схемы при каждом старте API прогоняет ВЕСЬ список,
    // включая 002 и 004: обе навешивают ИМЕНОВАННЫЙ словарь статусов на живые
    // строки заново. Файл, отставший от 007, падает на строке блокированного
    // продукта, целиком откатывается, applyMigration пишет строку в лог и едет
    // дальше — и становится мёртвым молча, навсегда.
    //
    // Проверяется ИСПОЛНЕНИЕМ: по тексту каждый файл в отдельности безупречен и
    // идемпотентен, отношение МЕЖДУ файлами в нём не видно.
    //
    // Сам UPDATE ниже — тоже утверждение, а не подготовка: словарь без 'blocked'
    // отобьёт его, и сценарий покраснеет на строке, где ставится статус.
    const p = await product({ slug: 'restart-blocked', status: 'running' });
    await pool.query(
      `UPDATE products SET status = 'blocked', block_reason = 'жалоба на содержимое' WHERE id = $1`,
      [p.id],
    );

    const refused: string[] = [];
    for (const f of MIGRATIONS) {
      try {
        await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
      } catch (e: any) {
        refused.push(`${f}: ${e.message}`);
      }
    }

    expect(refused).toEqual([]);
    // Рестарт не воскрешает погашенного и не теряет причину: владелец обязан
    // видеть в карточке, за что именно продукт остановлен, а не голое
    // «остановлен».
    const after = await getProduct(p.id);
    expect(after.status).toBe('blocked');
    expect(after.block_reason).toBe('жалоба на содержимое');
  });

  it('20ж. поднятый потолок аккаунта переживает повторную накатку', async () => {
    // Ловушка 004 с бесплатным месяцем, только с другой стороны. Файл
    // исполняется при КАЖДОМ старте API, и `CREATE TABLE IF NOT EXISTS` обязан
    // быть в нём ЕДИНСТВЕННЫМ, что касается этой таблицы: INSERT умолчания или
    // UPDATE «приведём к норме» сбрасывали бы поднятый вручную потолок на
    // каждом рестарте — молча, и заметно только по отказу заведения у человека,
    // которому потолок подняли месяц назад.
    await pool.query(
      `INSERT INTO product_user_limits (user_id, max_products, note)
       VALUES ('u-щедрый', 5, 'по просьбе владельца 22.09')`,
    );

    for (const f of MIGRATIONS) {
      await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    }

    const rows = (await pool.query('SELECT * FROM product_user_limits ORDER BY user_id')).rows;
    // И ровно одна строка: повторный CREATE TABLE не заводит дубль, а сама
    // накатка не добавляет строк никому.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].max_products)).toBe(5);
    expect(rows[0].note).toBe('по просьбе владельца 22.09');
  });

  it('20з. потолок аккаунта не бывает нулевым', async () => {
    // Ноль означал бы аккаунт, которому нельзя ничего, — запрет, неотличимый
    // для владельца от обычного отказа по потолку. Запрещать продукты — дело
    // статуса blocked, который называет причину вслух. Проверяется на живой
    // базе: CHECK, не доехавший до неё, читается в файле так же, как доехавший.
    await expect(
      pool.query(`INSERT INTO product_user_limits (user_id, max_products) VALUES ('u-ноль', 0)`),
    ).rejects.toThrow(/max_products/);
    await expect(
      pool.query(`INSERT INTO product_user_limits (user_id, max_products) VALUES ('u-минус', -1)`),
    ).rejects.toThrow(/max_products/);
  });

  it('20и. потолок аккаунта — ОДНА строка на владельца', async () => {
    // Потолок читается подзапросом без ORDER BY и без max(): вторая строка на
    // того же владельца означала бы потолок, выбираемый наугад. Единственность
    // держит база, а не аккуратность того, кто заводит исключение руками.
    await pool.query(
      `INSERT INTO product_user_limits (user_id, max_products) VALUES ('u-дубль', 5)`,
    );

    await expect(
      pool.query(`INSERT INTO product_user_limits (user_id, max_products) VALUES ('u-дубль', 9)`),
    ).rejects.toThrow(/product_user_limits_pkey/);
  });

  // ═══════════════ отметка о жизни агента хоста ═══════════════

  /**
   * Отметка машины `host` возрастом `ago`; null — отметки нет вовсе.
   *
   * Машина заводится в реестре по требованию: после 006 у отметки внешний ключ
   * на product_hosts, и строка отметки без машины не вставляется вовсе.
   */
  async function hostSeen(ago: string | null, host = 'own') {
    if (ago === null) return;
    await ensureHost(host);
    await pool.query(
      `INSERT INTO product_host_agent (host_id, seen_at) VALUES ($2, now() - $1::interval)
       ON CONFLICT (host_id) DO UPDATE SET seen_at = EXCLUDED.seen_at`,
      [ago, host],
    );
  }

  const hostRows = async () =>
    (await pool.query('SELECT host_id, seen_at FROM product_host_agent ORDER BY host_id')).rows;

  it('21. первый опрос агента заводит отметку', async () => {
    await ensureHost('own');
    expect(await hostRows()).toHaveLength(0);

    await makeSvc().touchHostAgent('own');

    const rows = await hostRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].host_id).toBe('own');
    // Отметка — про «сейчас», а не про «когда-нибудь». Вставка временем
    // процесса на разошедшихся часах дала бы либо вечную тревогу, либо вечное
    // спокойствие; здесь сверяется, что значение пришло от часов БАЗЫ.
    expect(Date.now() - new Date(rows[0].seen_at).getTime()).toBeLessThan(5_000);
  });

  it('21а. повторный опрос в пределах загрубления отметку не переписывает', async () => {
    // Агент опрашивает раз в три секунды: без условия это 28 800 записей в
    // сутки в одну строку.
    await hostSeen('5 seconds');
    const before = (await hostRows())[0].seen_at;

    await makeSvc().touchHostAgent('own');

    expect((await hostRows())[0].seen_at).toEqual(before);
  });

  it('21б. отметка старше загрубления двигается вперёд', async () => {
    // Обратная сторона предыдущего: условие, ставшее безусловным запретом
    // (например `< now() - interval '30 minutes'`), заморозило бы отметку
    // живого агента и зажгло бы тревогу на исправной машине.
    await hostSeen('40 seconds');
    const before = (await hostRows())[0].seen_at;

    await makeSvc().touchHostAgent('own');

    const after = (await hostRows())[0].seen_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
    expect(Date.now() - new Date(after).getTime()).toBeLessThan(5_000);
  });

  it('21в. второй строки НА МАШИНУ не бывает', async () => {
    // Единственность по-прежнему держит база, но теперь на машину
    // (PRIMARY KEY (host_id), 006): читатель берёт отметку СВОЕЙ машины без
    // ORDER BY и без max(), и вторая строка означала бы, что иногда
    // показывается позавчерашняя.
    await makeSvc().touchHostAgent('own');
    await hostSeen('1 hour');
    await makeSvc().touchHostAgent('own');

    expect(await hostRows()).toHaveLength(1);
    await expect(
      pool.query(`INSERT INTO product_host_agent (host_id, seen_at) VALUES ('own', now())`),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('21г. свежая отметка — агент на связи', async () => {
    await hostSeen('10 seconds');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(true);
  });

  it('21д. отметки нет вовсе — агент не на связи', async () => {
    // Так выглядит агент, которого не пускают по токену: юнит показывает
    // active (running), ноль перезапусков, ошибок нет, а HostGuard отбивает
    // каждый опрос — и до маршрута, а значит и до отметки, дело не доходит.
    await bystander();

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(false);
  });

  it('21е. отметка старше порога — агент не на связи', async () => {
    await hostSeen('3 minutes');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(false);
  });

  it('21ж. молчание с заданием на руках — агент занят, а не мёртв', async () => {
    // ГЛАВНЫЙ ЛОЖНОПОЛОЖИТЕЛЬНЫЙ. Пока агент разворачивает продукт, он НЕ
    // опрашивает — он работает, до восьми минут по своему же сроку. Одной
    // свежести отметки хватило бы, чтобы объявить его мёртвым посреди
    // исправного заведения — то есть ровно в те десять минут, когда владелец
    // смотрит на карточку.
    const p = await product({ slug: 'agent-busy' });
    await job(p.id, { status: 'running', createdAgo: '4 minutes', startedAgo: '4 minutes' });
    await hostSeen('4 minutes');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(true);
  });

  it('21з. задание в очереди молчание не оправдывает', async () => {
    // Ради этого случая всё и написано: задание стоит в 'queued', забрать его
    // некому. Без различения статусов задания сюда попал бы тот же ответ, что
    // и в предыдущем сценарии, и тревога не появилась бы никогда.
    const p = await product({ slug: 'agent-dead-queued' });
    await job(p.id, { status: 'queued', createdAgo: '4 minutes' });
    await hostSeen('4 minutes');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(false);
  });

  it('21и. взятое задание оправдывает молчание не дольше срока заведения', async () => {
    // Агент, умерший посреди развёртывания, оставляет задание в 'running'.
    // Верхняя граница — условие по сроку в самом запросе, а не надежда на
    // сборщика зависших: остановленный сборщик иначе делал бы мёртвого агента
    // вечно живым.
    const p = await product({ slug: 'agent-died-midway' });
    await job(p.id, { status: 'running', createdAgo: '12 minutes', startedAgo: '11 minutes' });
    await hostSeen('11 minutes');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(false);
  });

  it('21к. закрытые задания жизни не подтверждают', async () => {
    // История заданий у продукта накапливается навсегда. Отбор без сверки
    // статуса объявил бы агента живым по заданию двухчасовой давности — то
    // есть навсегда, на любой машине, где хоть раз что-то заводили.
    const p = await product({ slug: 'agent-done-history', status: 'running' });
    await job(p.id, { status: 'done', createdAgo: '2 minutes', startedAgo: '2 minutes', finishedAgo: '1 minute' });
    await job(p.id, { status: 'failed', createdAgo: '1 minute', startedAgo: '1 minute' });
    await hostSeen('5 minutes');

    await expect(makeSvc().hostAgentLive('own')).resolves.toBe(false);
  });

  it('21л. опрос агента и вердикт кабинета сходятся на живой базе', async () => {
    // Сквозной стык: мёртвый агент -> тревога, пришедший агент -> тишина.
    // Порознь обе половины зелены и при разъехавшихся именах таблицы.
    const svc = makeSvc();
    await ensureHost('own');
    expect(await svc.hostAgentLive('own')).toBe(false);

    await svc.touchHostAgent('own');

    expect(await svc.hostAgentLive('own')).toBe(true);
  });

  // ─────────── отметка своя у каждой машины (задача 3б) ───────────

  it('47. живой агент не выдаёт за живого мёртвого соседа', async () => {
    // ГЛАВНЫЙ СЦЕНАРИЙ ЗАДАЧИ. С общей отметкой обе машины считались бы живыми
    // по опросу одной — и продукт на умершей машине висел бы «Заводится…»
    // десять минут при зелёном индикаторе, заканчиваясь чужой формулировкой
    // про истёкший срок.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();

    await svc.touchHostAgent('own');

    expect(await svc.hostAgentLive('own')).toBe(true);
    expect(await svc.hostAgentLive('clients')).toBe(false);
  });

  it('47а. отметка соседа не оживляет молчащую машину', async () => {
    // Обратное направление того же. Мутация «читаем первую строку таблицы»
    // предыдущий сценарий проходит зелёной, если 'own' опрошена первой.
    await addHost({ id: 'clients' });
    const svc = makeSvc();

    await svc.touchHostAgent('clients');

    expect(await svc.hostAgentLive('clients')).toBe(true);
    expect(await svc.hostAgentLive('own')).toBe(false);
  });

  it('47б. две машины пишут отметку в одну секунду — загрубление на машину', async () => {
    // Загрубление записи (30 секунд) обязано считаться по СВОЕЙ строке. Общее
    // на всех, оно означало бы, что опрос одной машины глушит запись соседней
    // на полминуты: агент жив и опрашивает, а отметка стоит — то есть тревога
    // на исправной машине, и при двух машинах это постоянное состояние.
    //
    // Обе отметки заведены СТАРЫМИ нарочно: на пустой таблице ON CONFLICT не
    // срабатывает вовсе, и условие загрубления не исполняется ни в какой
    // форме — сценарий был бы зелен и при общем на всех условии.
    await addHost({ id: 'clients' });
    await hostSeen('40 seconds', 'own');
    await hostSeen('40 seconds', 'clients');
    const svc = makeSvc();

    // СТОРОЖ ПРИБОРА, и он не для красоты: фикстура, кладущая обе отметки в
    // одну строку, оставляет сценарий зелёным. Вторая отметка тогда не
    // конфликтует, а ВСТАВЛЯЕТСЯ, условие загрубления не исполняется вовсе — и
    // проверка ниже меряет пустоту. Измерено мутацией «фикстура отметки
    // игнорирует машину»: без этой строки она выживает.
    expect((await hostRows()).map((r: any) => r.host_id)).toEqual(['clients', 'own']);

    await svc.touchHostAgent('own');
    await svc.touchHostAgent('clients');

    const rows = await hostRows();
    expect(rows.map((r: any) => r.host_id)).toEqual(['clients', 'own']);
    // Сдвинулись ОБЕ, хотя между записями прошли миллисекунды: свежая отметка
    // соседа не запрещает писать свою.
    for (const r of rows) {
      expect(Date.now() - new Date(r.seen_at).getTime()).toBeLessThan(5_000);
    }
    expect(await svc.hostAgentLive('own')).toBe(true);
    expect(await svc.hostAgentLive('clients')).toBe(true);
  });

  it('48. занятость считается по заданиям СВОЕЙ машины', async () => {
    // ВТОРАЯ ПОЛОВИНА ВЕРДИКТА. Задание соседа не делает молчащего агента
    // живым — иначе одна занятая машина покрывает своим свидетельством все
    // остальные, и общая отметка возвращается через второй этаж.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const p = await product({ slug: 'mh-busy', status: 'provisioning', host: 'clients' });
    await job(p.id, { status: 'running', createdAgo: '1 minute', startedAgo: '1 minute' });

    expect(await makeSvc().hostAgentLive('clients')).toBe(true);
    expect(await makeSvc().hostAgentLive('own')).toBe(false);
  });

  it('48а. задание продукта БЕЗ метки не оживляет никого', async () => {
    // `p.host_id = NULL` не равно ничему, и это верно: задание такого продукта
    // не достанется ни одной машине (46г). Свидетельством занятости оно быть
    // не может — забрать его было некому.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const p = await product({ slug: 'mh-busy-nohost', status: 'provisioning', host: null });
    await job(p.id, { status: 'running', createdAgo: '1 minute', startedAgo: '1 minute' });

    expect(await makeSvc().hostAgentLive('own')).toBe(false);
    expect(await makeSvc().hostAgentLive('clients')).toBe(false);
  });

  it('48б. занятость СВОЕЙ машины не гасится молчанием соседа', async () => {
    // Сторож против «жив, если жив каждый»: два этажа складываются по ИЛИ
    // внутри одной машины, а машины между собой не складываются вовсе.
    await addHost({ id: 'clients' });
    const p = await product({ slug: 'mh-busy-own', status: 'provisioning', host: 'own' });
    await job(p.id, { status: 'running', createdAgo: '2 minutes', startedAgo: '2 minutes' });
    await hostSeen('5 minutes', 'own');

    expect(await makeSvc().hostAgentLive('own')).toBe(true);
    expect(await makeSvc().hostAgentLive('clients')).toBe(false);
  });

  /**
   * Вернуть таблицу отметки в форму ДО 006 (одна строка на всё, `id boolean`),
   * выполнить сценарий и восстановить форму при ЛЮБОМ исходе.
   *
   * Восстановление обязательно и делается сносом с пересборкой, а не обратной
   * правкой: упавший на середине сценарий иначе оставил бы половинчатую схему,
   * и красными стали бы все следующие — то есть красным оказалось бы не то, что
   * сломалось (ровно тот приём, что в 20г).
   */
  async function withSharedHostAgentRow(seed: () => Promise<void>) {
    await pool.query('DROP TABLE product_host_agent');
    await pool.query(migrationSql('003_host_agent.sql'));
    try {
      await seed();
      await pool.query(migrationSql('006_host_agent_per_host.sql'));
    } finally {
      const shape = await pool.query(
        `SELECT attname FROM pg_attribute
          WHERE attrelid = 'product_host_agent'::regclass AND attnum > 0 AND NOT attisdropped`,
      );
      if (!shape.rows.some((r: any) => r.attname === 'host_id')) {
        await pool.query('DROP TABLE product_host_agent');
        await pool.query(migrationSql('003_host_agent.sql'));
        await pool.query(migrationSql('006_host_agent_per_host.sql'));
      }
    }
  }

  it('49. миграция 006 переносит общую отметку на машину own', async () => {
    // Живой прод: отметка лежит одной строкой с куска 1, машина в реестре одна.
    // Проверяется исполнением, а не по тексту файла: выброшенная отметка — это
    // тревога в кабинете на две минуты после каждого выката, а приписанная
    // наугад — ложь ровно того вида, который файл убирает.
    await ensureHost('own');

    await withSharedHostAgentRow(async () => {
      await pool.query(`INSERT INTO product_host_agent (id, seen_at) VALUES (true, now())`);
    });

    expect((await hostRows()).map((r: any) => r.host_id)).toEqual(['own']);
    expect(await makeSvc().hostAgentLive('own')).toBe(true);
  });

  it('49а. отметка без машины в реестре выбрасывается, а не приписывается наугад', async () => {
    // Состояние достижимое: 005 нарочно безвредный no-op при незаполненном
    // PRODUCT_HOST_TOKEN, реестр тогда пуст, а отметка от прошлых опросов
    // лежит. Приписать её первой попавшейся машине значило бы объявить живой
    // ту, которую никто не опрашивал.
    await addHost({ id: 'clients' });

    await withSharedHostAgentRow(async () => {
      await pool.query(`INSERT INTO product_host_agent (id, seen_at) VALUES (true, now())`);
    });

    expect(await hostRows()).toEqual([]);
    expect(await makeSvc().hostAgentLive('clients')).toBe(false);
  });

  it('49б. пустая таблица переживает перестройку так же', async () => {
    // Свежая база и машина, которую ещё никто не опрашивал. Отдельный сценарий,
    // потому что ветка UPDATE/DELETE здесь не исполняется вовсе, а отказать
    // SET NOT NULL и ADD PRIMARY KEY на пустой таблице всё равно есть чему.
    await ensureHost('own');

    await withSharedHostAgentRow(async () => undefined);

    expect(await hostRows()).toEqual([]);
    await makeSvc().touchHostAgent('own');
    expect((await hostRows()).map((r: any) => r.host_id)).toEqual(['own']);
  });

  it('49в. повторная накатка ВСЕГО СПИСКА ничего не ломает и не трогает отметок', async () => {
    // Модуль накатывает весь список при КАЖДОМ старте API, и 003 стоит в нём
    // РАНЬШЕ 006 — то есть на следующем старте старая форма таблицы приезжает
    // снова. Проверяется исполнением: по тексту файлов этот спор не виден.
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    const before = await hostRows();

    const refused: string[] = [];
    for (let i = 0; i < 2; i++) {
      for (const f of MIGRATIONS) {
        try {
          await pool.query(migrationSql(f));
        } catch (e: any) {
          refused.push(`${f}: ${e.message}`);
        }
      }
    }

    expect(refused).toEqual([]);
    expect(await hostRows()).toEqual(before);
    expect(await svc.hostAgentLive('own')).toBe(true);
  });

  it('49г. повторная накатка не снимает первичный ключ даже на миг', async () => {
    // Наивная запись (DROP CONSTRAINT IF EXISTS + ADD PRIMARY KEY) повтор
    // ПЕРЕЖИВАЕТ — и в окне между двумя операторами уникального индекса нет,
    // а ON CONFLICT (host_id) в это окно отказывает. Здесь проверяется, что
    // повтор вообще ничего не перестраивает: ключ тот же, по имени и по oid.
    await ensureHost('own');
    const pk = async () =>
      (
        await pool.query(
          `SELECT oid, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
            WHERE conrelid = 'product_host_agent'::regclass AND contype = 'p'`,
        )
      ).rows;
    const before = await pk();

    await pool.query(migrationSql('006_host_agent_per_host.sql'));

    expect(before).toHaveLength(1);
    expect(before[0].def).toBe('PRIMARY KEY (host_id)');
    expect(await pk()).toEqual(before);
  });

  it('49д. снос машины уносит её отметку, но не продукты соседа', async () => {
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    await svc.touchHostAgent('clients');
    const mine = await product({ slug: 'mh-stay', status: 'running', host: 'own' });

    await pool.query(`DELETE FROM product_hosts WHERE id = 'clients'`);

    expect((await hostRows()).map((r: any) => r.host_id)).toEqual(['own']);
    expect(await getProduct(mine.id)).toBeTruthy();
    // А машину С ПРОДУКТАМИ снести «заодно» нельзя: у products.host_id внешний
    // ключ БЕЗ ON DELETE (005), и это разные решения, принятые по разным
    // причинам. Сторож от «привёл каскады к единому виду».
    await expect(pool.query(`DELETE FROM product_hosts WHERE id = 'own'`)).rejects.toMatchObject({
      code: '23503',
    });
  });

  // ──────── вердикт кабинета: машины ЭТОГО владельца (задача 3б) ────────

  it('50. молчит машина владельца — кабинету тревога', async () => {
    await addHost({ id: 'clients' });
    const svc = makeSvc();
    await svc.touchHostAgent('clients');
    await product({ slug: 'mh-cab-own', status: 'running', host: 'own' });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(false);
  });

  it('50а. молчит ЧУЖАЯ машина — кабинет спокоен', async () => {
    // Цена ошибки здесь несимметрична: ложная тревога учит не верить баннеру.
    // Владелец, все продукты которого стоят на живой машине, про мёртвого
    // соседа знать не обязан.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    await product({ slug: 'mh-cab-live', status: 'running', host: 'own' });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(true);
  });

  it('50б. чужой продукт на молчащей машине в мой вердикт не входит', async () => {
    // Отбор машин идёт через продукты ВЛАДЕЛЬЦА. Соединение без user_id даёт
    // тревогу у всех, стоит одному чужому продукту оказаться на мёртвой
    // машине.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    const theirs = await product({ slug: 'mh-cab-alien', status: 'running', host: 'clients' });
    await pool.query(`UPDATE products SET user_id = 'u-2' WHERE id = $1`, [theirs.id]);
    await product({ slug: 'mh-cab-mine', status: 'running', host: 'own' });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(true);
    expect(await svc.hostAgentsLiveForUser('u-2')).toBe(false);
  });

  it('50в. архивный продукт на молчащей машине тревоги не поднимает', async () => {
    // Архивный не получает заданий никогда, и молчание его машины ни на что не
    // влияет. Иначе тревога залипала бы навсегда — погасить её было бы нечем.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    const dead = await product({ slug: 'mh-cab-arch', status: 'running', host: 'clients' });
    await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [dead.id]);
    await product({ slug: 'mh-cab-alive', status: 'running', host: 'own' });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(true);
  });

  it('50г. спящий продукт на молчащей машине тревогу поднимает', async () => {
    // Сон за неуплату и пробуждение после пополнения — тоже задания, и на
    // молчащей машине их тоже никто не заберёт. Отбор «только заводящиеся»
    // оставил бы владельца с продуктом, который не проснётся от пополнения, и
    // без единого слова об этом.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    const p = await product({ slug: 'mh-cab-sleep', status: 'running', host: 'clients' });
    await pool.query(`UPDATE products SET status = 'sleeping' WHERE id = $1`, [p.id]);

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(false);
  });

  it('50д. продукт БЕЗ метки машины — тревога, а не «всё в порядке»', async () => {
    // Его задания не достанутся никому и никогда (46г). До задачи 4 так
    // выглядит каждый только что заведённый продукт, и кабинет обязан сказать
    // это вслух, а не отвечать «всё хорошо» тому, чья работа не уедет никуда.
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');
    await product({ slug: 'mh-cab-nohost', status: 'provisioning', host: null });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(false);
  });

  it('50е. владелец без продуктов: лежит весь хостинг — тревога', async () => {
    // Сказать это надо ДО первого нажатия «Новый продукт», когда продуктов ещё
    // нет и отбор по ним пуст.
    await addHost({ id: 'clients' });
    await ensureHost('own');

    expect(await makeSvc().hostAgentsLiveForUser('u-1')).toBe(false);
  });

  it('50ж. владелец без продуктов: жива хоть одна машина — тишина', async () => {
    // Гадать, куда уедет СЛЕДУЮЩИЙ продукт, здесь нельзя: машину выбирает
    // задача 4 по аудитории и свободным местам, и второе правило выбора
    // разошлось бы с настоящим молча. Цена названа: владелец узнает о молчании
    // своей машины следующей перечиткой кабинета, а не через десять минут.
    await addHost({ id: 'clients' });
    await ensureHost('own');
    const svc = makeSvc();
    await svc.touchHostAgent('own');

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(true);
  });

  it('50з. пустой реестр — тревога, а не вакуумное «всё в порядке»', async () => {
    // При пустом реестре гвард отбивает КАЖДОГО агента (задача 2), то есть
    // забирать работу правда некому. Условие «хоть одна машина жива» отвечает
    // здесь верно и без отдельной ветки.
    expect(await hosts()).toEqual([]);

    expect(await makeSvc().hostAgentsLiveForUser('u-1')).toBe(false);
  });

  it('50и. с ОДНОЙ машиной вердикт кабинета совпадает с вердиктом машины', async () => {
    // Сторож обратной совместимости: пока машина одна, новый заголовок обязан
    // отвечать ровно то же, что отвечал прежний. Иначе правка диагностики сама
    // стала бы источником расхождения на проде, где машина пока одна.
    const svc = makeSvc();
    await product({ slug: 'mh-cab-compat', status: 'running', host: 'own' });

    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(await svc.hostAgentLive('own'));
    await svc.touchHostAgent('own');
    expect(await svc.hostAgentsLiveForUser('u-1')).toBe(await svc.hostAgentLive('own'));
    expect(await svc.hostAgentLive('own')).toBe(true);
  });

  it('50к. занятая машина владельца тревоги не поднимает', async () => {
    // Второй этаж работает и в кабинетном вердикте: пока агент разворачивает
    // продукт, он не опрашивает — и без этого баннер загорался бы ровно в те
    // десять минут, когда владелец смотрит на карточку.
    const p = await product({ slug: 'mh-cab-busy', status: 'provisioning', host: 'own' });
    await job(p.id, { status: 'running', createdAgo: '4 minutes', startedAgo: '4 minutes' });
    await hostSeen('4 minutes', 'own');

    expect(await makeSvc().hostAgentsLiveForUser('u-1')).toBe(true);
  });

  // ═════════════════════════════ аренда ═════════════════════════════

  /**
   * Баланс и учёт токенов живут ВНЕ модуля продуктов — их заводят чужие
   * миграции, а сьют накатывает только `src/products/migrations`. Здесь
   * заводится ровно тот минимум, который читает и пишет оператор списания, и
   * снят он с прода буквально (`\d ai_profiles_consolidated`,
   * `\d token_transactions`, `\dT+ transaction_type_enum`, 16.09.2026).
   *
   * Форма не косметика. На UNIQUE(user_id) держится однозначность строки
   * баланса; на перечне значений enum — то, что 'consumed' вообще запишется.
   * Выдуманная своя табличка (`user_id text PRIMARY KEY`, тип транзакции
   * текстом) зеленела бы и на значении, которого на проде нет, — то есть
   * сторожила бы ровно ничего.
   */
  async function ensureBillingTables() {
    await pool.query(`DO $$ BEGIN
       CREATE TYPE transaction_type_enum AS ENUM
         ('purchase','consumed','bonus','refund','adjustment','coupon');
     EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ai_profiles_consolidated (
       id serial PRIMARY KEY,
       user_id text NOT NULL UNIQUE,
       tokens bigint NOT NULL DEFAULT 0,
       updated_at timestamptz DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS token_transactions (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       user_id text NOT NULL,
       transaction_type transaction_type_enum NOT NULL,
       amount bigint NOT NULL,
       balance_after bigint NOT NULL,
       description text,
       metadata jsonb,
       created_at timestamptz DEFAULT now())`);
  }

  const rent = () => new RentService(pg as any);

  async function setBalance(userId: string, tokens: number) {
    await pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET tokens = EXCLUDED.tokens`,
      [userId, tokens],
    );
  }

  /** −1, а не 0: «строки нет» и «ноль на балансе» — разные вещи (сценарий 29). */
  const balanceOf = async (userId: string) =>
    Number(
      (await pool.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]))
        .rows[0]?.tokens ?? -1,
    );

  const ledgerOf = async (userId: string) =>
    (
      await pool.query('SELECT * FROM token_transactions WHERE user_id = $1 ORDER BY created_at', [
        userId,
      ])
    ).rows;

  /**
   * Продукт с истёкшим сроком — ровно то состояние, в котором его находит
   * сборщик. Срок урезается до миллисекунд намеренно: у timestamptz точность
   * микросекундная, а Date в JS хранит миллисекунды, и сценарий 32, который
   * возит срок туда-обратно через параметр, иначе краснел бы на округлении, а
   * не на поведении. Отрицательный `overdue` («-3 days») даёт срок в будущем.
   */
  async function due(o: { slug: string; status?: string; overdue?: string; userId?: string }) {
    const p = await product({ slug: o.slug, status: o.status ?? 'running' });
    await pool.query(
      `UPDATE products
          SET paid_until = date_trunc('milliseconds', now() - $2::interval),
              user_id = COALESCE($3, user_id)
        WHERE id = $1`,
      [p.id, o.overdue ?? '1 day', o.userId ?? null],
    );
    return p;
  }

  const paidUntilOf = async (id: string) => new Date((await getProduct(id)).paid_until).getTime();

  /**
   * Ход продукта. `channel` и `prompt` обязательны на уровне схемы — вставка
   * из плана (`id, product_id, user_id, status, created_at`) на живой базе
   * падает на NOT NULL, то есть сценарий сна там не исполнялся ни разу.
   *
   * Три отметки времени раздельно: сон смотрит на МОЛЧАНИЕ
   * (`last_progress_at`), а не на длительность, и отличить одно от другого
   * можно только задав их порознь.
   */
  async function turn(
    productId: string,
    o: {
      status?: string;
      createdAgo?: string;
      startedAgo?: string | null;
      progressAgo?: string | null;
    } = {},
  ) {
    await pool.query(
      `INSERT INTO product_turns
              (id, product_id, user_id, channel, prompt, status,
               created_at, started_at, last_progress_at)
       VALUES (gen_random_uuid(), $1, 'u-1', 'web', 'правь', $2,
               now() - $3::interval,
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() - $4::interval END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() - $5::interval END)`,
      [
        productId,
        o.status ?? 'running',
        o.createdAgo ?? '1 minute',
        o.startedAgo ?? null,
        o.progressAgo ?? null,
      ],
    );
  }

  const jobKindsOf = async (productId: string) =>
    (
      await pool.query(
        'SELECT kind FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at',
        [productId],
      )
    ).rows.map((r: any) => r.kind);

  /**
   * Дождаться, пока n запросов ДЕЙСТВИТЕЛЬНО встанут на замок. Фиксированная
   * пауза вместо этого либо ничего не гарантирует, либо удлиняет прогон на
   * ровном месте, а сценарии 36 и 59 без этой гарантии проверяют не то, что
   * написано в их названиях.
   */
  async function waitForLockWaiters(n: number) {
    const until = Date.now() + 10_000;
    for (;;) {
      const r = await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database()
            AND state = 'active' AND wait_event_type = 'Lock'`,
      );
      if (r.rows[0].n >= n) return;
      if (Date.now() > until) {
        throw new Error(`на замок встали ${r.rows[0].n} из ${n} — сценарий не воспроизвёлся`);
      }
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  /**
   * ЗДЕСЬ ТРОГАЮТ ДЕНЬГИ, и заглушки про это не говорят ничего: мок отдаёт
   * условленную строку при любом тексте запроса, а разница между «списали
   * 50 000 и заняли месяц» и «списали 10 000, заняли месяц и обнулили баланс»
   * видна только исполнением.
   *
   * Измерено обеими сторонами на живой базе (PostgreSQL 16, 16.09.2026) — вот
   * что делает SQL, у которого достаток баланса прочитан подзапросом без
   * замка, а списание прикрыто `GREATEST(0, …)`:
   *
   *   баланс 60 000, параллельная правка забирает 20 000 → аренда оставляет
   *     ВЛАДЕЛЬЦУ НОЛЬ и засчитывает месяц (сценарий 30);
   *   срок истёк три месяца назад → списывает по 50 000 на каждом обороте,
   *     пока не догонит календарь, то есть копит долг там, где спека его
   *     запрещает (сценарий 31).
   *
   * Оба исхода проходят мимо любого сторожа формы: текст запроса в них
   * правильный.
   */
  describe('списание аренды', () => {
    beforeAll(ensureBillingTables);

    // Внешний beforeEach чистит продукты и задания, но не эти две таблицы: они
    // заведены здесь и ему не известны. Оставленный баланс делает следующий
    // сценарий зелёным на чужих деньгах — ровно так же, как это уже случилось
    // с отметкой агента хоста.
    beforeEach(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));
    afterAll(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));


    it('22. два ОДНОВРЕМЕННЫХ сборщика списывают аренду ровно один раз', async () => {
      // Прод работает в кластере из двух процессов. Главный сценарий куска:
      // наивная реализация снимет 100 000 и уедет на два месяца вперёд, а
      // увидит это только владелец — в своём балансе.
      const other = await bystander();
      const p = await due({ slug: 'rent-race' });
      await setBalance('u-1', 120_000);

      const outcomes = await Promise.all([rent().chargeRent(p.id), rent().chargeRent(p.id)]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await balanceOf('u-1')).toBe(70_000);
      expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
      // И в истории один расход, а не два: по ней владелец и проверяет.
      expect(await ledgerOf('u-1')).toHaveLength(1);
      await expectUntouched(other);
    });

    it('23. при нехватке баланса не списывается НИЧЕГО и период не двигается', async () => {
      // Существующий deductTokens в этом месте забрал бы 30 000 из 50 000 и
      // оставил ноль: денег взяли не сколько надо, продукт всё равно заснёт, а
      // баланс обнулён. Здесь не должно уйти ни токена.
      const p = await due({ slug: 'rent-poor' });
      await setBalance('u-1', 30_000);
      const before = await getProduct(p.id);

      expect(await rent().chargeRent(p.id)).toBe(false);

      expect(await balanceOf('u-1')).toBe(30_000);
      expect((await getProduct(p.id)).paid_until).toEqual(before.paid_until);
      expect(await ledgerOf('u-1')).toEqual([]);
    });

    it('24. неистёкший период не списывается', async () => {
      const p = await product({ slug: 'rent-early', status: 'running' });
      await pool.query(`UPDATE products SET paid_until = now() + interval '10 days' WHERE id = $1`, [
        p.id,
      ]);
      await setBalance('u-1', 120_000);

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(120_000);
    });

    it('25. со спящего аренда не списывается', async () => {
      // Спящий не копит долг — решение владельца, и держится оно ровно на
      // условии по статусу. Иначе продукт, проспавший полгода, при первом же
      // пополнении был бы обобран за полгода сна.
      const p = await due({ slug: 'rent-asleep', status: 'sleeping', overdue: '2 months' });
      await setBalance('u-1', 500_000);

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(500_000);
    });

    it('26. degraded платит наравне с running', async () => {
      // Решение владельца, принятое после задачи 1: контейнер запущен, сайт
      // отвечает, машина занята; нет связи с ассистентом — это наша поломка, а
      // не основание не платить. На проде 16.09.2026 в degraded ЧЕТЫРЕ продукта
      // из шести, то есть `status = 'running'` в предусловии обнулил бы выручку
      // и не покраснел бы ни одним тестом про running.
      const p = await due({ slug: 'rent-degraded', status: 'degraded' });
      await setBalance('u-1', 120_000);

      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(70_000);
    });

    it('27. ровно на границе баланса списание проходит', async () => {
      // Сторож знака: `>` вместо `>=` отбил бы владельца, у которого ровно на
      // месяц, и продукт заснул бы при достаточных деньгах.
      const p = await due({ slug: 'rent-exact', overdue: '1 hour' });
      await setBalance('u-1', 50_000);

      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(0);
    });

    it('28. на токен меньше — отказ, и ни один токен не уходит', async () => {
      // Вторая сторона той же границы. Без неё «проверку достатка убрали
      // совсем» неотличимо от «проверка на месте»: баланс уехал бы в минус или
      // в ноль, а сценарий 27 остался бы зелёным.
      const p = await due({ slug: 'rent-almost' });
      await setBalance('u-1', 49_999);

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(49_999);
      expect(await paidUntilOf(p.id)).toBeLessThan(Date.now());
    });

    it('29. у владельца вовсе нет строки баланса — отказ без бесплатного месяца', async () => {
      // Строку заводит регистрация, но в этом коде уже были пользователи без
      // неё (её чинил ON CONFLICT DO NOTHING в identity.service). Опасность
      // тут не в отказе, а в том, что период занимается ОТДЕЛЬНОЙ частью
      // оператора: если она не смотрит на баланс, продукт получает месяц
      // бесплатно и продолжает получать его каждый месяц.
      const p = await due({ slug: 'rent-no-row' });
      const before = await getProduct(p.id);

      expect(await rent().chargeRent(p.id)).toBe(false);

      expect((await getProduct(p.id)).paid_until).toEqual(before.paid_until);
      // Строку баланса мы не заводим: у аренды нет причин создавать профиль.
      expect(await balanceOf('u-1')).toBe(-1);
    });

    it('30. ход, забравший токены в тот же миг, не даёт частичного списания', async () => {
      // САМАЯ ДОРОГАЯ ИЗ ОШИБОК ЭТОГО ФАЙЛА, и мимо заглушек она проходит
      // целиком. Баланс читается в условии, а списывается записью — между ними
      // помещается чужой коммит. Измерено: без `FOR UPDATE` в подзапросе
      // достатка владелец с 60 000 и правкой на 20 000 остаётся с НУЛЁМ, и
      // месяц ему при этом засчитан; с замком оператор ждёт чужой транзакции,
      // перечитывает 40 000 и честно не делает ничего.
      //
      // Держатель берёт строку ДО списания и отпускает по таймеру — гонки в
      // самом сценарии нет.
      const p = await due({ slug: 'rent-vs-turn' });
      await setBalance('u-1', 60_000);

      const holder = await pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `UPDATE ai_profiles_consolidated SET tokens = tokens - 20000 WHERE user_id = 'u-1'`,
        );
        const unlock = new Promise<void>((r) =>
          setTimeout(async () => {
            await holder.query('COMMIT');
            released = true;
            r();
          }, 800),
        );

        const started = Date.now();
        const charged = await rent().chargeRent(p.id);
        const elapsed = Date.now() - started;
        await unlock;

        expect(charged).toBe(false);
        // Списание не проскочило мимо чужой транзакции по снимку, а дождалось
        // её: без ожидания весь сценарий был бы про другое.
        expect(elapsed).toBeGreaterThan(500);
        expect(await balanceOf('u-1')).toBe(40_000);
        expect(await paidUntilOf(p.id)).toBeLessThan(Date.now());
        expect(await ledgerOf('u-1')).toEqual([]);
      } finally {
        if (!released) await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('31. срок, истёкший три месяца назад, стоит один месяц, а не три', async () => {
      // Спека: спящий долг не копит. Продукт возвращается из сна (или сборщик
      // простоял) с давно истёкшим сроком, и `paid_until + 1 month` от него
      // означает оплату периода, который УЖЕ ПРОШЁЛ: срок остаётся в прошлом,
      // и следующий же оборот списывает снова — 150 000 за три дня вместо
      // 50 000 за месяц. Измерено на живой базе именно так.
      const p = await due({ slug: 'rent-stale', overdue: '3 months' });
      await setBalance('u-1', 200_000);

      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(150_000);

      // Второй оборот сборщика подряд не находит, что списывать.
      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(150_000);
      const days = (await paidUntilOf(p.id) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(27);
      expect(days).toBeLessThan(32);
    });

    it('32. якорь даты не уезжает: месяц считается от занятого срока', async () => {
      // Обратная сторона сценария 31. Лечение «считать месяц от now()» ровняет
      // все случаи, но уводит дату списания вперёд на время запаздывания
      // сборщика — до суток в месяц, то есть почти две недели бесплатного
      // хостинга в год на каждый продукт.
      const p = await due({ slug: 'rent-anchor', overdue: '2 days' });
      await setBalance('u-1', 120_000);
      const before = (await getProduct(p.id)).paid_until;

      expect(await rent().chargeRent(p.id)).toBe(true);

      // Сравнение считает Postgres: «месяц» здесь обязан значить ровно то же,
      // что и в самом запросе, а не то же, что в арифметике JS.
      const r = await pool.query(
        `SELECT paid_until = $2::timestamptz + interval '1 month' AS exact
           FROM products WHERE id = $1`,
        [p.id, before],
      );
      expect(r.rows[0].exact).toBe(true);
    });

    it('33. списание видно в учёте токенов — тип, знак, остаток и продукт', async () => {
      // Спека: отдельной таблицы расходов не заводим, аренда ложится в
      // существующий учёт рядом с правками. Без строки владелец видит, как
      // исчезли 50 000, и узнать за что не может ниоткуда: в кабинете история
      // показывает только начисления, а расход по ходам приезжает из чата.
      // Знак и тип — как у consume_user_tokens: админские отчёты берут по
      // 'consumed' сумму ABS(SUM(amount)), и плюс вместо минуса тихо удвоил бы
      // расход пользователя в сводке.
      const p = await due({ slug: 'rent-ledger' });
      await setBalance('u-1', 120_000);

      expect(await rent().chargeRent(p.id)).toBe(true);

      const [row] = await ledgerOf('u-1');
      expect(row.transaction_type).toBe('consumed');
      expect(Number(row.amount)).toBe(-50_000);
      expect(Number(row.balance_after)).toBe(70_000);
      expect(row.description).toContain('rent-ledger');
      expect(row.metadata).toMatchObject({ kind: 'product_rent', product_id: p.id });
    });

    it('34. списание не трогает ни чужой продукт, ни чужой баланс', async () => {
      // Соединение без условия (`... OR TRUE`) в этом файле уже ловили: один
      // отчёт агента правил весь реестр. У списания цена такой правки — чужие
      // деньги, поэтому рядом стоят и посторонний продукт того же владельца, и
      // такой же просроченный продукт ДРУГОГО.
      const other = await bystander();
      const neighbour = await due({ slug: 'rent-neighbour', userId: 'u-2' });
      await setBalance('u-2', 500_000);
      const p = await due({ slug: 'rent-mine' });
      await setBalance('u-1', 120_000);

      expect(await rent().chargeRent(p.id)).toBe(true);

      expect(await balanceOf('u-2')).toBe(500_000);
      expect(await paidUntilOf(neighbour.id)).toBeLessThan(Date.now());
      expect(await ledgerOf('u-2')).toEqual([]);
      await expectUntouched(other);
    });

    it('35. денег ровно на один месяц при двух продуктах — платит один', async () => {
      // Замок на строке баланса сериализует не только два сборщика на одном
      // продукте, но и соседние продукты одного владельца: второй перечитывает
      // остаток после первого и видит ноль. Без этого оба прошли бы проверку
      // по одному и тому же снимку, и баланс ушёл бы в минус — ровно так один
      // пользователь на этом проекте уже оказался на −7 363.
      const a = await due({ slug: 'rent-two-a' });
      const b = await due({ slug: 'rent-two-b' });
      await setBalance('u-1', 50_000);

      const outcomes = await Promise.all([rent().chargeRent(a.id), rent().chargeRent(b.id)]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await balanceOf('u-1')).toBe(0);
      const paid = await pool.query(
        'SELECT count(*) FROM products WHERE id = ANY($1) AND paid_until > now()',
        [[a.id, b.id]],
      );
      expect(Number(paid.rows[0].count)).toBe(1);
    });

    it('36. два сборщика, взявшие снимок ДО чужого коммита, всё равно платят один раз', async () => {
      // НАЙДЕНО МУТАЦИЕЙ. Сценарий 22 ловит двойное списание только если
      // второй сборщик успел взять снимок до коммита первого, а это решает
      // планировщик: на мутации «сначала списать, потом занять период» 22
      // остался ЗЕЛЁНЫМ — второй запрос стартовал уже после чужого коммита и
      // честно не нашёл, что списывать. Сама мутация при этом означает ровно
      // то, чего боится спека: деньги сняты, период не занят, владелец платит
      // дважды за один месяц.
      //
      // Здесь оба сборщика гарантированно встают на занятую строку баланса,
      // то есть оба входят в дело до того, как хоть что-то произошло, и
      // порядок частей оператора становится наблюдаемым: занять период
      // ОБЯЗАНО быть предусловием списания, а не наоборот.
      const p = await due({ slug: 'rent-race-held' });
      await setBalance('u-1', 120_000);

      const holder = await pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query(
          `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = 'u-1' FOR UPDATE`,
        );
        const both = Promise.all([rent().chargeRent(p.id), rent().chargeRent(p.id)]);
        await waitForLockWaiters(2);

        await holder.query('COMMIT');
        released = true;
        const outcomes = await both;

        expect(outcomes.filter(Boolean)).toHaveLength(1);
        expect(await balanceOf('u-1')).toBe(70_000);
        expect(await ledgerOf('u-1')).toHaveLength(1);
        expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
      } finally {
        if (!released) await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    it('37. просрочка ПОЛТОРА МЕСЯЦА: месяц вперёд один раз, а не долг', async () => {
      // ДЫРА, НАЙДЕННАЯ ПРОВЕРЯЮЩИМ. Сценарий 31 брал три месяца, 32 — двое
      // суток, и промежуток «больше месяца, но меньше двух» не сторожил никто:
      // мутант, сдвинувший границу в CASE с месяца на три, оставлял срок в
      // прошлом и возвращал копящийся долг — второе списание за тот же
      // календарный месяц на следующем обороте.
      const p = await due({ slug: 'rent-45d', overdue: '45 days' });
      await setBalance('u-1', 200_000);

      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(150_000);
      expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(150_000);
    });

    it('38. просрочка РОВНО месяц: срок тоже уезжает в будущее', async () => {
      // Сама граница CASE. `paid_until + 1 month` здесь даёт ровно now() —
      // то есть срок, который тут же снова считается истёкшим.
      const p = await due({ slug: 'rent-30d', overdue: '1 month' });
      await setBalance('u-1', 200_000);

      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(150_000);
    });

    it('39. архивный продукт со статусом running не платит', async () => {
      // Сторож на archived_at был ФОРМАЛЬНЫМ: проверял подстроку в тексте
      // запроса и пропускал подмену условия на `(… OR archived_at <= now())`,
      // при которой архивный платит вечно. Архивация идёт отдельным
      // `SET archived_at = now()`, статус при этом остаётся прежним — такие
      // строки на проде уже встречались.
      const p = await due({ slug: 'rent-archived-running' });
      await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [p.id]);
      await setBalance('u-1', 500_000);

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(500_000);
      expect(await ledgerOf('u-1')).toEqual([]);
    });

    it('40. статусы, которые НЕ платят: provisioning, stopped, failed, archived', async () => {
      // Поведенческий сторож вместо подстроки в тексте: перечисление статусов
      // в предикате можно подменить так, что текст останется похожим.
      for (const st of ['provisioning', 'stopped', 'failed', 'archived']) {
        await pool.query('TRUNCATE products, product_provision_jobs, product_turns CASCADE');
        await pool.query('TRUNCATE ai_profiles_consolidated, token_transactions');
        const p = await due({ slug: `rent-st-${st}`, status: st });
        await setBalance('u-1', 500_000);

        expect([st, await rent().chargeRent(p.id)]).toEqual([st, false]);
        expect([st, await balanceOf('u-1')]).toEqual([st, 500_000]);
      }
    });

    it('41. срок ещё не истёк на сутки — не списывается', async () => {
      // Ближняя граница «рано платить». В сданной батарее она стояла на десяти
      // сутках (сценарий 24), а сборщик ходит раз в сутки: льготный аванс
      // длиной в неделю прошёл бы мимо всей батареи, а он означает списание за
      // период, который ещё оплачен.
      const p = await due({ slug: 'rent-tomorrow', overdue: '-1 day' });
      await setBalance('u-1', 500_000);

      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await balanceOf('u-1')).toBe(500_000);
      expect(await ledgerOf('u-1')).toEqual([]);
    });
  });

  // ═══════════════════ аренда: сон и пробуждение ═══════════════════

  /**
   * Сон гасит контейнер, в котором прямо сейчас может писать код ассистент.
   * Погашенный посреди хода контейнер убивает правку МОЛЧА: ни ошибки, ни
   * строки в истории, ни списания — тот же дефект, из-за которого deploy.sh не
   * рестартует API при живых ходах.
   *
   * Проверяется исполнением, а не текстом запроса: вставка хода из плана
   * (`id, product_id, user_id, status, created_at`) на живой базе падает на
   * NOT NULL у `channel` и `prompt`, то есть сценарий сна в плане не
   * исполнялся ни разу.
   */
  describe('сон и пробуждение', () => {
    beforeAll(ensureBillingTables);
    beforeEach(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));
    afterAll(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));

    it('42. сон НЕ ставится, пока идёт ход', async () => {
      // Главный сценарий задачи.
      const p = await due({ slug: 'sleep-busy' });
      await turn(p.id, { status: 'running', startedAgo: '5 minutes', progressAgo: '10 seconds' });

      expect(await rent().requestSleep(p.id)).toBe(false);

      expect(await jobsOf(p.id)).toEqual([]);
      expect((await getProduct(p.id)).status).toBe('running');
    });

    it('43. ДОЛГИЙ, но живой ход сна не пускает: признак — молчание, а не длительность', async () => {
      // «Идёт дольше потолка» — догадка о смерти: крупный рефакторинг со
      // сборкой и тестами живёт часами. Предикат из плана (по created_at)
      // погасил бы контейнер под работающим ассистентом — ровно то, ради чего
      // вся задача.
      const p = await due({ slug: 'sleep-long-alive' });
      await turn(p.id, { status: 'running', createdAgo: '5 hours', startedAgo: '5 hours', progressAgo: '20 seconds' });

      expect(await rent().requestSleep(p.id)).toBe(false);
      expect(await jobsOf(p.id)).toEqual([]);
    });

    it('44. МОЛЧАЩИЙ дольше потолка ход продукт не держит', async () => {
      // Потолок ожидания. Иначе зависший ход держит неоплаченный продукт
      // запущенным, пока кто-нибудь не посмотрит в базу руками. Через
      // несколько минут такой ход похоронит и уборщик зависших — потолок у
      // них общий намеренно.
      const p = await due({ slug: 'sleep-silent' });
      await turn(p.id, { status: 'running', createdAgo: '2 hours', startedAgo: '2 hours', progressAgo: '45 minutes' });

      expect(await rent().requestSleep(p.id)).toBe(true);
      expect(await jobsOf(p.id)).toEqual(['queued']);
      expect(await jobKindsOf(p.id)).toEqual(['sleep']);
      expect((await getProduct(p.id)).status).toBe('sleeping');
    });

    it('45. ход, застрявший в очереди дольше потолка, продукт не держит', async () => {
      // У очередного хода нет ни прогресса, ни начала: раннер за ним не
      // пришёл. Уборщик зависших такие не трогает (он смотрит только
      // running), поэтому без потолка по created_at продукт не уснёт никогда.
      const p = await due({ slug: 'sleep-stuck-queued' });
      await turn(p.id, { status: 'queued', createdAgo: '3 hours' });

      expect(await rent().requestSleep(p.id)).toBe(true);
      expect(await jobsOf(p.id)).toEqual(['queued']);
    });

    it('46. СВЕЖИЙ ход в очереди продукт держит', async () => {
      // Обратная сторона 45: раннер заберёт его в ближайшие секунды, и гасить
      // контейнер сейчас — то же самое, что гасить посреди работы.
      const p = await due({ slug: 'sleep-fresh-queued' });
      await turn(p.id, { status: 'queued', createdAgo: '10 seconds' });

      expect(await rent().requestSleep(p.id)).toBe(false);
      expect(await jobsOf(p.id)).toEqual([]);
    });

    it('47. закрытые ходы сну не мешают', async () => {
      // История ходов копится навсегда. Отбор без сверки статуса запретил бы
      // сон любому продукту, у которого хоть раз что-то правили.
      const p = await due({ slug: 'sleep-history' });
      await turn(p.id, { status: 'done', createdAgo: '5 minutes', startedAgo: '5 minutes', progressAgo: '1 minute' });
      await turn(p.id, { status: 'failed', createdAgo: '2 minutes', startedAgo: '2 minutes' });

      expect(await rent().requestSleep(p.id)).toBe(true);
      expect(await jobsOf(p.id)).toEqual(['queued']);
    });

    it('48. ЗАВОДЯЩИЙСЯ продукт не помечается спящим без задания', async () => {
      // ДЕФЕКТ ПЛАНА. Там статус менялся ПЕРВОЙ частью оператора, а задание
      // ставилось второй с ON CONFLICT DO NOTHING — и при активном задании
      // (идёт заведение) продукт оставался помеченным спящим БЕЗ задания на
      // сон: аренду не платит, правок не принимает, контейнер работает, гасить
      // его некому. Бесплатный хостинг, видимый только по выручке.
      const p = await due({ slug: 'sleep-while-provisioning' });
      await job(p.id, { status: 'running', startedAgo: '1 minute' });

      expect(await rent().requestSleep(p.id)).toBe(false);

      expect((await getProduct(p.id)).status).toBe('running');
      expect((await getProduct(p.id)).sleep_reason).toBeNull();
      expect(await jobsOf(p.id)).toEqual(['running']);
    });

    it('49. ОПЛАЧЕННЫЙ продукт не усыпляется', async () => {
      // Прод работает в двух процессах: проигравший гонку сборщик получает от
      // chargeRent false — не потому, что денег нет, а потому что сосед только
      // что заплатил, — и идёт усыплять оплаченный продукт.
      const p = await due({ slug: 'sleep-paid', overdue: '-10 days' });

      expect(await rent().requestSleep(p.id)).toBe(false);
      expect(await jobsOf(p.id)).toEqual([]);
      expect((await getProduct(p.id)).status).toBe('running');
    });

    it('50. два ОДНОВРЕМЕННЫХ запроса сна дают одно задание', async () => {
      const p = await due({ slug: 'sleep-double' });

      const outcomes = await Promise.all([rent().requestSleep(p.id), rent().requestSleep(p.id)]);

      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await jobsOf(p.id)).toEqual(['queued']);
    });

    it('51. сон не трогает соседний продукт', async () => {
      const other = await bystander();
      const neighbour = await due({ slug: 'sleep-neighbour' });
      const p = await due({ slug: 'sleep-mine' });

      expect(await rent().requestSleep(p.id)).toBe(true);

      expect((await getProduct(neighbour.id)).status).toBe('running');
      expect(await jobsOf(neighbour.id)).toEqual([]);
      await expectUntouched(other);
    });

    it('52. пробуждение ставится только спящим и только на сколько хватает денег', async () => {
      // Хватает ровно на один месяц — значит просыпается ОДИН продукт, тот,
      // что уснул раньше. Двадцать контейнеров, стартующих разом на одной
      // машине, — отказ по памяти.
      const first = await due({ slug: 'wake-first', status: 'sleeping', overdue: '10 days', userId: 'u-w' });
      const second = await due({ slug: 'wake-second', status: 'sleeping', overdue: '2 days', userId: 'u-w' });
      const awake = await due({ slug: 'wake-awake', overdue: '-5 days', userId: 'u-w' });
      await setBalance('u-w', 50_000);

      expect(await rent().wakeAffordable('u-w')).toBe(1);

      expect(await jobKindsOf(first.id)).toEqual(['wake']);
      expect(await jobsOf(second.id)).toEqual([]);
      expect(await jobsOf(awake.id)).toEqual([]);
    });

    it('53. денег на два месяца — просыпаются двое из трёх', async () => {
      const a = await due({ slug: 'wake-a', status: 'sleeping', overdue: '10 days', userId: 'u-w' });
      const b = await due({ slug: 'wake-b', status: 'sleeping', overdue: '5 days', userId: 'u-w' });
      const c = await due({ slug: 'wake-c', status: 'sleeping', overdue: '1 day', userId: 'u-w' });
      await setBalance('u-w', 120_000);

      expect(await rent().wakeAffordable('u-w')).toBe(2);

      expect(await jobsOf(a.id)).toEqual(['queued']);
      expect(await jobsOf(b.id)).toEqual(['queued']);
      expect(await jobsOf(c.id)).toEqual([]);
    });

    it('54. пустой и отрицательный баланс не будят никого', async () => {
      // На 2026-08-08 один пользователь был на −7 363: прямые UPDATE в чате
      // уводили баланс в минус. Целочисленное деление отрицательного числа на
      // цену аренды даёт отрицательное число мест — проверено, а не выведено.
      const p = await due({ slug: 'wake-broke', status: 'sleeping', userId: 'u-w' });

      await setBalance('u-w', 0);
      expect(await rent().wakeAffordable('u-w')).toBe(0);

      await setBalance('u-w', -7_363);
      expect(await rent().wakeAffordable('u-w')).toBe(0);

      await setBalance('u-w', 49_999);
      expect(await rent().wakeAffordable('u-w')).toBe(0);
      expect(await jobsOf(p.id)).toEqual([]);
    });

    it('55. продукт с активным заданием не получает второго и не съедает чужое место', async () => {
      // Место в бюджете, потраченное на продукт, которому задание всё равно не
      // поставится, тихо отнимает пробуждение у соседа. ON CONFLICT про это
      // молчит: он лишь пропускает вставку.
      const busy = await due({ slug: 'wake-busy', status: 'sleeping', overdue: '10 days', userId: 'u-w' });
      const next = await due({ slug: 'wake-next', status: 'sleeping', overdue: '5 days', userId: 'u-w' });
      await job(busy.id, { status: 'queued' });
      await setBalance('u-w', 50_000);

      expect(await rent().wakeAffordable('u-w')).toBe(1);

      expect(await jobsOf(busy.id)).toEqual(['queued']);
      expect(await jobKindsOf(busy.id)).toEqual(['provision']);
      expect(await jobKindsOf(next.id)).toEqual(['wake']);
    });

    it('56. пробуждение будит только СВОИ продукты', async () => {
      const mine = await due({ slug: 'wake-mine', status: 'sleeping', userId: 'u-w' });
      const foreign = await due({ slug: 'wake-foreign', status: 'sleeping', userId: 'u-other' });
      await setBalance('u-w', 500_000);
      await setBalance('u-other', 500_000);

      expect(await rent().wakeAffordable('u-w')).toBe(1);

      expect(await jobsOf(mine.id)).toEqual(['queued']);
      expect(await jobsOf(foreign.id)).toEqual([]);
    });

    it('57. оборот сборщика: богатому списывает, бедного усыпляет, оплаченного не трогает', async () => {
      // Сквозной стык задач 2, 4 и 5 на живой базе. Порознь все три половины
      // зелены и при разъехавшихся условиях отбора.
      const rich = await due({ slug: 'tick-rich', userId: 'u-rich' });
      const poor = await due({ slug: 'tick-poor', userId: 'u-poor' });
      const paid = await due({ slug: 'tick-paid', overdue: '-3 days', userId: 'u-rich' });
      await setBalance('u-rich', 120_000);
      await setBalance('u-poor', 1_000);

      await rent().tick();

      expect(await balanceOf('u-rich')).toBe(70_000);
      expect((await getProduct(rich.id)).status).toBe('running');
      expect(await paidUntilOf(rich.id)).toBeGreaterThan(Date.now());

      expect((await getProduct(poor.id)).status).toBe('sleeping');
      expect((await getProduct(poor.id)).sleep_reason).toMatch(/токен/i);
      expect(await jobKindsOf(poor.id)).toEqual(['sleep']);
      expect(await balanceOf('u-poor')).toBe(1_000);

      expect((await getProduct(paid.id)).status).toBe('running');
      expect(await jobsOf(paid.id)).toEqual([]);
    });

    it('58. ДВА ОДНОВРЕМЕННЫХ оборота: списание одно, и никто не усыплён', async () => {
      // Прод работает в кластере из двух процессов, и оба обходят один и тот
      // же список должников. Проигравший получает от списания false — и без
      // предусловия `paid_until <= now()` внутри сна усыпил бы ТОЛЬКО ЧТО
      // ОПЛАЧЕННЫЙ продукт: владелец заплатил и тут же получил спящий продукт.
      const p = await due({ slug: 'tick-race' });
      await setBalance('u-1', 120_000);

      await Promise.all([rent().tick(), rent().tick()]);

      expect(await balanceOf('u-1')).toBe(70_000);
      expect((await getProduct(p.id)).status).toBe('running');
      expect(await jobsOf(p.id)).toEqual([]);
      expect(await ledgerOf('u-1')).toHaveLength(1);
    });

    it('59. сон, начатый ДО чужого списания, не усыпляет оплаченный продукт', async () => {
      // Единственное место, где замок на строке продукта в постановке сна
      // действительно нужен: во всём остальном одно задание на продукт держит
      // частичный уникальный индекс. Здесь два процесса кластера идут
      // ВСТРЕЧНО — один списывает, другой усыпляет, — и без `FOR UPDATE` сон
      // проверяет срок по снимку, взятому до чужого коммита: владелец платит и
      // тут же получает спящий продукт.
      //
      // Порядок задаётся посторонним замком на строке продукта: списание
      // встаёт в очередь первым, сон — вторым, очередь ожидающих в PostgreSQL
      // обслуживается по порядку прихода.
      const p = await due({ slug: 'sleep-vs-charge' });
      await setBalance('u-1', 120_000);

      const holder = await pool.connect();
      let released = false;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [p.id]);

        const charging = rent().chargeRent(p.id);
        await waitForLockWaiters(1);
        const sleeping = rent().requestSleep(p.id);
        await waitForLockWaiters(2);

        await holder.query('COMMIT');
        released = true;
        const [charged, slept] = await Promise.all([charging, sleeping]);

        expect(charged).toBe(true);
        expect(slept).toBe(false);
        expect((await getProduct(p.id)).status).toBe('running');
        expect(await jobsOf(p.id)).toEqual([]);
        expect(await paidUntilOf(p.id)).toBeGreaterThan(Date.now());
      } finally {
        if (!released) await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  });
  // ═══════════════════════════════════════════════════════════════════════
  // ВИД ЗАДАНИЯ ДОЕЗЖАЕТ ДО АГЕНТА (задача 6)
  //
  // Всё в этом блоке меряется на ЖИВОМ SQL, и не для полноты. Три вещи здесь
  // на моках не проверяются в принципе:
  //   - `kind` есть у ОБЕИХ таблиц, и неуточнённая ссылка — ошибка
  //     неоднозначности В РАНТАЙМЕ: мок SQL не исполняет и пропустит её;
  //   - выдача задания сверяет статус продукта ПО ВИДУ задания, а мок отдаёт
  //     свою строку независимо от условий;
  //   - у сна и пробуждения CTE выпуска токена ПУСТ, и внутреннее соединение
  //     с ним выбросило бы задание целиком — на моке этого не видно.
  // ═══════════════════════════════════════════════════════════════════════
  describe('вид задания', () => {
    const asleep = (slug: string, o: { kind?: 'site' | 'bot'; seenAgo?: string | null } = {}) =>
      product({ slug, status: 'sleeping', kind: o.kind ?? 'site', seenAgo: o.seenAgo ?? null });

    it('60. задание сна выдаётся СПЯЩЕМУ продукту', async () => {
      // ГЛАВНЫЙ СЦЕНАРИЙ БЛОКА. Прежнее условие выдачи было одно на всех —
      // `p.status = 'provisioning'`, — а requestSleep одним оператором ставит
      // задание и переводит продукт в 'sleeping'. Такое задание не
      // выдавалось бы НИКОГДА: висит в очереди, one_active запирает продукт,
      // через 10 минут его хоронит сборщик зависших. Кабинет показывает
      // «спит», контейнер работает, аренда не платится, ошибки нет нигде.
      const other = await bystander();
      const p = await asleep('sleep-claim');
      const j = await job(p.id, { kind: 'sleep' });

      const claimed = await makeSvc().claimJob('own');

      expect(claimed).not.toBeNull();
      expect([claimed!.jobId, claimed!.jobKind, claimed!.slug]).toEqual([j, 'sleep', 'sleep-claim']);
      expect((await getJob(j)).status).toBe('running');
      await expectUntouched(other);
    });

    it('61. задание пробуждения выдаётся и приносит ПОРТ', async () => {
      // Домен возвращают на тот же порт, с которого сняли. На хосте он живёт
      // в остановленном контейнере, то есть знает его только сервер.
      const p = await product({ slug: 'wake-claim', status: 'sleeping', port: 8007 });
      await job(p.id, { kind: 'wake' });

      const claimed = await makeSvc().claimJob('own');

      expect([claimed!.jobKind, claimed!.port]).toEqual(['wake', 8007]);
    });

    it('62. сон и пробуждение НЕ поворачивают runner-токен', async () => {
      // Раннер живёт ВНУТРИ контейнера: на пробуждении поднимается тот же
      // процесс с тем же RUNNER_TOKEN в окружении. Повёрнутый хеш означал бы
      // контейнер, который стартовал и не может аутентифицироваться, —
      // «разбудили» в мёртвое состояние, лечится только пересозданием.
      for (const kind of ['sleep', 'wake'] as const) {
        await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
        const p = await asleep(`no-rotate-${kind}`);
        const before = (await getProduct(p.id)).runner_token_hash;
        await job(p.id, { kind });

        const claimed = await makeSvc().claimJob('own');

        expect(claimed!.jobKind).toBe(kind);
        // Ключа нет вовсе, а не пустая строка.
        expect('runnerToken' in claimed!).toBe(false);
        expect((await getProduct(p.id)).runner_token_hash).toBe(before);
      }
    });

    it('63. заведение СПЯЩЕМУ продукту не выдаётся', async () => {
      // `status IN ('provisioning','sleeping')` вместо сверки в связке с видом
      // выдал бы заведение уснувшему продукту: агент развернул бы каркас
      // поверх живого каталога клиента и снёс бы его работу.
      const p = await asleep('provision-to-sleeper');
      await job(p.id, { kind: 'provision' });

      expect(await makeSvc().claimJob('own')).toBeNull();
    });

    it('64. сон РАБОТАЮЩЕМУ продукту не выдаётся', async () => {
      // Обратная половина той же связки. Сон ставится вместе с переводом в
      // 'sleeping' одним оператором, поэтому такой строки штатно не бывает —
      // но если она появится (правка руками, будущий код), гасить работающий
      // продукт без пометки в базе нельзя: аренда с него продолжит списываться
      // за погашенный контейнер.
      const p = await product({ slug: 'sleep-to-runner', status: 'running' });
      await job(p.id, { kind: 'sleep' });

      expect(await makeSvc().claimJob('own')).toBeNull();
    });

    it('65. смешанная очередь разбирается с головы, и каждый вид доезжает своим', async () => {
      // Сторож неоднозначности `kind` заодно: в запросе выдачи обе таблицы в
      // области видимости, и неуточнённая ссылка даёт 42702 в рантайме — 500
      // на КАЖДОМ опросе агента, то есть остановленную очередь целиком.
      const a = await product({ slug: 'mix-prov', status: 'provisioning' });
      const b = await asleep('mix-sleep', { kind: 'bot' });
      const c = await asleep('mix-wake');
      await job(a.id, { createdAgo: '3 minutes' });
      await job(b.id, { kind: 'sleep', createdAgo: '2 minutes' });
      await job(c.id, { kind: 'wake', createdAgo: '1 minute' });

      const svc = makeSvc();
      const got = [await svc.claimJob('own'), await svc.claimJob('own'), await svc.claimJob('own')];

      expect(got.map((g) => [g!.slug, g!.jobKind, g!.kind])).toEqual([
        ['mix-prov', 'provision', 'site'],
        ['mix-sleep', 'sleep', 'bot'],
        ['mix-wake', 'wake', 'site'],
      ]);
    });

    it('66. отказ сна возвращает продукт в работу, а не хоронит его', async () => {
      // Сорвавшийся сон значит, что контейнер НЕ погашен, то есть продукт
      // работает. Безусловный 'failed' увёл бы его из 'sleeping' в статус,
      // который не платит аренду (списание берёт running/degraded) и не
      // усыпляется повторно (requestSleep берёт их же): бесплатный хостинг
      // навсегда, видимый только по недосчитанной выручке. Плюс кнопка
      // «повторить» на таком продукте ставит ЗАВЕДЕНИЕ поверх живого каталога.
      const p = await asleep('sleep-failed');
      await pool.query('UPDATE products SET sleep_reason = $2 WHERE id = $1', [p.id, 'нет токенов']);
      const j = await job(p.id, { kind: 'sleep', status: 'running' });

      await makeSvc().completeJob(j, { ok: false, error: 'docker stop не отработал' });

      const row = await getProduct(p.id);
      expect(row.status).toBe('degraded');
      // Признак сна снят вместе со статусом: карточка работающего продукта не
      // должна объяснять, что ему не хватило токенов.
      expect(row.sleep_reason).toBeNull();
      expect(row.provision_error).toBe('docker stop не отработал');
      expect((await getJob(j)).status).toBe('failed');
    });

    it('67. отказ пробуждения оставляет продукт спящим', async () => {
      // Это правда: продукт как спал, так и спит. Следующее пополнение
      // поставит задание заново — wakeAffordable исключает только продукты с
      // АКТИВНЫМ заданием, а это уже закрыто.
      const p = await asleep('wake-failed');
      await pool.query('UPDATE products SET sleep_reason = $2 WHERE id = $1', [p.id, 'нет токенов']);
      const j = await job(p.id, { kind: 'wake', status: 'running' });

      await makeSvc().completeJob(j, { ok: false, error: 'контейнер не ответил' });

      const row = await getProduct(p.id);
      expect([row.status, row.sleep_reason]).toEqual(['sleeping', 'нет токенов']);
      expect(row.provision_error).toBe('контейнер не ответил');
    });

    it('68. отказ ЗАВЕДЕНИЯ по-прежнему хоронит продукт', async () => {
      // Сторож на случай, если разбор по виду съест старое поведение: без
      // 'failed' кнопка «повторить» (она требует именно его) умирает.
      const p = await product({ slug: 'prov-failed', status: 'provisioning' });
      const j = await job(p.id, { status: 'running' });

      await makeSvc().completeJob(j, { ok: false, error: 'порт занят' });

      expect((await getProduct(p.id)).status).toBe('failed');
    });

    it('69. удачный сон продукт не трогает', async () => {
      const p = await asleep('sleep-ok');
      const j = await job(p.id, { kind: 'sleep', status: 'running' });

      await makeSvc().completeJob(j, { ok: true });

      expect((await getProduct(p.id)).status).toBe('sleeping');
      expect((await getJob(j)).status).toBe('done');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // РАЗБУЖЕННЫЙ ВОЗВРАЩАЕТСЯ В РАБОТУ (задача 6, дыра на стыке)
  // ═══════════════════════════════════════════════════════════════════════
  describe('возврат разбуженного в работу', () => {
    // Сквозной сценарий трогает баланс, а эти таблицы заводит не список
    // миграций продуктов, и внешний beforeEach о них не знает.
    beforeAll(ensureBillingTables);
    beforeEach(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));
    afterAll(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));

    /** Спящий с живым раннером: контейнер поднят, отметка свежая. */
    const woken = async (slug: string, o: { kind?: 'site' | 'bot' } = {}) => {
      const p = await product({
        slug,
        status: 'sleeping',
        kind: o.kind ?? 'site',
        seenAgo: '10 seconds',
      });
      await pool.query('UPDATE products SET sleep_reason = $2 WHERE id = $1', [p.id, 'нет токенов']);
      return p;
    };

    it('70. спящий с удавшимся пробуждением возвращается в running', async () => {
      // ДЫРА НА СТЫКЕ. Без этого агент поднимал контейнер, отчитывался,
      // задание закрывалось — и продукт оставался спящим навсегда: аренду не
      // платит (списание берёт running/degraded), правок не принимает
      // (turns.enqueue требует running), гасить его больше нечем — заданий
      // нет. Контейнер живой, продукт мёртвый, ошибки нигде.
      const p = await woken('back-to-work');
      await job(p.id, { kind: 'wake', status: 'done', finishedAgo: '1 second' });

      await expect(makeSvc().promoteReady()).resolves.toBe(1);

      const row = await getProduct(p.id);
      expect(row.status).toBe('running');
      // Признак сна снят: иначе карточка работающего продукта до конца жизни
      // объясняет, что ему не хватило токенов.
      expect(row.sleep_reason).toBeNull();
    });

    it('71. просто спящий сам не просыпается, даже если отвечает', async () => {
      // Спящий, чей контейнер почему-то не погас (сон отказал, агент умер на
      // полпути), даёт живой раннер и живой ответ. Без условия на последнее
      // задание он сам возвращался бы в running и снова начинал платить
      // аренду, которой не хватило: продукт мигал бы между статусами с
      // суточным периодом, и разобрать это можно было бы только по истории
      // списаний.
      const p = await woken('still-asleep');
      await job(p.id, { kind: 'sleep', status: 'done', finishedAgo: '1 second' });

      await expect(makeSvc().promoteReady()).resolves.toBe(0);

      expect((await getProduct(p.id)).status).toBe('sleeping');
    });

    it('72. уснувший ПОСЛЕ пробуждения не воскресает', async () => {
      // `EXISTS (kind='wake' AND status='done')` истинен НАВСЕГДА после
      // первого удачного пробуждения — продукт, уснувший во второй раз,
      // воскресал бы сам на ближайшем тике и получал бы бесплатный хостинг.
      // Смотреть надо на ПОСЛЕДНЕЕ задание.
      const p = await woken('asleep-again');
      await job(p.id, { kind: 'wake', status: 'done', createdAgo: '2 hours' });
      await job(p.id, { kind: 'sleep', status: 'done', createdAgo: '1 minute' });

      await expect(makeSvc().promoteReady()).resolves.toBe(0);

      expect((await getProduct(p.id)).status).toBe('sleeping');
    });

    it('73. пробуждение без ответа раннера переводом не считается', async () => {
      // Тот же измеримый факт, что и при заведении: раннер живёт внутри
      // контейнера. Молчит — значит контейнер не поднялся, и «разбудили» было
      // бы тем же враньём, что «завели» без проверки.
      const p = await product({ slug: 'wake-silent', status: 'sleeping', seenAgo: '9 days' });
      await job(p.id, { kind: 'wake', status: 'done' });

      await expect(makeSvc().promoteReady()).resolves.toBe(0);
    });

    it('74. пробуждённый сайт, который не отвечает, переводом не считается', async () => {
      const p = await woken('wake-502');
      await job(p.id, { kind: 'wake', status: 'done' });

      const svc = makeSvc(async () => ({ status: 502 }));
      await expect(svc.promoteReady()).resolves.toBe(0);

      expect((await getProduct(p.id)).status).toBe('sleeping');
    });

    it('75. незакрытое задание пробуждения перевод не пускает', async () => {
      // Пока задание в очереди или в работе, «отвечает» означает СТАРОЕ
      // состояние, а не результат пробуждения. Та же защита, что у заведения.
      const p = await woken('wake-in-flight');
      await job(p.id, { kind: 'wake', status: 'running' });

      await expect(makeSvc().promoteReady()).resolves.toBe(0);
    });

    it('76. весь путь: уснул по бедности, разбужен пополнением, снова платит', async () => {
      // СКВОЗНОЙ СЦЕНАРИЙ КУСКА 3, от нехватки токенов до возобновлённого
      // списания. Каждый стык здесь уже ломался по отдельности, и собранными
      // они не проверялись ни разу.
      const p = await due({ slug: 'full-circle' });
      await setBalance('u-1', 10_000);
      await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [p.id]);

      // 1. Оборот аренды: денег нет — ставится сон.
      await rent().tick();
      expect((await getProduct(p.id)).status).toBe('sleeping');
      expect(await jobsOf(p.id)).toEqual(['queued']);

      // 2. Агент забирает сон и отчитывается.
      const svc = makeSvc();
      const sleepJob = await svc.claimJob('own');
      expect(sleepJob!.jobKind).toBe('sleep');
      await svc.completeJob(sleepJob!.jobId, { ok: true });
      expect((await getProduct(p.id)).status).toBe('sleeping');

      // 3. Спящий аренду не платит и переводом не считается.
      expect(await rent().chargeRent(p.id)).toBe(false);
      expect(await svc.promoteReady()).toBe(0);

      // 4. Пополнение ставит пробуждение.
      await setBalance('u-1', 120_000);
      expect(await rent().wakeAffordable('u-1')).toBe(1);

      // 5. Агент будит и отчитывается; токен при этом НЕ повернулся.
      const hashBefore = (await getProduct(p.id)).runner_token_hash;
      const wakeJob = await svc.claimJob('own');
      expect(wakeJob!.jobKind).toBe('wake');
      expect((await getProduct(p.id)).runner_token_hash).toBe(hashBefore);
      await svc.completeJob(wakeJob!.jobId, { ok: true });

      // 6. Перевод по измеримому факту — и продукт снова платит.
      await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [p.id]);
      expect(await svc.promoteReady()).toBe(1);
      const row = await getProduct(p.id);
      expect([row.status, row.sleep_reason]).toEqual(['running', null]);
      expect(await rent().chargeRent(p.id)).toBe(true);
      expect(await balanceOf('u-1')).toBe(70_000);
    });
  });

  /**
   * ОБОРОТ ПРОБУЖДЕНИЯ — задача 10, «пополнение баланса будит спящие продукты».
   *
   * План звал позвать `wakeAffordable` из места зачисления токенов, считая, что
   * оно одно плюс купон. Мест тринадцать, и три из них TypeScript не видит
   * вовсе: обе реферальные выплаты пишут `ai_profiles_consolidated` прямым
   * UPDATE, а `redeem_coupon` зовёт зачисление изнутри Postgres. Поэтому крюк
   * повешен на СОСТОЯНИЕ, а не на событие, и сценарий 79 ниже — прибор именно
   * для этого: он пополняет баланс так, как это делает реферальная программа,
   * и требует, чтобы продукт всё равно проснулся.
   *
   * Форма запросов — в rent.service.spec.ts; здесь только то, что на заглушках
   * ненаблюдаемо: чей продукт проснулся, на сколько хватило бюджета и сколько
   * заданий встало в очередь.
   */
  describe('оборот пробуждения', () => {
    beforeAll(ensureBillingTables);
    beforeEach(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));
    afterAll(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));

    it('77. пополнение будит спящие продукты владельца', async () => {
      // Главный сценарий задачи. Зачисление и пробуждение — РАЗНЫЕ операции:
      // пополнение не ждёт, пока поднимутся контейнеры, а пробуждение не
      // пропадает, если поднять их не удалось.
      const p = await due({ slug: 'topup-wake', status: 'sleeping', userId: 'u-pay' });
      await setBalance('u-pay', 0);

      // Пока денег нет, оборот ходит вхолостую и ничего не ставит.
      expect(await rent().wakeTick()).toBe(0);
      expect(await jobsOf(p.id)).toEqual([]);

      await setBalance('u-pay', 60_000);

      expect(await rent().wakeTick()).toBe(1);
      expect(await jobKindsOf(p.id)).toEqual(['wake']);
      expect(await jobsOf(p.id)).toEqual(['queued']);
      // Деньги здесь НЕ списываются: аренду возьмёт оборот сборщика, когда
      // продукт вернётся в running. Списание сейчас означало бы оплату месяца
      // за продукт, который может и не подняться.
      expect(await balanceOf('u-pay')).toBe(60_000);
    });

    it('78. обход идёт по всем владельцам, и каждый со своим бюджетом', async () => {
      // Один владелец без денег не должен задерживать пробуждение соседу.
      // Богатому хватает на два месяца — просыпаются оба его продукта.
      const richA = await due({
        slug: 'sweep-rich-a',
        status: 'sleeping',
        overdue: '10 days',
        userId: 'u-rich',
      });
      const richB = await due({
        slug: 'sweep-rich-b',
        status: 'sleeping',
        overdue: '5 days',
        userId: 'u-rich',
      });
      const poor = await due({ slug: 'sweep-poor', status: 'sleeping', userId: 'u-poor' });
      await setBalance('u-rich', 120_000);
      await setBalance('u-poor', 1_000);

      expect(await rent().wakeTick()).toBe(2);

      expect(await jobKindsOf(richA.id)).toEqual(['wake']);
      expect(await jobKindsOf(richB.id)).toEqual(['wake']);
      expect(await jobsOf(poor.id)).toEqual([]);
    });

    it('79. зачисление ПРЯМЫМ UPDATE (реферальная программа) тоже будит', async () => {
      // ПРИБОР ДЛЯ ВЫБОРА КРЮКА. `referral.service.payoutTokens` и
      // `referral.service.register` пишут баланс именно так — мимо
      // `add_user_tokens`, мимо `token_transactions` и мимо любого события, на
      // которое можно было бы подписаться. Вызов пробуждения, расставленный по
      // местам зачисления, этих двух путей не закрыл бы, и продукт не проснулся
      // бы никогда: владелец видел бы деньги на балансе и спящий продукт
      // одновременно.
      const p = await due({ slug: 'referral-wake', status: 'sleeping', userId: 'u-ref' });
      await setBalance('u-ref', 0);

      await pool.query(
        `UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2`,
        [70_000, 'u-ref'],
      );

      expect(await rent().wakeTick()).toBe(1);
      expect(await jobKindsOf(p.id)).toEqual(['wake']);
      // И следа в учёте у этого пути нет — то есть отбор «кому зачислили» по
      // token_transactions не нашёл бы его тоже.
      expect(await ledgerOf('u-ref')).toEqual([]);
    });

    it('80. продукт, который уже будят, второго задания не получает', async () => {
      // Оборот ходит раз в минуту, а пробуждение длится минутами: старт
      // контейнера, сборка, health-check. Без исключения активных заданий
      // каждый оборот ставил бы поверх ещё одно, и агент хоста поднимал бы один
      // и тот же контейнер по кругу.
      const p = await due({ slug: 'already-waking', status: 'sleeping', userId: 'u-again' });
      await setBalance('u-again', 500_000);

      expect(await rent().wakeTick()).toBe(1);
      expect(await rent().wakeTick()).toBe(0);
      expect(await rent().wakeTick()).toBe(0);

      expect(await jobKindsOf(p.id)).toEqual(['wake']);
    });

    it('81. оборот не трогает ни бодрствующих, ни архивных', async () => {
      // Отбор владельцев идёт по спящим, но бюджет считается по всем спящим
      // продуктам владельца. Архивный, попавший в отбор, съел бы место в
      // бюджете и отнял пробуждение у живого соседа: денег здесь ровно на один
      // месяц, а архивный уснул раньше и стоял бы в очереди первым.
      const other = await bystander();
      const awake = await due({ slug: 'sweep-awake', userId: 'u-mix' });
      const archived = await due({
        slug: 'sweep-archived',
        status: 'sleeping',
        overdue: '20 days',
        userId: 'u-mix',
      });
      await pool.query('UPDATE products SET archived_at = now() WHERE id = $1', [archived.id]);
      const asleep = await due({
        slug: 'sweep-asleep',
        status: 'sleeping',
        overdue: '1 day',
        userId: 'u-mix',
      });
      await setBalance('u-mix', 50_000);

      expect(await rent().wakeTick()).toBe(1);

      expect(await jobKindsOf(asleep.id)).toEqual(['wake']);
      expect(await jobsOf(awake.id)).toEqual([]);
      expect(await jobsOf(archived.id)).toEqual([]);
      expect((await getProduct(awake.id)).status).toBe('running');
      await expectUntouched(other);
    });
  });

  // ═══════════ блокированный продукт против аренды и будильника ═══════════

  /**
   * ГЛАВНОЕ, РАДИ ЧЕГО ГАШЕНИЕ СДЕЛАНО ОТДЕЛЬНЫМ СТАТУСОМ, А НЕ ПРИЧИНОЙ СНА.
   *
   * Утверждение куска — «блокированный выпадает из аренды и будильника САМ
   * СОБОЙ, потому что те отбирают по конкретным статусам». Утверждение
   * правдоподобное и потому опасное: оно держится на ОТСУТСТВИИ значения в
   * чужих фильтрах, а отсутствие возвращается незаметно — достаточно, чтобы
   * кто-нибудь однажды расширил `IN ('running','degraded')` или написал «всё,
   * кроме архивных».
   *
   * Проверяется здесь, в куске со схемой, а не рядом с гашением: гашения ещё
   * нет, а свойство уже есть, и появиться оно обязано ВМЕСТЕ со статусом.
   * Исполнением, а не по тексту: фильтр читается в файле совершенно одинаково
   * и до, и после такой правки.
   */
  describe('блокированный вне денег', () => {
    beforeAll(ensureBillingTables);
    beforeEach(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));
    afterAll(() => pool.query('TRUNCATE ai_profiles_consolidated, token_transactions'));

    it('82. с блокированного аренда не списывается, даже когда срок истёк и деньги есть', async () => {
      // Худший исход: администратор погасил продукт, а с владельца каждый месяц
      // продолжают брать 50 000 за остановленный контейнер. Увидит это владелец
      // в своём балансе, а узнаем мы от него.
      //
      // ЧТО ИМЕННО СТОРОЖИТ — измерено мутациями, а не выведено. Денег между
      // блокированным продуктом и балансом два слоя: отбор `tick` и предусловие
      // `chargeRent`. Здесь проверяется ИСХОД, то есть оба разом, и цена этого
      // названа честно: мутация ОДНОГО только отбора (`tick` берёт и
      // блокированных) оставляет сценарий зелёным — второй слой отбивает
      // списание. Её ловит форма запроса («обход отбирает только неоплаченных,
      // живых и не архивных»), а внутренний слой — сценарий 83.
      const other = await bystander();
      const p = await due({ slug: 'blk-rent', overdue: '1 day' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [p.id]);
      await setBalance('u-1', 500_000);

      await rent().tick();

      expect(await balanceOf('u-1')).toBe(500_000);
      expect(await ledgerOf('u-1')).toEqual([]);
      // И статус не тронут: сборщик не усыпляет блокированного «заодно» —
      // requestSleep берёт только running/degraded.
      expect((await getProduct(p.id)).status).toBe('blocked');
      expect(await jobsOf(p.id)).toEqual([]);
      await expectUntouched(other);
    });

    it('83. chargeRent, позванный по блокированному НАПРЯМУЮ, тоже ничего не берёт', async () => {
      // Отбор `tick` и предусловие `chargeRent` — два РАЗНЫХ места с одним и
      // тем же списком статусов. Сценарий 82 проверяет первое: сними условие у
      // chargeRent, и он останется зелёным, потому что до chargeRent дело не
      // дойдёт. Прод работает в кластере, и второй процесс зовёт chargeRent по
      // продукту, который первый отобрал секунду назад.
      const p = await due({ slug: 'blk-charge', overdue: '1 day' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [p.id]);
      await setBalance('u-1', 500_000);

      await expect(rent().chargeRent(p.id)).resolves.toBe(false);

      expect(await balanceOf('u-1')).toBe(500_000);
    });

    it('84. пополнение НЕ будит блокированного, а спящего рядом будит', async () => {
      // ГЛАВНЫЙ СЦЕНАРИЙ КУСКА. Ровно это делало бы гашение причиной сна
      // бессмысленным: wakeAffordable отбирает по статусу 'sleeping' и ставит
      // задание пробуждения каждому, на кого хватает баланса. Спящий рядом — не
      // украшение: без него сценарий зеленел бы и при будильнике, который не
      // будит ВООБЩЕ никого.
      const asleep = await due({ slug: 'blk-asleep', status: 'sleeping', overdue: '2 days' });
      const blocked = await due({ slug: 'blk-blocked', overdue: '1 day' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [blocked.id]);
      await setBalance('u-1', 500_000);

      expect(await rent().wakeTick()).toBe(1);

      expect(await jobKindsOf(asleep.id)).toEqual(['wake']);
      expect(await jobsOf(blocked.id)).toEqual([]);
      expect((await getProduct(blocked.id)).status).toBe('blocked');
    });

    it('85. владельцу ОДНОГО только блокированного продукта пробуждать нечего', async () => {
      // Случай, которого нет в 84: у владельца НЕТ ни одного спящего продукта,
      // то есть будильнику не за что зацепиться вовсе. На проде это самый
      // частый вид блокированного аккаунта — один продукт, и тот погашен.
      //
      // ЧЕГО ЭТОТ СЦЕНАРИЙ НЕ СТОРОЖИТ — измерено мутациями, а не выведено.
      // Будильник двухэтажный: `wakeTick` собирает владельцев, `wakeAffordable`
      // отбирает продукты. Мутация ВНЕШНЕГО этажа (wakeTick собирает и
      // владельцев блокированных) оставляет сценарий зелёным — внутренний
      // этаж всё равно не находит, что будить, и ответ по-прежнему 0. Её ловит
      // форма запроса («владельцы берутся из СПЯЩИХ продуктов, а не из следов
      // пополнения»); внутренний этаж сторожит сценарий 84.
      const blocked = await due({ slug: 'blk-alone', overdue: '1 day', userId: 'u-один' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [blocked.id]);
      await setBalance('u-один', 500_000);

      expect(await rent().wakeTick()).toBe(0);

      expect(await jobsOf(blocked.id)).toEqual([]);
    });

    it('86. блокированный ЗАНИМАЕТ место на машине — до архивации, а не до гашения', async () => {
      // Потолок машины считает всё, кроме архивных. Вычти из него блокированных
      // — и погашенный продукт освободил бы место, которое по-прежнему занимают
      // его каталог, контейнер и запись домена: машина набрала бы продуктов
      // сверх ёмкости, а снятие блокировки подняло бы их все разом.
      const p = await product({ slug: 'blk-slot', host: 'clients', status: 'running' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [p.id]);
      await pool.query(`UPDATE product_hosts SET capacity = 1 WHERE id = 'clients'`);

      await expect(
        makeSvc().create({
          userId: 'u-кли',
          isAdmin: false,
          name: 'второй',
          slug: 'blk-slot-2',
          kind: 'site',
          secrets: {},
        }),
        // Текст именно про МЕСТА: пустой реестр и отсутствие машины нужной
        // аудитории отвечают своими, и голый rejects.toThrow() зеленел бы на
        // любом из них — в том числе на «column does not exist».
      ).rejects.toThrow(/Свободных мест/);
      // Заодно: отбитое заведение не оставило после себя ни строки продукта.
      expect(
        (await pool.query(`SELECT count(*) FROM products WHERE slug = 'blk-slot-2'`)).rows[0].count,
      ).toBe('0');
    });
  });

  // ═════════════ предел числа продуктов на аккаунт (кусок 4б) ═════════════
  //
  // Весь блок — против ЖИВОЙ базы, и это не перестраховка. Всё, чем предел
  // держится, живёт в одном операторе: COALESCE умолчания, отбор по владельцу,
  // отбор по archived_at и само сравнение. Заглушка pg не исполняет ни одного
  // из них, то есть юнит-прогон одинаково зелен и на работающем пределе, и на
  // реализации, отдающей «можно» на любой вход.

  describe('предел продуктов на аккаунт', () => {
    /**
     * Заведение от имени КОНКРЕТНОГО владельца. Умолчание — не админ: предел
     * считается именно для них, а вкладка куском 4б открывается всем.
     */
    const create = (o: { slug: string; userId?: string; isAdmin?: boolean }) =>
      makeSvc().create({
        userId: o.userId ?? 'u-кли',
        isAdmin: o.isAdmin ?? false,
        name: `имя ${o.slug}`,
        slug: o.slug,
        kind: 'site',
        secrets: {},
      });

    /** Отказ, а не результат: `.rejects` не даёт посмотреть на код ответа. */
    const refusedOn = (p: Promise<unknown>) => p.then(() => null, (e: any) => e);

    /** Поднять предел конкретному аккаунту — ровно так, как это делается руками. */
    const raise = (userId: string, max: number) =>
      pool.query(
        `INSERT INTO product_user_limits (user_id, max_products, note)
         VALUES ($1, $2, 'по просьбе')`,
        [userId, max],
      );

    const liveOf = async (userId: string) =>
      Number(
        (
          await pool.query(
            `SELECT count(*) FROM products WHERE user_id = $1 AND archived_at IS NULL`,
            [userId],
          )
        ).rows[0].count,
      );

    it('87. третий продукт отбивается пределом аккаунта: 422 и текст, который кабинет покажет', async () => {
      // ГЛАВНЫЙ СЦЕНАРИЙ ЗАДАЧИ. Места на машине ЕСТЬ — двадцать, занято два.
      // Без предела третий завёлся бы, и один человек забрал бы всю клиентскую
      // машину бесплатно: первый месяц аренды не стоит ничего.
      await addHost({ id: 'clients', capacity: 20 });
      await create({ slug: 'ss-a' });
      await create({ slug: 'ss-b' });

      const e = await refusedOn(create({ slug: 'ss-c' }));

      // Код разбирает КАБИНЕТ: на 409 он показывает «Этот адрес уже занят», а
      // весь пятисотый диапазон глушит своим текстом. 422 — единственный, в
      // котором владелец прочитает НАШУ формулировку.
      expect(e).toBeInstanceOf(UnprocessableEntityException);
      expect(e.getStatus()).toBe(422);
      // Текст называет и предел, и действие. Действие существует: архивации в
      // продукте нет ни кнопки, ни маршрута, ни строки кода, поэтому советовать
      // её нельзя, а «попробуйте позже» — прямая неправда, само не пройдёт.
      expect(String(e.message)).toMatch(/Предел — 2 продукта/);
      expect(String(e.message)).toMatch(/напишите нам/i);
      expect(String(e.message)).not.toMatch(/позже|архив/i);
      // И причина СВОЯ: про места на машинах здесь ни слова — они свободны.
      expect(String(e.message)).not.toMatch(/мест/i);

      // Отказ не оставляет ни строки, ни занятого слага, ни лишнего задания:
      // два задания — ровно от двух удавшихся заведений.
      expect(await liveOf('u-кли')).toBe(2);
      expect(
        Number((await pool.query(`SELECT count(*) FROM products WHERE slug = 'ss-c'`)).rows[0].count),
      ).toBe(0);
      expect(
        Number((await pool.query('SELECT count(*) FROM product_provision_jobs')).rows[0].count),
      ).toBe(2);
    });

    it('88. предел считает спящих и блокированных, но не архивных', async () => {
      // Место занято до АРХИВАЦИИ, а не до остановки: у спящего остаются
      // каталог, контейнер и запись домена, и просыпается он от одного
      // пополнения баланса. Не считать спящих — значит позволить накопить
      // продуктов сверх предела и поднять их все разом.
      await addHost({ id: 'clients', capacity: 20 });
      const a = await create({ slug: 'ss-sl' });
      const b = await create({ slug: 'ss-bl' });
      await pool.query(`UPDATE products SET status = 'sleeping' WHERE id = $1`, [a.productId]);
      await pool.query(`UPDATE products SET status = 'blocked'  WHERE id = $1`, [b.productId]);

      expect(String((await refusedOn(create({ slug: 'ss-c2' }))).message)).toMatch(/Предел/);

      // Архивация — единственное, что освобождает место.
      await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [a.productId]);
      const ok = await create({ slug: 'ss-c3' });
      expect((await getProduct(ok.productId)).host_id).toBe('clients');
    });

    it('89. поднятый предел действует ТОЛЬКО своему аккаунту, и число в отказе едет из строки', async () => {
      // «Больше — по просьбе, отдельному человеку» (решение владельца).
      // Реализация с одним пределом на всех прошла бы сценарий 87 зелёной.
      await addHost({ id: 'clients', capacity: 20 });
      await raise('u-щедрый', 5);

      for (const s of ['ss-r1', 'ss-r2', 'ss-r3', 'ss-r4', 'ss-r5']) {
        await create({ slug: s, userId: 'u-щедрый' });
      }
      expect(await liveOf('u-щедрый')).toBe(5);

      // Шестой отбивается ЕГО числом, а не умолчанием: текст, в котором стоит
      // двойка, означал бы предел, прочитанный не из строки исключения.
      const his = await refusedOn(create({ slug: 'ss-r6', userId: 'u-щедрый' }));
      expect(String(his.message)).toMatch(/Предел — 5 продуктов/);

      // А соседу — по-прежнему два: исключение не расползается на аккаунты.
      await create({ slug: 'ss-n1', userId: 'u-сосед' });
      await create({ slug: 'ss-n2', userId: 'u-сосед' });
      const neighbour = await refusedOn(create({ slug: 'ss-n3', userId: 'u-сосед' }));
      expect(String(neighbour.message)).toMatch(/Предел — 2 продукта/);
    });

    it('90. предел спрашивается РАНЬШЕ машины: причина не подменяется чужой', async () => {
      // Машин нет вовсе — реестр пуст (состояние достижимое: 005 ничего не
      // заводит при незаполненном PRODUCT_HOST_TOKEN). Владелец двух продуктов
      // обязан услышать про СВОЙ предел, а не про хостинг: первое лечится
      // письмом нам, второе — нашей машиной, и ждать его бессмысленно.
      await product({ slug: 'ss-o1', userId: 'u-кли', status: 'running', host: null, domain: null });
      await product({ slug: 'ss-o2', userId: 'u-кли', status: 'running', host: null, domain: null });

      const e = await refusedOn(create({ slug: 'ss-o3' }));

      expect(String(e.message)).toMatch(/Предел — 2 продукта/);
      // Ни одна из трёх причин реестра сюда не доезжает.
      expect(String(e.message)).not.toMatch(/не настроен|мест|аудитор/i);
    });

    it('91. предел считает продукты ЭТОГО владельца, а не все подряд', async () => {
      // `count(*) FROM products` без условия по владельцу выглядит упрощением и
      // запирает всех разом, как только двое завели по продукту. Своих
      // продуктов здесь ноль, чужих — три.
      await addHost({ id: 'clients', capacity: 20 });
      for (const s of ['ss-x1', 'ss-x2', 'ss-x3']) {
        await product({ slug: s, userId: 'u-сосед', host: 'clients' });
      }

      const r = await create({ slug: 'ss-mine', userId: 'u-кли' });

      expect((await getProduct(r.productId)).host_id).toBe('clients');
    });

    it('92. счёт и предел сравниваются ЧИСЛАМИ: девять разрешённых против десяти заведённых', async () => {
      // ДЕВЯТЬ И ДЕСЯТЬ ВЫБРАНЫ НАРОЧНО. Лексикографически '10' < '9', то есть
      // сравнение строк ответило бы «место есть» — и предел молча перестал бы
      // работать у всех, кому его подняли выше девяти.
      //
      // ПРИБОР, ОБЪЯСНЯЮЩИЙ, ПОЧЕМУ СРАВНЕНИЕ ЖИВЁТ В SQL: типы в выдаче
      // РАЗНЫЕ. count(*) — bigint, и node-pg отдаёт его строкой; max_products —
      // int4, и он приезжает числом. На этом расхождении JS-сравнение работает
      // СЛУЧАЙНО (строка приводится к числу), и мутация «убрать Number()»
      // зелена — то есть щель есть, а сторожа у неё в JS быть не может. В SQL
      // типы точные, и щели не остаётся.
      await addHost({ id: 'clients', capacity: 20 });
      await raise('u-кли', 9);
      for (let i = 1; i <= 10; i++) {
        await product({ slug: `ss-num${i}`, userId: 'u-кли', host: 'clients' });
      }

      const e = await refusedOn(create({ slug: 'ss-num11' }));
      expect(String(e.message)).toMatch(/Предел — 9 продуктов/);

      const types = await pool.query(
        `SELECT (SELECT count(*) FROM products WHERE user_id = 'u-кли') AS used,
                (SELECT max_products FROM product_user_limits WHERE user_id = 'u-кли') AS allowed`,
      );
      expect(typeof types.rows[0].used).toBe('string');
      expect(typeof types.rows[0].allowed).toBe('number');
    });

    it('93. администратора предел аккаунта не держит, а потолок СВОЕЙ машины — держит', async () => {
      // Предел бережёт клиентскую машину и бесплатный месяц, а продукты
      // администратора туда не попадают вовсе — они уезжают на машины
      // аудитории own. Цена обратного решения снята с прода 22.09.2026: у
      // аккаунта владельца РОВНО ДВА живых продукта (demo и shop2), то есть
      // предел, распространённый на администратора, запер бы владельца в день
      // выката — на его собственной машине с восемнадцатью свободными местами.
      //
      // Вторая половина сценария обязательна: без неё «админ не считается»
      // было бы зелено и у реализации, которая админу не проверяет ВООБЩЕ
      // ничего. Админ ограничен — просто другим числом и по другому поводу.
      await ensureHost('own');
      for (const s of ['ss-adm1', 'ss-adm2', 'ss-adm3']) {
        await create({ slug: s, userId: 'u-адм', isAdmin: true });
      }
      expect(await liveOf('u-адм')).toBe(3);

      await pool.query(`UPDATE product_hosts SET capacity = 3 WHERE id = 'own'`);
      const e = await refusedOn(create({ slug: 'ss-adm4', userId: 'u-адм', isAdmin: true }));
      expect(String(e.message)).toMatch(/мест/i);
      expect(String(e.message)).not.toMatch(/Предел —/);
    });

    it('94. умолчание живёт КОНСТАНТОЙ кода, а не строкой в таблице', async () => {
      // Таблица исключений остаётся ПУСТОЙ у обычного аккаунта: строка
      // умолчания, дописанная «для порядка», превратила бы правку константы в
      // правку данных всех аккаунтов сразу, а заведённые до неё молча остались
      // бы на старом числе.
      await addHost({ id: 'clients', capacity: 20 });
      for (let i = 0; i < DEFAULT_MAX_PRODUCTS; i++) {
        await create({ slug: `ss-def${i}` });
      }

      const e = await refusedOn(create({ slug: 'ss-def-over' }));
      expect(String(e.message)).toContain(`Предел — ${DEFAULT_MAX_PRODUCTS} `);
      expect(
        Number((await pool.query('SELECT count(*) FROM product_user_limits')).rows[0].count),
      ).toBe(0);
    });

    it('95. предел аккаунта МЯГКИЙ под одновременными заявками — измерено, не закрыто', async () => {
      // ИЗМЕРЕНИЕ, А НЕ ПОЖЕЛАНИЕ, И ЦЕНА ЗДЕСЬ НА ПОРЯДОК БОЛЬШЕ ТОЙ, ЧТО
      // НАЗВАНА В СПЕКЕ. Спека говорит «третий продукт вместо двух».
      //
      // Снято на этой же ноде (PostgreSQL 16, один аккаунт, предел 2, потолок
      // машины снят, два прогона). Заявки пущены Promise.all БЕЗ барьера —
      // то есть так, как их пустил бы curl в цикле:
      //
      //     заявок в залпе   2    3    5   10   20   50
      //     завелось         2    2    3  5–7 10–15 30–31
      //
      // Отбивается примерно половина, остальные проходят. «Третий продукт
      // вместо двух» верно только для залпа из трёх. Клиентская машина
      // рассчитана на двадцать продуктов — один аккаунт забирает её ЦЕЛИКОМ
      // одним залпом, то есть предел не останавливает ровно тот сценарий,
      // ради которого заведён. От честной ошибки он бережёт, от намеренной —
      // нет.
      //
      // Причина: проверка и вставка это два оператора, а каждый запрос через
      // пул сам себе транзакция — заявки видят снимок без чужих строк.
      // Сценарий ниже воспроизводит предельный случай детерминированно: пять
      // из пяти.
      //
      // Одним оператором не чинится: `INSERT … SELECT` берёт тот же снимок, а
      // FOR UPDATE лочит строку после вычисления условия. Настоящее закрытие —
      // advisory-лок на владельца (PgService.tryAdvisoryLock, выделенное
      // соединение) вокруг проверки и вставки. Не сделано в этой задаче
      // сознательно: вставка продукта — самая сложная запись модуля, а закрытие
      // предела аккаунта заодно закрывает и сценарий 51м, то есть это своя
      // задача со своей батареей.
      //
      // Тест краснеет, когда предел ЗАКРОЮТ, — и тогда его надо читать, а не
      // чинить: ограничение снято, комментарий устарел.
      //
      // ГОНКА ВОСПРОИЗВОДИТСЯ ТОЧНО, А НЕ ЛОВИТСЯ `Promise.all` — барьером, как
      // в 51м: все пять проверок предела обязаны СНЯТЬ СНИМОК, и только потом
      // любое из заведений идёт дальше. Иначе сценарий проходил бы по
      // настроению пула.
      await addHost({ id: 'clients', capacity: 20 });
      const BURST = 5;
      let checked = 0;
      let openGate: () => void = () => undefined;
      const gate = new Promise<void>((r) => (openGate = r));
      const gatedPg = {
        query: async (sql: string, params?: any[]) => {
          const r = await pool.query(sql, params);
          if (/FROM product_user_limits/.test(sql)) {
            if (++checked === BURST) openGate();
            await gate;
          }
          return r;
        },
      };
      const raced = () =>
        new ProvisioningService(
          gatedPg as any,
          secrets,
          new HostsService(gatedPg as any),
          new LimitsService(gatedPg as any),
        );

      const all = await Promise.all(
        Array.from({ length: BURST }, (_, i) =>
          refusedOn(
            raced().create({
              userId: 'u-кли',
              isAdmin: false,
              name: `гонка ${i}`,
              slug: `ss-race${i}`,
              kind: 'site',
              secrets: {},
            }),
          ),
        ),
      );

      expect(checked).toBe(BURST);
      expect(all.every((e) => e === null)).toBe(true);
      expect(await liveOf('u-кли')).toBe(BURST);
    });
  });

  // ═══════ гашение администратором и снятие блокировки (кусок 4б) ═══════
  //
  // Весь блок — против ЖИВОЙ базы, и это не перестраховка, а необходимость.
  // Гашение целиком живёт в ОДНОМ операторе, и всё, чем оно держится, —
  // исполняемое: частичный уникальный индекс product_provision_jobs_one_active
  // (снять старое задание и поставить новое одной командой — НЕ то же самое,
  // что просто поставить), порядок частей WITH, замок FOR UPDATE, условие
  // единственности совпадения. Заглушка pg не исполняет ни одного из них, то
  // есть юнит-прогон одинаково зелен и на работающем гашении, и на операторе,
  // который падает с 23505 на каждом продукте с активным заданием (мутация
  // M14: снятая ссылка на killed_jobs краснит здесь шесть сценариев и ноль
  // где-либо ещё).
  //
  // НУМЕРАЦИЯ. План предлагал сценарии 66–70 — эти номера в файле ЗАНЯТЫ с
  // куска 3 (отказ сна, отказ пробуждения, отказ заведения, удачный сон).
  // Дублирующиеся имена jest принимает молча, и разбирать потом, который из
  // двух «66» упал, пришлось бы по строкам стека.

  describe('гашение администратором', () => {
    const blocks = () => new BlockService(pg as any);

    /** Ходы продукта: статус и причина, в порядке появления. */
    const turnsOf = async (productId: string) =>
      (
        await pool.query(
          'SELECT status, error FROM product_turns WHERE product_id = $1 ORDER BY created_at',
          [productId],
        )
      ).rows;

    /** Задания продукта целиком: вид, статус, причина. */
    const jobRowsOf = async (productId: string) =>
      (
        await pool.query(
          'SELECT kind, status, error FROM product_provision_jobs WHERE product_id = $1 ORDER BY created_at',
          [productId],
        )
      ).rows;

    /** Гашение пишет строку в журнал на каждое решение — глушим её. */
    const quiet = (svc: BlockService) =>
      jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    // ─────────────────────── как находим продукт ───────────────────────

    it('96. гашение по домену, слагу и id находит ОДИН И ТОТ ЖЕ продукт', async () => {
      // Три способа — один результат. Без этого сценария любой из трёх мог бы
      // молча не находить ничего: отказ «не найден» выглядит одинаково и когда
      // ключ разобран неверно, и когда продукта действительно нет.
      const other = await bystander();
      const p = await product({ slug: 'ss-find', kind: 'site', status: 'running' });

      for (const key of [p.domain!, 'ss-find', p.id]) {
        await pool.query(
          `UPDATE products SET status = 'running', block_reason = NULL WHERE id = $1`,
          [p.id],
        );
        const svc = blocks();
        quiet(svc);
        await svc.block(key, `нарушение по ключу ${key}`);

        const row = await getProduct(p.id);
        expect([row.status, row.block_reason]).toEqual(['blocked', `нарушение по ключу ${key}`]);
      }
      // И трижды подряд: повторное гашение снимает прошлое задание и ставит
      // новое, а не падает на уникальном индексе. Активное задание ровно одно.
      expect(await jobRowsOf(p.id)).toEqual([
        { kind: 'sleep', status: 'failed', error: JOB_KILLED_BY_BLOCK },
        { kind: 'sleep', status: 'failed', error: JOB_KILLED_BY_BLOCK },
        { kind: 'sleep', status: 'queued', error: null },
      ]);
      await expectUntouched(other);
    });

    it('96а. ключ из жалобы приводится к нижнему регистру', async () => {
      // Жалоба приходит текстом от человека, и «Shop.C.Linkeon.io» в ней —
      // обычное дело. Приведение умеет превратить «не найдено» в «найдено
      // единственное верное» и не умеет превратить одно совпадение в другое:
      // слаги (SLUG_RE) и домены лежат в базе только строчными.
      const p = await product({ slug: 'ss-case', status: 'running' });

      const svc = blocks();
      quiet(svc);
      await svc.block('  SS-CASE.P.Linkeon.IO  ', 'нарушение');

      expect((await getProduct(p.id)).status).toBe('blocked');
    });

    it('97. не нашли — отказ, а не запасной поиск по другому полю', async () => {
      // ГЛАВНОЕ ПРАВИЛО РАЗБОРА. Слаг одного продукта совпадает с НАЧАЛОМ
      // домена другого ровно потому, что домен из слага и строится. Молчаливый
      // поиск «сначала по домену, потом по слагу» однажды погасил бы не тот
      // продукт — и узнали бы мы об этом от владельца.
      const victim = await product({ slug: 'ss-neighbour', status: 'running' });

      // Ключ с точкой — только домен. Такого домена нет, хотя слаг есть.
      await expect(blocks().block('ss-neighbour.example.org', 'проба')).rejects.toThrow(
        /не найден по домену/i,
      );
      // Ключ без точки — только слаг. Такого слага нет, хотя домен есть.
      await expect(blocks().block('ss-neighbourplinkeonio', 'проба')).rejects.toThrow(
        /не найден по слагу/i,
      );
      // И сосед цел: отказ ничего не тронул.
      expect((await getProduct(victim.id)).status).toBe('running');
    });

    it('97а. отказ по домену подсказывает, что у бота домена нет вовсе', async () => {
      // У бота `create()` домена не пишет, то есть бот по домену не находится
      // НИКОГДА и ни при какой опечатке. Администратор, не знающий этого,
      // будет перебирать написания домена, которого не существует.
      const bot = await product({ slug: 'ss-bot', kind: 'bot', status: 'running' });
      expect((await getProduct(bot.id)).domain).toBeNull();

      await expect(blocks().block('ss-bot.c.linkeon.io', 'проба')).rejects.toThrow(
        /у бота домена нет/i,
      );
      // А по слагу тот же бот гасится.
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-bot', 'нарушение');
      expect((await getProduct(bot.id)).status).toBe('blocked');
    });

    it('97б. пустой ключ и пустая причина отбиваются до всякого запроса', async () => {
      // Причина — ЕДИНСТВЕННОЕ, из чего владелец узнает, что случилось с его
      // продуктом: общего списка у администратора нет, уведомлений кусок 4б не
      // делает. Пустая строка дала бы погашенный продукт без единого слова.
      const p = await product({ slug: 'ss-empty', status: 'running' });

      await expect(blocks().block('   ', 'нарушение')).rejects.toThrow(/что гасить/i);
      await expect(blocks().block('ss-empty', '   ')).rejects.toThrow(/за что гасим/i);

      expect((await getProduct(p.id)).status).toBe('running');
      expect(await jobsOf(p.id)).toEqual([]);
    });

    it('97в. два продукта с одним доменом — отказ, и НИ ОДИН не тронут', async () => {
      // У products.slug есть UNIQUE, у products.id — первичный ключ, а у
      // products.domain НЕ ТО НИ ДРУГОЕ (проверено по всем семи миграциям).
      // Сегодня домены не повторяются, потому что строятся из уникального
      // слага, — но держится это на соглашении, а не на базе. Две строки с
      // одним доменом, и гашение по жалобе на один продукт погасило бы
      // заодно соседний.
      const a = await product({ slug: 'ss-dup-a', status: 'running' });
      const b = await product({ slug: 'ss-dup-b', status: 'running' });
      await pool.query(`UPDATE products SET domain = 'ss-dup.p.linkeon.io' WHERE id IN ($1,$2)`, [
        a.id,
        b.id,
      ]);

      await expect(blocks().block('ss-dup.p.linkeon.io', 'нарушение')).rejects.toThrow(
        /найден не один продукт/i,
      );

      for (const p of [a, b]) {
        const row = await getProduct(p.id);
        expect([row.status, row.block_reason]).toEqual(['running', null]);
        expect(await jobsOf(p.id)).toEqual([]);
      }
    });

    // ───────────────────────── механика гашения ─────────────────────────

    it('98. блокировка НЕ ждёт идущий ход и закрывает его причиной', async () => {
      // ЕДИНСТВЕННОЕ МЕСТО, ГДЕ БЛОКИРОВКА ВЕДЁТ СЕБЯ НЕ КАК СОН. Сон за
      // неуплату ждёт завершения хода: погашенный посреди правки контейнер
      // убивает её молча. Блокировку ставят, когда на домене недопустимое, и
      // тридцать минут ждать нельзя — идущий ход умирает, осознанный размен.
      //
      // Ход при этом ЗАКРЫВАЕТСЯ здесь же: оставленный в 'running', он висел бы
      // до срока сборщика зависших, всё это время владелец видел бы
      // «выполняется» у погашенного продукта, а замок product_turns_one_active
      // не пускал бы следующий ход.
      //
      // СВЕРКА С СОСЕДОМ обязательна: без неё сценарий зеленел бы и на
      // реализации, которая просто не умеет ждать ничего.
      const p = await product({ slug: 'ss-busy', status: 'running' });
      await turn(p.id, { status: 'running', progressAgo: '5 seconds' });

      const svc = blocks();
      quiet(svc);
      await svc.block('ss-busy', 'нарушение');

      expect((await getProduct(p.id)).status).toBe('blocked');
      expect(await turnsOf(p.id)).toEqual([{ status: 'failed', error: TURN_KILLED_BY_BLOCK }]);
      // Слово «администратор» в причине обязательное: без него владелец читает
      // обычный отказ раннера и идёт искать поломку у себя.
      expect((await turnsOf(p.id))[0].error).toMatch(/администратор/i);

      // Сон на том же живом ходе задание бы НЕ поставил.
      const sleeper = await due({ slug: 'ss-busy-sleeper', overdue: '1 day' });
      await turn(sleeper.id, { status: 'running', progressAgo: '5 seconds' });
      expect(await rent().requestSleep(sleeper.id)).toBe(false);
    });

    it('98а. ход, который раннер ещё не забрал, закрывается тоже', async () => {
      // 'queued' наравне с 'running': такой ход всё равно держит замок
      // product_turns_one_active и всё равно уехал бы в контейнер, если бы
      // гашение сорвалось. Отдельным сценарием, потому что отбор по одному
      // только 'running' читается совершенно так же.
      const p = await product({ slug: 'ss-queued-turn', status: 'running' });
      await turn(p.id, { status: 'queued', startedAgo: null, progressAgo: null });

      const svc = blocks();
      quiet(svc);
      await svc.block('ss-queued-turn', 'нарушение');

      expect((await turnsOf(p.id))[0].status).toBe('failed');
    });

    it('98б. чужие ходы и задания гашение не трогает', async () => {
      // Соединение без условия (`... OR TRUE`) регексп переживает, а одно
      // гашение похоронило бы ходы и задания всего реестра.
      const other = await product({ slug: 'ss-innocent', status: 'running' });
      await turn(other.id, { status: 'running', progressAgo: '5 seconds' });
      await job(other.id, { kind: 'wake', status: 'queued' });
      await product({ slug: 'ss-guilty', status: 'running' });

      const svc = blocks();
      quiet(svc);
      await svc.block('ss-guilty', 'нарушение');

      expect((await turnsOf(other.id))[0].status).toBe('running');
      expect(await jobRowsOf(other.id)).toEqual([{ kind: 'wake', status: 'queued', error: null }]);
      expect((await getProduct(other.id)).status).toBe('running');
    });

    it('99. блокировка снимает невыполненное пробуждение, а агенту достаётся ГАШЕНИЕ', async () => {
      // ПОРЯДОК, КОТОРЫЙ ЛОМАЕТ: продукт спал за неуплату, владелец пополнил,
      // будильник поставил 'wake' — и в этот момент администратор гасит.
      //
      // ПРОВЕРЯЕТСЯ ИМЕННО ВЫДАЧА, а не отсутствие выдачи. Прежняя редакция
      // этого сценария требовала `expect(await makeSvc().claimJob('own'))
      // .toBeNull()` и была зелёной РОВНО при сломанной реализации, где
      // claimJob не отдаёт блокированному ничего: и пробуждение не уезжает, и
      // гашение тоже — контейнер работает, домен отдаёт то, за что погасили, а
      // через десять минут сборщик зависших закрывает задание чужой
      // формулировкой про срок заведения.
      //
      // Заодно сторож частичного уникального индекса: снять старое задание и
      // поставить новое ОДНОЙ командой — не то же самое, что поставить. Части
      // WITH исполняются «одновременно», и вставка, исполненная раньше снятия,
      // падает с 23505 (измерено на PostgreSQL 16). Порядок закреплён ссылкой
      // на killed_jobs; сними её — этот сценарий краснеет.
      const p = await product({ slug: 'ss-waking', status: 'sleeping' });
      await job(p.id, { kind: 'wake', status: 'queued' });

      const svc = blocks();
      quiet(svc);
      await svc.block('ss-waking', 'нарушение');

      expect(await jobRowsOf(p.id)).toEqual([
        { kind: 'wake', status: 'failed', error: JOB_KILLED_BY_BLOCK },
        { kind: 'sleep', status: 'queued', error: null },
      ]);

      const taken = await makeSvc().claimJob('own');
      expect([taken?.jobKind, taken?.slug]).toEqual(['sleep', 'ss-waking']);
      // Токен раннера на гашении не выпускается — контейнер уже собран.
      expect(taken!.runnerToken).toBeUndefined();
    });

    it('99а. пробуждение БЛОКИРОВАННОМУ не выдаётся, даже если задание уцелело', async () => {
      // ВТОРОЙ РУБЕЖ, а не дубль сценария 99. Снятие пробуждения в block() —
      // одно место, и оно перестанет работать молча. Соблазнительная редакция
      // чужого условия — расширить ОБЩУЮ ветку выдачи до
      // `p.status IN ('sleeping','blocked')` — делает то снятие ЕДИНСТВЕННЫМ,
      // что стоит между решением администратора и агентом, который поднимет
      // контейнер обратно через секунды.
      const p = await product({ slug: 'ss-blocked-wake', status: 'running' });
      await pool.query(`UPDATE products SET status = 'blocked' WHERE id = $1`, [p.id]);
      await job(p.id, { kind: 'wake', status: 'queued' });

      expect(await makeSvc().claimJob('own')).toBeNull();
      // Задание осталось в очереди — его не забрали и не «выбросили».
      expect(await jobsOf(p.id)).toEqual(['queued']);
    });

    it('99б. гашение блокированного повторяется, а не падает на индексе', async () => {
      // ЕДИНСТВЕННЫЙ ПУТЬ ПОЧИНКИ. Гашение может оставить продукт в 'blocked'
      // без задания — ровно об этом громкий отказ в block(). Лечится повтором
      // того же действия, и значит повтор обязан работать НА БЛОКИРОВАННОМ, у
      // которого уже висит собственное задание на гашение.
      const p = await product({ slug: 'ss-again', status: 'running' });
      const svc = blocks();
      quiet(svc);

      await svc.block('ss-again', 'первая причина');
      await svc.block('ss-again', 'вторая причина');

      const row = await getProduct(p.id);
      expect([row.status, row.block_reason]).toEqual(['blocked', 'вторая причина']);
      expect(await jobRowsOf(p.id)).toEqual([
        { kind: 'sleep', status: 'failed', error: JOB_KILLED_BY_BLOCK },
        { kind: 'sleep', status: 'queued', error: null },
      ]);
    });

    it('99в. причина сна переживает гашение', async () => {
      // Продукт спал за неуплату до блокировки. Стёртая причина оставила бы
      // владельца со спящим продуктом без объяснения — после снятия
      // блокировки, которое возвращает его ровно в 'sleeping'.
      const p = await product({ slug: 'ss-keep-reason', status: 'sleeping' });
      await pool.query(`UPDATE products SET sleep_reason = 'нет токенов' WHERE id = $1`, [p.id]);

      const svc = blocks();
      quiet(svc);
      await svc.block('ss-keep-reason', 'нарушение');

      const row = await getProduct(p.id);
      expect([row.status, row.sleep_reason, row.block_reason]).toEqual([
        'blocked',
        'нет токенов',
        'нарушение',
      ]);
    });

    it('100. гашение АРХИВНОГО — отказ своим текстом, и продукт не тронут', async () => {
      // ГАСИТЬ АРХИВНЫЙ НЕЛЬЗЯ НЕ ИЗ АККУРАТНОСТИ. claimJob выдаёт задания
      // только по `archived_at IS NULL`: задание на гашение архивного не
      // досталось бы агенту НИКОГДА и навсегда заняло бы one_active — сборщик
      // зависших разбирает только продукты в 'provisioning'. Плюс статус
      // 'archived' был бы затёрт на 'blocked'.
      //
      // И ОТКАЗ ИМЕННО СВОЙ, а не «не найден»: `archived_at IS NULL`,
      // поставленный в ПОИСК, превратил бы архивный продукт в ненайденный, и
      // администратор пошёл бы искать опечатку в домене, которого нет.
      const p = await product({ slug: 'ss-archived', status: 'archived' });
      await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [p.id]);
      const before = await getProduct(p.id);

      await expect(blocks().block('ss-archived', 'нарушение')).rejects.toThrow(/в архиве/i);
      await expect(blocks().block('ss-archived', 'нарушение')).rejects.not.toThrow(/не найден/i);

      expect(await getProduct(p.id)).toEqual(before);
      expect(await jobsOf(p.id)).toEqual([]);
    });

    // ───────────────────────── снятие блокировки ─────────────────────────

    it('101. снятие возвращает в sleeping и ставит пробуждение — но НЕ в running', async () => {
      // 'running' здесь ставить нельзя: перевод в работу делает promoteReady по
      // измеримому факту (раннер на связи и публичный адрес отдал 200).
      // Объявленный рабочим продукт, контейнер которого ещё не начали
      // поднимать, начал бы принимать ходы и платить аренду.
      const other = await bystander();
      const p = await product({ slug: 'ss-unblock', status: 'running' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-unblock', 'нарушение');

      await svc.unblock('ss-unblock');

      const row = await getProduct(p.id);
      expect([row.status, row.block_reason]).toEqual(['sleeping', null]);
      expect(await jobRowsOf(p.id)).toEqual([
        { kind: 'sleep', status: 'failed', error: JOB_KILLED_BY_UNBLOCK },
        { kind: 'wake', status: 'queued', error: null },
      ]);
      await expectUntouched(other);
    });

    it('101а. снятие снимает невыполненное ГАШЕНИЕ — иначе агент погасит следом', async () => {
      // У блокированного продукта штатно висит НАШЕ ЖЕ задание на гашение —
      // агент мог до него не дойти. Оставь его, и пробуждение по частичному
      // уникальному индексу не встанет вовсе, продукт уедет в 'sleeping', а
      // агент заберёт старое 'sleep' и погасит контейнер. Снятие блокировки
      // выглядело бы сработавшим и не делало бы ничего.
      await product({ slug: 'ss-unblock-race', status: 'running' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-unblock-race', 'нарушение');
      await svc.unblock('ss-unblock-race');

      const taken = await makeSvc().claimJob('own');

      expect([taken?.jobKind, taken?.slug]).toEqual(['wake', 'ss-unblock-race']);
      // И второго задания в очереди нет: старое гашение снято, а не отложено.
      expect(await makeSvc().claimJob('own')).toBeNull();
    });

    it('101б. разбуженный снятием доезжает до running обычным путём', async () => {
      // Путь отсюда до 'running' уже существует и проверен куском 3. Сторож
      // стыка: promoteReady переводит разбуженного по ПОСЛЕДНЕМУ заданию
      // (kind='wake' и status='done'), и снятое гашение, оставшееся последним,
      // этот перевод сорвало бы.
      const p = await product({ slug: 'ss-unblock-run', status: 'running', seenAgo: '5 seconds' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-unblock-run', 'нарушение');
      await svc.unblock('ss-unblock-run');

      const prov = makeSvc();
      const taken = await prov.claimJob('own');
      await prov.completeJob(taken!.jobId, { ok: true });
      await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [p.id]);

      expect(await prov.promoteReady()).toBe(1);
      expect((await getProduct(p.id)).status).toBe('running');
    });

    it('101в. снятие с НЕ блокированного — свой отказ, а не «не найден»', async () => {
      // Продукт есть, ключ верный. «Не найден» отправил бы администратора
      // искать опечатку там, где её нет, а настоящая причина — «кто-то уже
      // снял» или «погасить так и не вышло» — осталась бы неназванной.
      const p = await product({ slug: 'ss-not-blocked', status: 'running' });

      await expect(blocks().unblock('ss-not-blocked')).rejects.toThrow(/не блокирован/i);

      expect((await getProduct(p.id)).status).toBe('running');
      expect(await jobsOf(p.id)).toEqual([]);
    });

    it('101г. снятия по несуществующему ключу и с архивного — свои отказы', async () => {
      const p = await product({ slug: 'ss-unblock-arch', status: 'blocked' });
      await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [p.id]);
      const before = await getProduct(p.id);

      await expect(blocks().unblock('неттакого')).rejects.toThrow(/не найден по слагу/i);
      await expect(blocks().unblock('ss-unblock-arch')).rejects.toThrow(/в архиве/i);

      expect(await getProduct(p.id)).toEqual(before);
    });

    // ───────── чужое место: отказ сна не снимает блокировку ─────────

    it('103. отказ гашения ОСТАВЛЯЕТ продукт блокированным', async () => {
      // ЧУЖОЕ МЕСТО, БЕЗ КОТОРОГО ГАШЕНИЕ ОТМЕНЯЕТСЯ СОБСТВЕННЫМ СБОЕМ.
      // completeJob переводил продукт по ВИДУ задания (`WHEN 'sleep' THEN
      // 'degraded'`), не глядя на его нынешний статус. Гашение ставит задание
      // того же вида — значит любой сорвавшийся docker stop возвращал бы
      // блокированный продукт в 'degraded', то есть в статус, который ПЛАТИТ
      // АРЕНДУ и ПРИНИМАЕТ ПРАВКИ. Решение администратора снималось бы молча.
      const p = await product({ slug: 'ss-fail-sleep', status: 'sleeping' });
      await pool.query(`UPDATE products SET sleep_reason = 'нет токенов' WHERE id = $1`, [p.id]);
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-fail-sleep', 'нарушение');
      const taken = await makeSvc().claimJob('own');

      await makeSvc().completeJob(taken!.jobId, { ok: false, error: 'docker stop не отработал' });

      const row = await getProduct(p.id);
      expect(row.status).toBe('blocked');
      expect(row.block_reason).toBe('нарушение');
      // И причина сна цела: обнуление тоже сидело в ветке 'sleep'.
      expect(row.sleep_reason).toBe('нет токенов');
      // Причина отказа видна — иначе разбираться было бы не по чему.
      expect(row.provision_error).toBe('docker stop не отработал');
    });

    it('103а. отказ сна у НЕ блокированного по-прежнему даёт degraded', async () => {
      // Обратная половина: исключение для блокированного не должно съесть
      // старое поведение. Без этого сценария мутация «всегда оставлять статус»
      // прошла бы зелёной здесь и покраснела бы только в куске 3.
      const p = await product({ slug: 'ss-fail-plain', status: 'sleeping' });
      await pool.query(`UPDATE products SET sleep_reason = 'нет токенов' WHERE id = $1`, [p.id]);
      const j = await job(p.id, { kind: 'sleep', status: 'running' });

      await makeSvc().completeJob(j, { ok: false, error: 'docker stop не отработал' });

      const row = await getProduct(p.id);
      expect([row.status, row.sleep_reason]).toEqual(['degraded', null]);
    });

    it('103б. удачное гашение оставляет продукт блокированным', async () => {
      // Отчёт об успехе статуса не трогает вовсе — и это ровно то, что нужно:
      // promoteReady блокированных не выбирает, так что 'blocked' стоит до
      // решения администратора.
      const p = await product({ slug: 'ss-ok-sleep', status: 'running', seenAgo: '5 seconds' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-ok-sleep', 'нарушение');
      const prov = makeSvc();
      const taken = await prov.claimJob('own');

      await prov.completeJob(taken!.jobId, { ok: true });

      expect((await getProduct(p.id)).status).toBe('blocked');
      // И сборщик перевода в работу его не подберёт даже при живом раннере.
      await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [p.id]);
      expect(await prov.promoteReady()).toBe(0);
      expect((await getProduct(p.id)).status).toBe('blocked');
    });

    // ───────── чужое место: отказ правке блокированного ─────────

    /**
     * Настоящий TurnsService поверх той же базы. Баланс подменён нарочно
     * «денег хватает»: проверка баланса стоит ПОСЛЕ проверки статуса, и
     * честный нулевой баланс отдавал бы здесь свой отказ независимо от того,
     * работает проверка блокировки или нет.
     */
    const turnsSvc = () =>
      new TurnsService(pg as any, { checkTokenBalance: async () => ({ ok: true }) } as any);

    it('104. после гашения правка владельца отбивается текстом ПРО АДМИНИСТРАТОРА', async () => {
      // ДВЕ ПОЛОВИНЫ ОТКАЗА ЖИВУТ В РАЗНЫХ ФАЙЛАХ и связаны одним строковым
      // литералом: block() пишет в products.status слово 'blocked', а
      // TurnsService.enqueue сверяет прочитанное с ним же. На заглушке pg эта
      // связь не проверяется ВОВСЕ — юнит-тест сам кладёт статус в ответ мока,
      // — и расхождение вида 'blocked_by_admin' осталось бы зелёным по обе
      // стороны. Владелец при этом получал бы общее «Продукт сейчас недоступен
      // для правок» и шёл искать поломку у себя.
      const p = await product({ slug: 'ss-refuse', status: 'running' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-refuse', 'нарушение');

      const err: any = await turnsSvc()
        .enqueue({ productId: p.id, userId: 'u-1', channel: 'web', prompt: 'правь' })
        .catch((e) => e);

      expect(err.message).toBe(BLOCKED_REFUSAL);
      expect(err.getStatus()).toBe(409);
      // И ход в очередь не встал. Встав, он висел бы там навсегда: claimNext
      // требует 'running', сборщик зависших хоронит только 'running', а замок
      // product_turns_one_active не пустил бы следующий.
      expect(await turnsOf(p.id)).toEqual([]);
    });

    it('104а. после снятия блокировки отказ снова про ДЕНЬГИ, а не про администратора', async () => {
      // Обратная половина, и заодно сторож того, что снятие меняет СТАТУС, а
      // не только стирает причину. Продукт возвращается в 'sleeping' (почему
      // не сразу в 'running' — в докблоке unblock), значит владелец обязан
      // получить отказ про баланс: «остановлен администратором» здесь уже
      // неправда, и владелец ждал бы решения, которое давно принято.
      const p = await product({ slug: 'ss-refuse-back', status: 'running' });
      const svc = blocks();
      quiet(svc);
      await svc.block('ss-refuse-back', 'нарушение');
      await svc.unblock('ss-refuse-back');

      const err: any = await turnsSvc()
        .enqueue({ productId: p.id, userId: 'u-1', channel: 'web', prompt: 'правь' })
        .catch((e) => e);

      expect(err.message).toBe(SLEEPING_REFUSAL);
      expect(err.getStatus()).toBe(402);
    });
  });

  // ═════════════════════ реестр машин (миграция 005) ═════════════════════

  describe('реестр машин', () => {
    /**
     * Накатить схему ТЕМ ЖЕ кодом, которым её накатывает прод, — а не «прочитать
     * файл и выполнить». Половина 005 живёт именно в ProductsService: параметр
     * сессии с хешем токена, выделенное соединение и явная транзакция. Накатка
     * файла через пул этой половины не воспроизводит вовсе — и проходила бы
     * зелёной ровно в том случае, ради которого всё и написано.
     *
     * Ошибки логгера глушатся: отказ 005 здесь ожидаемый результат сценария, а
     * не поломка прогона.
     */
    const migrate = async (token: string | null) => {
      const before = process.env.PRODUCT_HOST_TOKEN;
      if (token === null) delete process.env.PRODUCT_HOST_TOKEN;
      else process.env.PRODUCT_HOST_TOKEN = token;
      const svc = new ProductsService({
        query: (sql: string, params?: any[]) => pool.query(sql, params),
        getClient: () => pool.connect(),
      } as any);
      jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
      try {
        return await svc.onModuleInit();
      } finally {
        if (before === undefined) delete process.env.PRODUCT_HOST_TOKEN;
        else process.env.PRODUCT_HOST_TOKEN = before;
      }
    };

    /** Токен машины. Неоднородный: на 'a'.repeat(n) выживает половина мутаций хеша. */
    const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

    it('40. машина own заводится ХЕШЕМ токена из окружения, продукт получает метку', async () => {
      const mine = await product({ slug: 'mh-existing', host: null });
      const gone = await product({ slug: 'mh-gone', host: null });
      await pool.query(`UPDATE products SET host_ip = '139.59.210.42' WHERE id = $1`, [mine.id]);
      await pool.query(
        `UPDATE products SET host_ip = '10.0.0.99', archived_at = now() WHERE id = $1`,
        [gone.id],
      );

      await migrate(TOKEN);

      expect(await hosts()).toEqual([
        {
          id: 'own',
          ssh_target: 'root@139.59.210.42',
          public_ip: '139.59.210.42',
          domain_suffix: 'p.linkeon.io',
          agent_token_hash: sha(TOKEN),
          capacity: 20,
          accepts_new: true,
          audience: 'own',
          created_at: expect.any(Date),
        },
      ]);
      expect((await getProduct(mine.id)).host_id).toBe('own');
      // Архивный с чужим адресом метки не получает и накатку не роняет.
      expect((await getProduct(gone.id)).host_id).toBeNull();
    });

    it('40а. в реестре лежит ХЕШ, а токена нет ни в каком виде', async () => {
      // Открытый токен в базе означал бы, что её дамп даёт право заводить
      // продукты на любой машине. Тот же приём, что у runner-токена продукта.
      await migrate(TOKEN);

      const [row] = await hosts();
      expect(row.agent_token_hash).toBe(sha(TOKEN));
      expect(JSON.stringify(row)).not.toContain(TOKEN);
    });

    it('40б. параметр сессии ДОЕЗЖАЕТ до файла: хеш не от пустой строки', async () => {
      // Главная ловушка задачи. set_config(..., true) через пул живёт до конца
      // своего запроса, и следующий читает ПУСТУЮ СТРОКУ, а не ошибку: миграция
      // применилась бы успешно, записав sha256(''), и агент с настоящим токеном
      // молча перестал бы получать работу. Измерено на PostgreSQL 16.14.
      await migrate(TOKEN);

      const [row] = await hosts();
      expect(row.agent_token_hash).not.toBe(sha(''));
    });

    it('40в. без PRODUCT_HOST_TOKEN машина не заводится вовсе', async () => {
      // Не заводится — лучше, чем заводится с хешем пустой строки: такую машину
      // не узнает ни один агент, а отличить её от настоящей в реестре нельзя.
      await migrate(null);

      expect(await hosts()).toEqual([]);
    });

    it('41. несопоставленный ЖИВОЙ продукт РОНЯЕТ накатку, а не получает метку по умолчанию', async () => {
      // Продукт с чужой меткой получает задания на машину, где его каталога
      // нет: заведение начнётся заново поверх пустого места. Отказ — громкий, и
      // он роняет старт API: 005 объявлена обязательной.
      const p = await product({ slug: 'mh-orphan', host: null });
      await pool.query(`UPDATE products SET host_ip = '10.0.0.99' WHERE id = $1`, [p.id]);

      await expect(migrate(TOKEN)).rejects.toThrow(/не сошёлся/);

      expect((await getProduct(p.id)).host_id).toBeNull();
      // Откат ПОЛНЫЙ: отказ не оставляет половину миграции — машины own в
      // реестре нет, хотя её вставка стоит в файле выше проверки.
      expect(await hosts()).toEqual([]);
    });

    it('41а. продукт БЕЗ адреса роняет накатку так же: пустой host_ip — не «любая машина»', async () => {
      // Фикстура host_ip не заполняет вовсе — ровно как строка, заведённая до
      // появления колонки. NULL не равен ничему, в том числе адресу машины.
      await product({ slug: 'mh-noip', host: null });

      await expect(migrate(TOKEN)).rejects.toThrow(/mh-noip \(host_ip пуст\)/);
    });

    it('41б. отказ называет ВСЕ несопоставленные продукты поимённо и адресом без маски', async () => {
      // Счётчик «у N продуктов» отправляет оператора искать их запросом. Имена
      // в сообщении — это разница между «понял за минуту» и «полез в базу».
      // Адрес печатается host(), а не ::text: inet печатает себя с маской, и
      // «10.0.0.98/32» оператор не найдёт ни в одном конфиге.
      const a = await product({ slug: 'mh-o1', host: null });
      const b = await product({ slug: 'mh-o2', host: null });
      await pool.query(`UPDATE products SET host_ip = '10.0.0.98' WHERE id = ANY($1)`, [[a.id, b.id]]);

      await expect(migrate(TOKEN)).rejects.toThrow(
        /mh-o1 \(host_ip 10\.0\.0\.98\), mh-o2 \(host_ip 10\.0\.0\.98\)$/,
      );
    });

    it('41в. архивный несопоставленный накатку не роняет', async () => {
      // Архивный продукт не получает заданий никогда — сопоставлять его не с
      // чем и незачем.
      const p = await product({ slug: 'mh-archived', host: null });
      await pool.query(
        `UPDATE products SET host_ip = '10.0.0.99', archived_at = now() WHERE id = $1`,
        [p.id],
      );

      await expect(migrate(TOKEN)).resolves.toBeUndefined();

      expect((await getProduct(p.id)).host_id).toBeNull();
    });

    it('42. повторная накатка ничего не меняет', async () => {
      // Модуль накатывает ВЕСЬ список при каждом старте API, то есть при каждом
      // pm2 restart.
      const p = await product({ slug: 'mh-twice', host: null });
      await pool.query(`UPDATE products SET host_ip = '139.59.210.42' WHERE id = $1`, [p.id]);
      await migrate(TOKEN);
      const hostsBefore = await hosts();
      const productBefore = await getProduct(p.id);
      expect(hostsBefore).toHaveLength(1);

      await migrate(TOKEN);
      await migrate(TOKEN);

      expect(await hosts()).toEqual(hostsBefore);
      expect(await getProduct(p.id)).toEqual(productBefore);
    });

    it('42а. заведённую машину миграция НЕ переписывает: источник правды — реестр, а не окружение', async () => {
      // После выката PRODUCT_HOST_TOKEN из окружения бэкенда удаляется:
      // оставленный, он был бы вторым способом пройти гвард. Значит и поворот
      // токена делается правкой реестра, а не правкой .env — иначе выходило бы
      // два источника правды, расходящихся молча.
      await migrate(TOKEN);

      await migrate('b'.repeat(64));

      expect((await hosts())[0].agent_token_hash).toBe(sha(TOKEN));
    });

    it('43. потолок обязан быть положительным', async () => {
      // Нулевой потолок — это машина, на которую ничего не заведёшь, и отказ
      // «мест нет» вместо внятной ошибки конфигурации.
      await expect(addHost({ id: 'zero', capacity: 0 })).rejects.toThrow(/capacity/);
    });

    it('44. двух машин с одним адресом не бывает', async () => {
      // Сопоставление продуктов — это UPDATE ... FROM, то есть соединение. Две
      // машины с одним адресом дали бы продукту метку ОДНОЙ ИЗ НИХ наугад: без
      // ошибки, без строки в логе и без способа заметить.
      await addHost({ id: 'a', ip: '10.0.0.5' });

      await expect(addHost({ id: 'b', ip: '10.0.0.5' })).rejects.toThrow(/public_ip/);
    });

    it('44а. двух машин с одним хешем токена не бывает', async () => {
      // Гвард берёт машину по хешу без ORDER BY — как RunnerGuard берёт продукт
      // по runner_token_hash. Без уникальности совпадение отдаёт произвольную
      // машину, то есть чужие задания.
      await addHost({ id: 'a', hash: 'h-один' });

      await expect(addHost({ id: 'b', hash: 'h-один' })).rejects.toThrow(/agent_token_hash/);
    });

    it('44б. аудитория закрыта словарём', async () => {
      await expect(addHost({ id: 'x', audience: 'всякие' })).rejects.toThrow(/audience/);
    });

    it('44в. машину нельзя снести из-под её продуктов', async () => {
      // ON DELETE SET NULL означал бы продукты без машины, молча выпавшие из
      // выдачи заданий; CASCADE — снос реестра продуктов вместе со строкой
      // машины.
      await addHost({ id: 'a', ip: '10.0.0.5' });
      const p = await product({ slug: 'mh-fk', host: null });
      await pool.query(`UPDATE products SET host_id = 'a' WHERE id = $1`, [p.id]);

      await expect(pool.query(`DELETE FROM product_hosts WHERE id = 'a'`)).rejects.toThrow(/host_id/);
    });

    // ───────────────────── гвард агента (задача 2) ─────────────────────

    describe('гвард агента', () => {
      /**
       * Гвард против ЖИВОЙ базы, а не против заглушки. Заглушка в
       * host.guard.spec.ts SQL не исполняет: опечатка в имени колонки,
       * скалярный подзапрос вместо соединения, `count(*)`, приезжающий строкой,
       * — всё это проходит там зелёным. Здесь запрос исполняет PostgreSQL.
       */
      const guard = () => new HostGuard(pg as any);
      const ctx = (req: unknown) => ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;
      const asks = (token: string): any => ({ headers: { authorization: `Bearer ${token}` } });

      /**
       * Токены машин. Берутся как sha256 от строки — не ради криптографии, а
       * ради ФОРМЫ: ровно 64 печатных ASCII-символа, то есть в точности то, что
       * даёт `openssl rand -hex 32` и что гвард обязан принять. Кириллическую
       * строку он отобьёт по форме, и весь набор стал бы проверять не то.
       */
      const OWN_TOKEN = sha('машина владельца');
      const CLIENTS_TOKEN = sha('машина клиентов');

      let logged: string[];

      beforeEach(() => {
        logged = [];
        const collect = (m: any) => {
          logged.push(String(m));
        };
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(collect);
        jest.spyOn(Logger.prototype, 'error').mockImplementation(collect);
      });

      afterEach(() => jest.restoreAllMocks());

      it('45. токен превращается в метку ТОЙ машины, которой он выдан', async () => {
        // Ради этого написан весь кусок: сегодня токен один на всех, и задание
        // достаётся тому, кто первым спросил.
        expect(OWN_TOKEN).toMatch(/^[0-9a-f]{64}$/);
        await addHost({ id: 'own', hash: sha(OWN_TOKEN), ip: '139.59.210.42', audience: 'own' });
        await addHost({ id: 'clients', hash: sha(CLIENTS_TOKEN) });
        const mine = asks(OWN_TOKEN);
        const theirs = asks(CLIENTS_TOKEN);

        await expect(guard().canActivate(ctx(mine))).resolves.toBe(true);
        await expect(guard().canActivate(ctx(theirs))).resolves.toBe(true);

        expect(mine.hostId).toBe('own');
        expect(theirs.hostId).toBe('clients');
      });

      it('45а. хеш гварда сходится с хешем, который положила в реестр миграция', async () => {
        // СТЫК ДВУХ ЗАДАЧ, и разойтись ему проще всего. Хеш машины own считает
        // Node в products.service (pgcrypto на проде нет), а сверяет его гвард —
        // другим вызовом в другом файле. Разная кодировка (utf8 против latin1),
        // разный регистр hex, лишний trim — и реестр правильный, гвард
        // исправный, а машина владельца молча не получает ни одного задания.
        await migrate(TOKEN);
        const req = asks(TOKEN);

        await expect(guard().canActivate(ctx(req))).resolves.toBe(true);

        expect(req.hostId).toBe('own');
      });

      it('45б. чужой токен — отказ, метки нет, в журнале строка', async () => {
        // Строка обязательна: снаружи такой агент выглядит исправным — юнит
        // active, перезапусков нет, ошибок нет (сценарий 21д).
        await addHost({ id: 'own', hash: sha(OWN_TOKEN), audience: 'own' });
        const req = asks(CLIENTS_TOKEN);

        await expect(guard().canActivate(ctx(req))).rejects.toThrow(UnauthorizedException);

        expect(req.hostId).toBeUndefined();
        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(/неизвестн/i);
        expect(logged[0]).not.toContain(CLIENTS_TOKEN);
      });

      it('45в. пустой реестр докладывает о себе отдельно: счётчик едет из базы СТРОКОЙ', async () => {
        // count(*) приезжает из node-pg строкой — bigint не влезает в number.
        // Сравнение `total === 0` было бы ложным всегда, и пустой реестр
        // выглядел бы как чужой токен: оператор ушёл бы чинить конфиг машины,
        // который в порядке. Состояние достижимое — см. 40в.
        expect(await hosts()).toEqual([]);

        await expect(guard().canActivate(ctx(asks(OWN_TOKEN)))).rejects.toThrow(
          /host registry not configured/,
        );

        expect(logged).toHaveLength(1);
        expect(logged[0]).toMatch(/реестр машин пуст/);
      });

      it('45г. машина, закрытая для НОВЫХ продуктов, свои задания забирать не перестаёт', async () => {
        // accepts_new — про размещение нового продукта, а не про вход. Машина,
        // выведенная из набора под новые, продолжает обслуживать уже стоящие на
        // ней: их надо будить, усыплять и править. Гвард, дописавший себе
        // `AND accepts_new`, остановил бы это молча — и заметили бы по
        // недосчитанной выручке.
        await addHost({ id: 'full', hash: sha(OWN_TOKEN), acceptsNew: false });
        const req = asks(OWN_TOKEN);

        await expect(guard().canActivate(ctx(req))).resolves.toBe(true);

        expect(req.hostId).toBe('full');
      });
    });

    // ──────────────── выдача заданий по метке (задача 3) ────────────────

    /**
     * ГЛАВНОЕ МЕСТО КУСКА. До этой задачи `claimJob()` не знала о машинах и
     * отдавала ЛЮБОЕ задание ЛЮБОМУ спросившему: с двумя машинами продукт
     * клиента развернулся бы у владельца, где его каталога нет, — заведение
     * началось бы заново поверх пустого места.
     *
     * ПОЧЕМУ ЭТО ПРОВЕРЯЕТСЯ ТОЛЬКО ЗДЕСЬ. Фильтр — одна строка внутри EXISTS,
     * и мок её не исполняет: на заглушке зелены и «ищет по метке», и
     * «фильтрует», даже если реализация на параметр не смотрит. Сторожа формы в
     * provisioning.job.spec.ts ловят ровно текст ($2 на месте, условие не
     * внутри CASE) — поведение ловится здесь.
     *
     * ЧЕРЕДОВАНИЕ ВОЗРАСТА НАМЕРЕННОЕ: чужое задание везде СТАРШЕ своего.
     * Очередь разбирается с головы (`ORDER BY j.created_at ASC`), поэтому без
     * фильтра агент взял бы именно чужое — детерминированно, а не по исходу
     * гонки. Одновременный вариант (46д) на снятом фильтре — подбрасывание
     * монеты, и держать главный сценарий на нём нельзя.
     */
    describe('выдача заданий по метке', () => {
      it('46. агент берёт СВОЁ задание, чужое остаётся в очереди — и наоборот', async () => {
        const theirs = await product({ slug: 'mh-cli', host: 'clients' });
        const mine = await product({ slug: 'mh-own', host: 'own' });
        // Чужое задание СТАРШЕ: без фильтра именно оно стоит в голове очереди.
        const jt = await job(theirs.id, { createdAgo: '3 minutes' });
        const jm = await job(mine.id, { createdAgo: '1 minute' });

        const claimed = await makeSvc().claimJob('own');

        expect([claimed!.slug, claimed!.jobId]).toEqual(['mh-own', jm]);
        expect((await getJob(jt)).status).toBe('queued');

        // И в обратную сторону: агент клиентов получает своё, а не остатки.
        // Без этой половины зелёной прошла бы выдача, прибитая к 'own'.
        const second = await makeSvc().claimJob('clients');
        expect([second!.slug, second!.jobId]).toEqual(['mh-cli', jt]);
      });

      it('46а. своих заданий нет, чужие есть — это ПУСТАЯ ОЧЕРЕДЬ, а не ошибка и не чужое задание', async () => {
        // Пустая очередь — штатное состояние: агент опрашивает нас в цикле, и
        // заданий соседа в общей очереди как раз большинство. Отказ здесь
        // сделал бы нормальную работу двух машин потоком ошибок у обеих.
        const theirs = await product({ slug: 'mh-only-cli', host: 'clients' });
        const jt = await job(theirs.id);
        const before = await getProduct(theirs.id);

        expect(await makeSvc().claimJob('own')).toBeNull();

        // Задание не тронуто ВООБЩЕ: не «захвачено и отброшено». Фильтр,
        // наложенный поверх отбора (на claimed или на итоговый SELECT), увёл бы
        // чужое задание в 'running' и не отдал бы его никому — потеря тихая, с
        // одним лишь начатым временем в колонке.
        expect(await jobsOf(theirs.id)).toEqual(['queued']);
        expect((await getJob(jt)).started_at).toBeNull();
        // И продукт целиком, а не три интересные колонки: CTE issued не должен
        // был повернуть чужому продукту runner-токен.
        expect(await getProduct(theirs.id)).toEqual(before);

        // Своему агенту задание достаётся по-прежнему: один только запрет был
        // бы зелен и у выдачи, которая не отдаёт ничего никому.
        expect((await makeSvc().claimJob('clients'))!.jobId).toBe(jt);
      });

      it('46б. задание, поставленное ДО выката, находит машину ЧЕРЕЗ ПРОДУКТ', async () => {
        // У задания метки нет и не нужно: колонки машины у
        // product_provision_jobs не появилось. Метку продукту проставила 005
        // сопоставлением по адресу — то есть старая очередь переживает выкат
        // без правки данных.
        const old = await product({ slug: 'mh-legacy', host: null });
        await pool.query(`UPDATE products SET host_ip = '139.59.210.42' WHERE id = $1`, [old.id]);
        const j = await job(old.id, { createdAgo: '1 hour' });
        await addHost({ id: 'clients' });

        await migrate(TOKEN);

        expect((await getProduct(old.id)).host_id).toBe('own');
        expect(Object.keys(await getJob(j))).not.toContain('host_id');
        expect(await makeSvc().claimJob('clients')).toBeNull();
        expect((await makeSvc().claimJob('own'))!.jobId).toBe(j);
      });

      it('46в. фильтр действует ОДИНАКОВО на заведение, сон и пробуждение', async () => {
        // Условие, уехавшее в ветку CASE `WHEN 'provision'`, проходит 46 и 46а
        // зелёным: заведение фильтруется, а сон и пробуждение уезжают на чужую
        // машину. Там сон гасит контейнер, которого нет, отчитывается отказом —
        // и продукт остаётся работать неоплаченным, что видно только по
        // недосчитанной выручке.
        for (const [kind, status] of [
          ['provision', 'provisioning'],
          ['sleep', 'sleeping'],
          ['wake', 'sleeping'],
        ] as const) {
          await pool.query('TRUNCATE products, product_provision_jobs CASCADE');
          const theirs = await product({ slug: `mh-${kind}-cli`, status, host: 'clients' });
          const jt = await job(theirs.id, { kind, createdAgo: '3 minutes' });

          expect(await makeSvc().claimJob('own')).toBeNull();
          expect((await getJob(jt)).status).toBe('queued');

          // И своё того же вида по-прежнему выдаётся: запрет без разрешения
          // зеленеет и на выдаче, которая сломалась целиком.
          const mine = await product({ slug: `mh-${kind}-own`, status, host: 'own' });
          const jm = await job(mine.id, { kind, createdAgo: '1 minute' });

          const claimed = await makeSvc().claimJob('own');

          expect([claimed!.jobKind, claimed!.jobId]).toEqual([kind, jm]);
        }
      });

      it('46г. продукт БЕЗ метки не достаётся никому — и это не «любая машина»', async () => {
        // NULL не равен ничему, в том числе метке машины. Мягкое сравнение
        // (`IS NOT DISTINCT FROM`, `COALESCE(p.host_id, $2)`) раздало бы такой
        // продукт всем сразу.
        //
        // Состояние сегодня ДОСТИЖИМОЕ: create() метку ещё не ставит — это
        // задача 4. До неё каждый заведённый продукт попадает именно сюда:
        // задание висит в очереди, через десять минут его хоронит сборщик
        // зависших, и владелец читает про истёкший срок. 005 такой продукт
        // роняет накаткой (41), то есть на проде он не переживёт рестарта, — но
        // заметить его до рестарта нечем.
        const orphan = await product({ slug: 'mh-unlabeled', host: null });
        await job(orphan.id);
        await addHost({ id: 'clients' });

        for (const hostId of ['own', 'clients', 'третья']) {
          expect(await makeSvc().claimJob(hostId)).toBeNull();
        }

        expect(await jobsOf(orphan.id)).toEqual(['queued']);
      });

      it('46д. два агента спрашивают ОДНОВРЕМЕННО — каждый уносит своё', async () => {
        // На одном соединении одновременность выродилась бы в очередь, поэтому
        // строго на пуле (pg здесь — Pool, см. шапку файла).
        //
        // ЧТО ЭТОТ СЦЕНАРИЙ НЕ ДОКАЗЫВАЕТ, названо честно: со снятым фильтром
        // он краснеет не всегда — оба claim целятся в голову очереди, один
        // выигрывает, второй уходит по SKIP LOCKED к следующему, и пары иногда
        // сходятся случайно. Детерминированные сторожа фильтра — 46 и 46а;
        // здесь проверяется, что фильтр не разваливается ПОД ОДНОВРЕМЕННОСТЬЮ:
        // ни дубля выдачи, ни взаимной блокировки.
        const mine = await product({ slug: 'mh-par-own', host: 'own' });
        const theirs = await product({ slug: 'mh-par-cli', host: 'clients' });
        await job(mine.id, { createdAgo: '2 minutes' });
        await job(theirs.id, { createdAgo: '1 minute' });

        const [a, b] = await Promise.all([
          makeSvc().claimJob('own'),
          makeSvc().claimJob('clients'),
        ]);

        expect([a!.slug, b!.slug]).toEqual(['mh-par-own', 'mh-par-cli']);
        expect(a!.jobId).not.toBe(b!.jobId);
      });
    });

    // ───────────── выбор машины при заведении (задача 4) ─────────────

    /**
     * ДО ЭТОЙ ЗАДАЧИ create() МЕТКУ НЕ СТАВИЛ ВОВСЕ, и это была не мелочь:
     * `p.host_id = NULL` в выдаче заданий не равно ничему, поэтому только что
     * заведённый продукт не доставался ни одному агенту. Задание висело в
     * очереди, через десять минут его хоронил сборщик зависших, и владелец
     * читал чужую формулировку про истёкший срок (сценарий 46г).
     *
     * ПОЧЕМУ ПРОТИВ ЖИВОЙ БАЗЫ. Весь отбор — один запрос: потолок считается
     * скалярным подзапросом, аудитория и accepts_new стоят в WHERE, причины
     * отказа приезжают двумя счётчиками через LEFT JOIN к `(SELECT 1)`.
     * Заглушка не исполняет ни одного из этих условий — на ней зелены и
     * «потолок считает спящих», и реализация, считающая только работающих.
     */
    describe('выбор машины при заведении', () => {
      const create = (o: { slug: string; isAdmin?: boolean; kind?: 'site' | 'bot' }) =>
        makeSvc().create({
          userId: o.isAdmin ? 'u-адм' : 'u-кли',
          isAdmin: o.isAdmin ?? false,
          name: `имя ${o.slug}`,
          slug: o.slug,
          kind: o.kind ?? 'site',
          secrets: {},
        });

      /** Отказ, а не результат: `.rejects` не даёт посмотреть на код ответа. */
      const refusedOn = (p: Promise<unknown>) => p.then(() => null, (e: any) => e);

      it('51. продукт клиента уезжает на клиентскую машину, продукт админа — на свою', async () => {
        // ГЛАВНЫЙ СЦЕНАРИЙ ЗАДАЧИ. Обе машины в реестре, обе с местом — выбор
        // решает ТОЛЬКО аудитория. Реализация, берущая первую машину по
        // порядку, поставила бы чужой продукт рядом с боевыми: 'clients' < 'own'
        // лексикографически, то есть ORDER BY отдал бы её обоим.
        await ensureHost('own');
        await addHost({ id: 'clients' });

        const cli = await create({ slug: 'mh-r1' });
        const own = await create({ slug: 'mh-r2', isAdmin: true });

        expect((await getProduct(cli.productId)).host_id).toBe('clients');
        expect((await getProduct(own.productId)).host_id).toBe('own');
      });

      it('51а. домен и адрес берутся у ВЫБРАННОЙ машины, а не из константы', async () => {
        // Константы адреса и зоны жили в provisioning.service.ts с
        // умолчаниями 139.59.210.42 и p.linkeon.io. Оставленные «на всякий
        // случай», они разошлись бы с реестром молча: продукт получил бы домен
        // одной зоны, а адрес другой — сайт стоит на клиентской машине, домен
        // выписан в зоне владельца, сертификата нет.
        await ensureHost('own');
        await addHost({ id: 'clients', ip: '10.0.0.77', suffix: 'c.linkeon.io' });

        const r = await create({ slug: 'mh-zone' });

        const row = await getProduct(r.productId);
        expect(row.domain).toBe('mh-zone.c.linkeon.io');
        expect(row.host_ip).toBe('10.0.0.77');
        expect(row.host_id).toBe('clients');
      });

      it('51б. потолок считает СПЯЩИХ, но не архивных', async () => {
        // Спящий контейнер остановлен и памяти не ест — считать его выглядит
        // расточительным. Не считать ОПАСНЕЕ: двадцать спящих просыпаются от
        // одного пополнения баланса, и машина, заполненная «по живым», ляжет.
        // Архивный не занимает ничего: заданий он не получает никогда.
        await addHost({ id: 'clients', capacity: 2 });
        await product({ slug: 'mh-sleeping', status: 'sleeping', host: 'clients' });
        const dead = await product({ slug: 'mh-archived', status: 'running', host: 'clients' });
        await pool.query(`UPDATE products SET archived_at = now() WHERE id = $1`, [dead.id]);

        // Второе место занимает спящий, третьего нет — архивный не считается,
        // иначе этот вызов отбился бы тоже.
        const r = await create({ slug: 'mh-cap1' });
        expect((await getProduct(r.productId)).host_id).toBe('clients');

        const e = await refusedOn(create({ slug: 'mh-cap2' }));
        expect(e).toBeInstanceOf(UnprocessableEntityException);
        expect(String(e.message)).toMatch(/мест/i);
      });

      it('51в. машина, не принимающая новые, пропускается — но свои продукты на ней остаются', async () => {
        // accepts_new выводит машину из оборота, не трогая то, что на ней
        // стоит: у неё остаются свои продукты и своя очередь заданий (45г).
        await addHost({ id: 'clients', acceptsNew: false });
        const old = await product({ slug: 'mh-old', host: 'clients' });

        const e = await refusedOn(create({ slug: 'mh-closed' }));

        expect(String(e.message)).toMatch(/мест/i);
        expect((await getProduct(old.id)).host_id).toBe('clients');
      });

      it('51г. отказ не оставляет ни продукта, ни задания, ни занятого слага', async () => {
        // Отказ идёт ДО выпуска токена и любой записи. Продукт, записанный «на
        // всякий случай» без метки, занял бы слаг навсегда и не достался бы ни
        // одному агенту.
        await addHost({ id: 'clients', capacity: 1 });
        await product({ slug: 'mh-occupied', host: 'clients' });

        await refusedOn(create({ slug: 'mh-nowhere' }));

        const left = await pool.query(`SELECT count(*) FROM products WHERE slug = 'mh-nowhere'`);
        expect(Number(left.rows[0].count)).toBe(0);
        const jobs = await pool.query('SELECT count(*) FROM product_provision_jobs');
        expect(Number(jobs.rows[0].count)).toBe(0);
      });

      it('51д. пустой реестр отличим от переполнения: своя причина, своя строка в журнале', async () => {
        // Состояние ДОСТИЖИМОЕ: 005 нарочно ничего не заводит при
        // незаполненном PRODUCT_HOST_TOKEN (40в), и на свежем окружении реестр
        // пуст. «Мест нет» отправило бы владельца добавлять вторую машину
        // вместо того, чтобы дописать переменную.
        const logged: string[] = [];
        jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
          logged.push(String(m));
        });

        const e = await refusedOn(create({ slug: 'mh-empty', isAdmin: true }));

        expect(e.getStatus()).toBe(422);
        expect(String(e.message)).toMatch(/не настроен/i);
        expect(logged.join('\n')).toMatch(/реестр машин пуст/);
      });

      it('51е. машин этой аудитории нет вовсе — тоже своя причина', async () => {
        // СЕГОДНЯШНИЙ ПРОД: машина own есть, клиентской ещё нет (кусок 4б).
        // Отдать клиенту машину владельца «раз уж другой нет» значило бы
        // поставить чужой код рядом с боевыми продуктами — ровно та авария,
        // ради которой машины и разделяют.
        await ensureHost('own');
        const logged: string[] = [];
        jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
          logged.push(String(m));
        });

        const e = await refusedOn(create({ slug: 'mh-noaudience' }));

        expect(String(e.message)).toMatch(/не открыт/i);
        expect(logged.join('\n')).toMatch(/audience=clients/);
        // На машине владельца ничего не появилось.
        const n = await pool.query(`SELECT count(*) FROM products WHERE host_id = 'own'`);
        expect(Number(n.rows[0].count)).toBe(0);
      });

      it('51ж. три причины отказа различимы между собой', async () => {
        // Каждая проверка выше смотрит на свой регексп и потому зелена у
        // реализации, отдающей один текст трижды.
        const empty = await refusedOn(create({ slug: 'mh-t1', isAdmin: true }));
        await ensureHost('own');
        const wrongAudience = await refusedOn(create({ slug: 'mh-t2' }));
        await addHost({ id: 'clients', capacity: 1 });
        await product({ slug: 'mh-t-filler', host: 'clients' });
        const full = await refusedOn(create({ slug: 'mh-t3' }));

        const texts = [empty, wrongAudience, full].map((e) => String(e.message));
        expect(new Set(texts).size).toBe(3);
        for (const t of texts) expect(t).not.toMatch(/позже/i);
      });

      it('51з. потолок считает продукты СВОЕЙ машины, а не все подряд', async () => {
        // `count(*) FROM products` без корреляции по машине — правка, которая
        // выглядит упрощением и запирает пустую машину, как только соседняя
        // набита. Своих продуктов здесь ноль, чужих — три.
        await ensureHost('own');
        await addHost({ id: 'clients', capacity: 2 });
        for (const slug of ['mh-n1', 'mh-n2', 'mh-n3']) {
          await product({ slug, host: 'own' });
        }

        const r = await create({ slug: 'mh-mine' });

        expect((await getProduct(r.productId)).host_id).toBe('clients');
      });

      it('51и. заведённый продукт СРАЗУ достаётся агенту своей машины', async () => {
        // СКВОЗНОЙ ХОД, ради которого написана задача. До неё метки не было, и
        // заведение заканчивалось похоронами по таймауту при полностью
        // исправном агенте.
        await ensureHost('own');
        await addHost({ id: 'clients' });

        const r = await create({ slug: 'mh-e2e' });

        expect(await makeSvc().claimJob('own')).toBeNull();
        const claimed = await makeSvc().claimJob('clients');
        expect(claimed!.productId).toBe(r.productId);
        expect(claimed!.slug).toBe('mh-e2e');
      });

      it('51к. у бота домена нет, а машина и её адрес есть', async () => {
        // Домена у бота нет по форме — он не принимает входящих соединений.
        // Метка при этом нужна ему ровно так же: по ней решается, чей агент
        // поднимет его контейнер.
        await addHost({ id: 'clients', ip: '10.0.0.88', suffix: 'c.linkeon.io' });

        const r = await create({ slug: 'mh-bot', kind: 'bot' });

        const row = await getProduct(r.productId);
        expect(row.domain).toBeNull();
        expect(row.host_id).toBe('clients');
        expect(row.host_ip).toBe('10.0.0.88');
      });

      it('51л. машины набиваются по порядку метки, а не наугад', async () => {
        // ORDER BY h.id — детерминированный «набиваем по очереди».
        // Балансировка сверх «есть место / нет места» из куска вынесена, но
        // отсутствие ORDER BY означало бы порядок, который решает планировщик:
        // он меняется от статистики таблицы, то есть однажды молча.
        await addHost({ id: 'cli-a', capacity: 1 });
        await addHost({ id: 'cli-b', capacity: 1 });

        const first = await create({ slug: 'mh-fill1' });
        const second = await create({ slug: 'mh-fill2' });

        expect((await getProduct(first.productId)).host_id).toBe('cli-a');
        expect((await getProduct(second.productId)).host_id).toBe('cli-b');
      });

      it('51м. потолок МЯГКИЙ под одновременными заявками — измерено, не закрыто', async () => {
        // ИЗМЕРЕНИЕ, А НЕ ПОЖЕЛАНИЕ. Выбор и вставка — два разных оператора, а
        // каждый запрос через пул сам себе транзакция: оба заведения видят
        // снимок БЕЗ строки соседа и оба проходят последнее свободное место.
        // Одним оператором это не чинится — `INSERT … SELECT` берёт тот же
        // снимок, а FOR UPDATE лочит строку машины уже после вычисления
        // условия. Настоящее закрытие — выделенное соединение и явная
        // транзакция, где второй командой берётся НОВЫЙ снимок.
        //
        // Не сделано сознательно: сегодня заведение доступно только админам,
        // то есть «одновременно» означает двух владельцев в одну миллисекунду,
        // а перебор на единицу стоит ~90 МБ. ТРИГГЕР ПЕРЕСМОТРА — кусок 4б,
        // где вкладка открывается всем: пятьдесят одновременных заявок кладут
        // машину при потолке двадцать.
        //
        // Тест краснеет, когда предел ЗАКРОЮТ, — и тогда его надо читать, а не
        // чинить: ограничение снято, комментарий устарел.
        //
        // ГОНКА ВОСПРОИЗВОДИТСЯ ТОЧНО, А НЕ ЛОВИТСЯ `Promise.all`. Первая
        // редакция этого сценария просто пускала два заведения разом и была
        // ФЛАКИ: измерено — один красный на ~27 полных прогонов. Причина в
        // пуле: второму заведению может достаться ещё не открытое соединение,
        // и его выборка машины уходит на сервер уже ПОСЛЕ вставки первого,
        // то есть видит занятое место и честно отбивается. Сценарий,
        // проходящий по настроению, хуже отсутствующего — поэтому здесь стоит
        // барьер: оба выбора машины обязаны СНЯТЬ СНИМОК, и только потом любое
        // из заведений идёт дальше. Тот же приём, что у 18в.
        await addHost({ id: 'clients', capacity: 1 });
        let picked = 0;
        let openGate: () => void = () => undefined;
        const gate = new Promise<void>((r) => (openGate = r));
        const gatedPg = {
          query: async (sql: string, params?: any[]) => {
            const r = await pool.query(sql, params);
            if (/FROM product_hosts/.test(sql)) {
              if (++picked === 2) openGate();
              await gate;
            }
            return r;
          },
        };
        const raced = () =>
          new ProvisioningService(gatedPg as any, secrets, new HostsService(gatedPg as any), new LimitsService(gatedPg as any));

        const both = await Promise.all([
          refusedOn(
            raced().create({
              userId: 'u-кли',
              isAdmin: false,
              name: 'гонка 1',
              slug: 'mh-race1',
              kind: 'site',
              secrets: {},
            }),
          ),
          refusedOn(
            raced().create({
              userId: 'u-кли',
              isAdmin: false,
              name: 'гонка 2',
              slug: 'mh-race2',
              kind: 'site',
              secrets: {},
            }),
          ),
        ]);

        expect(picked).toBe(2);

        const placed = await pool.query(
          `SELECT count(*) FROM products WHERE host_id = 'clients' AND archived_at IS NULL`,
        );
        expect(Number(placed.rows[0].count)).toBe(2);
        expect(both.every((e) => e === null)).toBe(true);
      });

      it('51н. проба перевода в running идёт в зону ВЫБРАННОЙ машины', async () => {
        // PUBLIC_ZONE был третьей константой и собирал адрес из слага:
        // продукт клиентской машины проверялся бы по адресу в зоне владельца —
        // ответа нет никогда, и через десять минут сборщик зависших хоронит
        // исправный сайт.
        await addHost({ id: 'clients', suffix: 'c.linkeon.io' });
        const asked: string[] = [];
        const svc = makeSvc(async (url: string) => {
          asked.push(url);
          return { status: 200 };
        });

        const r = await svc.create({
          userId: 'u-кли',
          isAdmin: false,
          name: 'зона',
          slug: 'mh-probe',
          kind: 'site',
          secrets: {},
        });
        // Заведение закрыто, раннер на связи — остаётся проба.
        await pool.query(
          `UPDATE product_provision_jobs SET status = 'done', finished_at = now() WHERE product_id = $1`,
          [r.productId],
        );
        await pool.query(`UPDATE products SET runner_seen_at = now() WHERE id = $1`, [r.productId]);

        await svc.promoteReady();

        expect(asked).toEqual(['https://mh-probe.c.linkeon.io/health']);
        expect((await getProduct(r.productId)).status).toBe('running');
      });

      it('51о. сайт БЕЗ домена в running не уезжает и говорит об этом', async () => {
        // Раньше адрес пробы собирался из слага и константы зоны, поэтому
        // пустой domain был невидим: проба уходила по угаданному адресу и
        // проходила. Такие строки на проде есть — заведённые до того, как
        // автозаведение научилось заполнять domain.
        //
        // Угадывать больше нечего (зона своя у каждой машины), да и незачем:
        // продукт без домена сломан и с другой стороны — ссылку в кабинете
        // рисуют из той же колонки.
        const p = await product({ slug: 'mh-nodomain', domain: null, seenAgo: '5 seconds' });
        const logged: string[] = [];
        jest.spyOn(Logger.prototype, 'error').mockImplementation((m: any) => {
          logged.push(String(m));
        });
        const asked: string[] = [];
        const svc = makeSvc(async (url: string) => {
          asked.push(url);
          return { status: 200 };
        });

        await expect(svc.promoteReady()).resolves.toBe(0);

        expect(asked).toEqual([]);
        expect((await getProduct(p.id)).status).toBe('provisioning');
        expect(logged.join('\n')).toMatch(/mh-nodomain[\s\S]*пустой domain/);
      });
    });
  });
});
