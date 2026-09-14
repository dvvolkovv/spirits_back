import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PgService } from '../common/services/pg.service';
import { SecretsService } from './secrets.service';

export type ProductKind = 'site' | 'bot';

export interface CreateInput {
  userId: string;
  name: string;
  slug: string;
  kind: ProductKind;
  secrets: Record<string, string>;
}

/**
 * Задание, выданное агенту хоста. Единственное место, где открытый
 * runner-токен вообще существует: агенту он отдаётся один раз, в теле ответа.
 */
export interface ClaimedJob {
  jobId: string;
  productId: string;
  slug: string;
  kind: ProductKind;
  runnerToken: string;
  secrets: Record<string, string>;
}

// Дефис только внутри. Регексп из плана (/^[a-z0-9-]{2,40}$/) пропускал '-rf'
// и '--': слаг уезжает именем контейнера, каталогом на хосте и меткой домена,
// а ведущий дефис в аргументе docker/nginx разбирается как флаг. Нижняя
// граница — один символ: односимвольная метка домена законна.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Имена секретов становятся переменными окружения контейнера. 'A B' и 'A=1'
// там либо теряются, либо подменяют соседнюю переменную — в зависимости от
// того, как агент соберёт env-файл.
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Путь ВНУТРИ контейнера продукта, а не на хосте: раннер живёт внутри
// контейнера (агент провижининга — снаружи), и чекаут там у всех продуктов
// один и тот же. Хостовые пути вида /home/dv/selyanska остались от прежней
// схемы «продукт = каталог на общей машине».
const CHECKOUT_PATH = '/product';

// Публичная зона продуктов. Проба идёт сюда, а не на 127.0.0.1: см. answers().
const PUBLIC_ZONE = 'p.linkeon.io';

// Проба существует ради адресов, которые НЕ отвечают, поэтому свой срок
// обязателен: на дефолтах undici чёрная дыра держит соединение неопределённо
// долго. Срок ограничивает ОДНУ пробу; от наложения оборотов защищает флаг
// занятости в tick(), потому что продукты обходятся последовательно и семи
// чёрных дыр хватает, чтобы перерасти период таймера.
const PROBE_TIMEOUT_MS = 5000;

/**
 * За сколько отметка раннера протухает.
 *
 * `runner_seen_at IS NOT NULL` означает «когда-нибудь выходил на связь», а не
 * «на связи». Разница смертельна ровно в штатном ходе повтора: claimJob
 * поворачивает runner_token_hash, старый раннер после этого не может
 * аутентифицироваться и отметку не двигает — а прошлое значение остаётся в
 * строке навсегда. Измерено: отметка девятидневной давности плюс ответ 200 от
 * старой версии сайта объявляли продукт рабочим, хотя новый раннер не
 * поднялся и ходы уезжали в никого.
 *
 * Порог считан с раннера, а не выбран на глаз: POLL_INTERVAL_MS=3000,
 * DEFAULT_POLL_TIMEOUT_MS=35000 (product-runner/src/config.ts), а сама запись
 * отметки в turns.touchRunner загрублена до одного раза в 30 секунд. Худший
 * случай живого раннера — около 70 секунд тишины, и там же прямо записано
 * требование «порог обязан быть заметно больше 30 секунд». Две минуты дают
 * запас почти вдвое и не дают продукту мигать между статусами.
 */
const HEARTBEAT_FRESH_MS = 2 * 60 * 1000;

// Срок на всё заведение. Одно число на четыре запроса и обе формулировки
// причины. В тексте «мин», а не «минут»: при смене числа русская форма
// множественного числа поехала бы (2 минуты, 21 минута), а сокращение
// неизменяемо.
const PROVISION_DEADLINE_MIN = 10;
const DEADLINE_SQL = `interval '${PROVISION_DEADLINE_MIN} minutes'`;
// `/ 1000` — не косметика. Константа хранится в МИЛЛИСЕКУНДАХ (её читает
// heartbeatFresh через Date.now()), а interval считает по названной единице:
// `interval '120000 seconds'` — это 33 часа, и раннер, молчащий час,
// объявляется «на связи». Сегодня цена ошибки мала — константа стоит только в
// CASE, и врёт лишь СЛОВО в карточке. Держать её надо как класс, а не как
// описку: первый же перенос порога в WHERE (отбор «живых» продуктов, условие
// перевода) сделает ту же тысячекратную ошибку ошибкой СОСТОЯНИЯ. Единица
// пришпилена тестом по готовой строке, а не по выражению.
const HEARTBEAT_FRESH_SQL = `interval '${HEARTBEAT_FRESH_MS / 1000} seconds'`;

/**
 * ГОНКИ В ЭТОМ ФАЙЛЕ ЗАКРЫВАЕТ ФОРМА ЗАПРОСОВ, А НЕ МОДУЛЬ.
 *
 * Формулировка «гонки закрывают условия в записи» неточна и уже вводила в
 * заблуждение. Проверено на живой базе двумя параллельными инстансами:
 * закрывает их то, что КАЖДАЯ запись — один оператор со своими
 * предусловиями. Состояние сверяется в тот же миг, когда меняется, и
 * промежутка, в который его успевает поменять сосед, просто не существует —
 * ни у claimJob (выдача плюс выпуск токена), ни у completeJob (закрытие
 * задания плюс правка продукта), ни у promoteReady (перевод), ни у обеих
 * веток таймаута.
 *
 * Это свойство ФОРМЫ, а не модуля, и верно оно ровно пока каждая запись
 * остаётся одним оператором. Оно исчезнет в ту минуту, когда кто-нибудь
 * разложит запись на «прочитать — подумать — записать», и исчезнет молча:
 * тесты, сторожащие подстроки SQL, такую разборку переживут.
 *
 * Отговорка «у нас всё равно один процесс» не работает. Прод запущен в
 * кластерном режиме; процесс сейчас один, но число инстансов нигде в
 * репозитории не зафиксировано — параллельные обороты это одно `pm2 scale` от
 * реальности, и никакого предупреждения при этом не будет.
 */
@Injectable()
export class ProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisioningService.name);
  private promoter?: NodeJS.Timeout;

  /**
   * Подменяется в тестах.
   *
   * НЕ `typeof fetch`. Во-первых, `(...args) => fetch(...args)` на этом типе не
   * собирается вовсе: TS2556, «A spread argument must either have a tuple type
   * or be passed to a rest parameter», — и `nest build` отдавал rc=1 на чистом
   * дереве. Заметить это было нечем: ts-jest типы не проверяет (см. шапку
   * provisioning.integration.spec.ts), а deploy.sh гонит
   * `npm run build 2>&1 | tail -3` под `set -e` БЕЗ `pipefail`, поэтому код
   * возврата берётся у `tail`, падение сборки глотается и `pm2 restart` уезжает
   * на старом dist. Тем же механизмом уже терялась сборка воркера.
   *
   * Во-вторых, полный `typeof fetch` был обещанием, которого никто не
   * выполняет: отсюда используется только `.status`, а заглушки в тестах
   * отдают ровно `{ status }`.
   */
  private fetchFn: (url: string, init?: RequestInit) => Promise<{ status: number }> = (url, init) =>
    fetch(url, init);

  constructor(
    private readonly pg: PgService,
    private readonly secrets: SecretsService,
  ) {}

  /**
   * Оборот в 30 секунд, а не в пять минут: заведение должно оживать на глазах
   * у нажавшего кнопку, иначе рабочий продукт неотличим от зависшего.
   */
  onModuleInit() {
    this.promoter = setInterval(() => {
      void this.tick();
    }, 30 * 1000);
    // unref, иначе таймер держит процесс и jest не завершается.
    this.promoter.unref();
  }

  /**
   * Один оборот. Два метода идут ПОСЛЕДОВАТЕЛЬНО, и оборот не наезжает на
   * предыдущий.
   *
   * Без await между ними таймаут работал параллельно пробе: пока promoteReady
   * ждал ответа сайта, failStaleProvisioning хоронил тот же продукт, а
   * вернувшаяся проба воскрешала его в running — причина затёрта, а в логе
   * оставалось «провижининг просрочен» про продукт, который числится рабочим.
   * Запись теперь сверяет состояние сама (см. promoteReady), но и порядок
   * незачем оставлять случайным.
   *
   * Флаг занятости — потому что продукты обходятся последовательно, а каждая
   * проба может занять до PROBE_TIMEOUT_MS: семи заводящихся сайтов с чёрной
   * дырой в DNS хватает, чтобы оборот перерос период таймера.
   */
  private ticking = false;

  private async tick(): Promise<void> {
    if (this.ticking) {
      this.logger.debug('оборот провижининга ещё идёт — пропускаю такт');
      return;
    }
    this.ticking = true;
    try {
      await this.promoteReady().catch((e) =>
        this.logger.error(`promoteReady failed: ${e.message}`),
      );
      await this.failStaleProvisioning().catch((e) =>
        this.logger.error(`failStaleProvisioning failed: ${e.message}`),
      );
    } finally {
      this.ticking = false;
    }
  }

  onModuleDestroy() {
    if (this.promoter) clearInterval(this.promoter);
  }

  /**
   * Заводит продукт в статусе provisioning и ставит задание агенту хоста.
   *
   * Живой runner-токен здесь НЕ выпускается — см. комментарий к hash ниже.
   */
  async create(input: CreateInput): Promise<{ productId: string }> {
    if (input.kind !== 'site' && input.kind !== 'bot') {
      throw new BadRequestException('неизвестная форма продукта');
    }
    if (!SLUG_RE.test(input.slug)) {
      throw new BadRequestException(
        'слаг: строчные латинские, цифры и дефис, 1–40 символов, дефис только внутри',
      );
    }
    // Форма секретов проверяется здесь, а не в SecretsService: encrypt форму
    // значений не смотрит и коробку с числом внутри соберёт молча. Взорвалось
    // бы это при расшифровке — у агента на хосте, где отказ выглядит как
    // «провижининг сорвался» без причины. Пустая строка доезжает до
    // контейнера переменной без значения: бот читает это как «токена нет» и
    // не стартует, тоже молча.
    for (const [name, value] of Object.entries(input.secrets ?? {})) {
      if (!SECRET_NAME_RE.test(name)) {
        throw new BadRequestException(`имя секрета ${JSON.stringify(name)} не переменная окружения`);
      }
      if (typeof value !== 'string' || value === '') {
        throw new BadRequestException(`секрет ${name}: значение должно быть непустой строкой`);
      }
    }

    // Проверка ДО выпуска токена и любой записи: иначе падение на UNIQUE
    // оставляло бы висячий продукт, а токен был бы выпущен впустую.
    // Без фильтра по archived_at намеренно: UNIQUE на products.slug архивные
    // строки не исключает, и «свободен» здесь означало бы отказ на INSERT.
    const taken = await this.pg.query(`SELECT count(*) FROM products WHERE slug = $1`, [input.slug]);
    if (Number(taken.rows[0].count) > 0) throw new ConflictException('слаг уже занят');

    // id генерируется здесь, а не в базе: секреты шифруются с привязкой к нему
    // (AAD), а значит он нужен ДО INSERT. Вариант «вставить, потом обновить»
    // дал бы окно, в котором продукт есть, а секретов нет.
    const productId = crypto.randomUUID();
    // runner_token_hash — NOT NULL UNIQUE, заполнить чем-то надо, но живой
    // токен здесь выпускать незачем и вредно: доставить его некуда. Открытый
    // токен отдаётся агенту ровно один раз, в теле задания, и выпускает его
    // claimJob (задача 4) заново на каждую выдачу. Токен, материализованный
    // здесь, RunnerGuard принял бы, вызывающий получил бы его в ответе и в
    // лог — а через минуту он обесценился бы. Следующий читатель решил бы,
    // что это и есть тот токен, который показывают пользователю.
    //
    // Хешируются случайные байты, строкой-токеном они не становятся ни на
    // миг: прообраза не существует нигде, подбирать нечего. Именно случайные,
    // а не productId или слаг: sha256 от известного значения означала бы, что
    // это значение и есть рабочий токен — RunnerGuard сверяет предъявленное
    // ровно так же.
    const hash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
    // NULL, а не коробка от {}: по нему задача 4 решает, звать ли decrypt.
    // decrypt(null) — сырой TypeError, поэтому признак «секретов нет» обязан
    // читаться до вызова.
    const box = Object.keys(input.secrets ?? {}).length
      ? this.secrets.encrypt(input.secrets, productId)
      : null;

    try {
      await this.pg.query(
        `INSERT INTO products (id, user_id, name, slug, kind, status, checkout_path, runner_token_hash, secrets_encrypted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          productId,
          input.userId,
          input.name,
          input.slug,
          input.kind,
          'provisioning',
          CHECKOUT_PATH,
          hash,
          box,
        ],
      );
    } catch (e: any) {
      // Гонка: между SELECT count(*) и этим INSERT слаг мог занять
      // параллельный запрос. Продукта при этом не остаётся, страдает только
      // код ответа — 500 вместо 409, то есть страница ошибки вместо «слаг
      // занят, выберите другой».
      //
      // Условие узкое, как в turns.service: безусловный ConflictException
      // превратил бы падение базы и нарушение CHECK в спокойное «слаг занят»
      // без следа в логах. Второй UNIQUE на этой таблице —
      // products_runner_token_hash_key: столкновение sha256 от 32 случайных
      // байт означает не занятый слаг, а что-то, что обязано быть видно как
      // 500. Имена ограничений сняты с живой базы.
      if (e?.code === '23505' && e?.constraint === 'products_slug_key') {
        throw new ConflictException('слаг уже занят');
      }
      throw e;
    }

    try {
      await this.pg.query(
        `INSERT INTO product_provision_jobs (product_id, status) VALUES ($1, 'queued')`,
        [productId],
      );
    } catch (e: any) {
      // Транзакции здесь нет: BEGIN через пул в этом репозитории уже
      // рапортовал об откате, которого не было (identity.resolveOrCreate).
      // Поэтому продукт остаётся записанным, и без пометки он висел бы в
      // provisioning вечно — задания нет, ошибки в карточке нет, а слаг занят,
      // и повторить заведение под ним уже нельзя.
      this.logger.error(`продукт ${productId}: задание не поставлено (${e.message})`);
      await this.pg
        .query(`UPDATE products SET status = 'failed', provision_error = $2 WHERE id = $1`, [
          productId,
          `задание провижининга не поставлено: ${e.message}`,
        ])
        .catch((e2: any) =>
          this.logger.error(`продукт ${productId}: пометка failed тоже не прошла (${e2.message})`),
        );
      throw e;
    }

    return { productId };
  }

  /**
   * Выдаёт одно задание агенту хоста.
   *
   * SKIP LOCKED — на случай второго агента: задание не должно достаться
   * двоим, иначе два развёртывания пойдут в один каталог. Измерено на живой
   * базе: два одновременных claim разошлись по разным заданиям за 0.06 с, без
   * SKIP LOCKED второй ждал 2.08 с и получал то же самое.
   *
   * ОДИН оператор, а не два. Двумя запросами на пуле (транзакции нет: BEGIN
   * через пул в этом репозитории уже рапортовал об откате, которого не было —
   * identity.resolveOrCreate) падение второго оставляло бы задание в
   * 'running' с токеном, не доехавшим до агента, а частичный индекс
   * one_active запирал бы продукт до сборщика зависших.
   */
  async claimJob(): Promise<ClaimedJob | null> {
    // Токен считается ДО запроса, чтобы всё уместилось в один оператор. Если
    // выдавать нечего, CTE issued не обновит ни строки (claimed пуста) и
    // токен просто выбрасывается. Проверено на живой базе: claim при пустой
    // очереди не оставил свой хеш ни у одного продукта.
    const runnerToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(runnerToken).digest('hex');

    const r = await this.pg.query(
      `WITH picked AS (
          SELECT j.id
            FROM product_provision_jobs j
           WHERE j.status = 'queued'
             AND EXISTS (SELECT 1 FROM products p
                          WHERE p.id = j.product_id
                            AND p.status = 'provisioning'
                            AND p.archived_at IS NULL)
           ORDER BY j.created_at ASC
             FOR UPDATE SKIP LOCKED
           LIMIT 1
       ), claimed AS (
          UPDATE product_provision_jobs
             SET status = 'running', started_at = now()
           WHERE id IN (SELECT id FROM picked)
          RETURNING id, product_id
       ), issued AS (
          UPDATE products
             SET runner_token_hash = $1
           WHERE id IN (SELECT product_id FROM claimed)
          RETURNING id, slug, kind, secrets_encrypted AS box
       )
       SELECT c.id AS job_id, i.id AS product_id, i.slug AS slug,
              i.kind AS kind, i.box AS box
         FROM claimed c JOIN issued i ON i.id = c.product_id`,
      [hash],
    );
    // Пустая очередь — обычное состояние: агент опрашивает нас в цикле.
    const row = r.rows[0];
    if (!row) return null;

    return {
      jobId: row.job_id,
      productId: row.product_id,
      slug: row.slug,
      kind: row.kind,
      runnerToken,
      // ДВА аргумента: коробка привязана к продукту через AAD. Признак
      // «секретов нет» — NULL в secrets_encrypted (задача 3 кладёт именно
      // его, а не коробку от {}), и читаться он обязан ДО вызова: decrypt на
      // null — сырой TypeError.
      secrets: row.box ? this.secrets.decrypt(row.box, row.product_id) : {},
    };
  }

  /**
   * Принимает отчёт агента о развёртывании.
   *
   * Задание закрывается в обоих исходах — его держит частичный уникальный
   * индекс product_provision_jobs_one_active, и оставленное в 'running'
   * задание навсегда запретило бы повтор.
   *
   * `AND status = 'running'` — замок от повторного отчёта. Без него отчёт по
   * уже закрытому заданию правил ЖИВОЙ продукт: измерено на базе — продукт в
   * running с портом 8003 повторный {ok:false} хоронил в failed, а повторный
   * {ok:true} без порта оставлял без порта. Ретрай POST-а при обрыве связи
   * воспроизводит это без всякого злоумышленника, и HostGuard задачи 7 тут не
   * помощник: он подтверждает, что пришёл наш агент, а наш агент звать
   * completeJob вправе.
   *
   * ОДИН оператор на оба пути, как в claimJob. Двумя запросами на пуле замок
   * жил в `rowCount` между ними и спасал только от повторного отчёта, но не от
   * смерти процесса ПОСЛЕ первого запроса:
   *   - отказ: задание уже failed, продукт остался в provisioning без причины.
   *     Реаппер отбирает по заданию и такого задания не увидит, promoteReady
   *     не переведёт (развёртывание сорвалось), retry требует
   *     status = 'failed' и вернёт 404. Продукт не спасает никто — тупик той
   *     же формы, о котором предупреждает спека куска 1. Частично его
   *     добирала вторая ветка таймаута, но с ЧУЖОЙ формулировкой про срок:
   *     владелец видел «не уложилось в 10 минут» там, где агент отчитался об
   *     отказе минуту назад;
   *   - успех мягче: продукт вылезет через promoteReady, но port останется
   *     NULL навсегда — хранится он только здесь, восстановить неоткуда.
   * Транзакции нет и не будет: BEGIN через пул в этом репозитории уже
   * рапортовал об откате, которого не было (identity.resolveOrCreate).
   *
   * Замок стал ВСТРОЕННЫМ: закрытое задание даёт пустой CTE, а пустой CTE не
   * даёт соединению с продуктом ни одной строки. Продукт берётся именно
   * `FROM closed`, а не самостоятельным подзапросом по product_provision_jobs:
   * подзапрос нашёл бы продукт независимо от того, закрылось ли задание, и
   * дыра повторного отчёта открылась бы заново.
   */
  async completeJob(jobId: string, result: { ok: boolean; port?: number; error?: string }) {
    if (result.ok) {
      // Статус продукта здесь НЕ меняется. Перевод в running делает
      // promoteReady по измеримому факту (задача 5): отчёт агента говорит
      // «я развернул», а не «оно отвечает».
      //
      // COALESCE, а не голое присваивание: отчёт об успехе без порта (бот его
      // не публикует) снёс бы порт уже работающего сайта. Хранится он только
      // здесь — восстановить неоткуда.
      const r = await this.pg.query(
        `WITH closed AS (
            UPDATE product_provision_jobs
               SET status = 'done', finished_at = now()
             WHERE id = $1 AND status = 'running'
            RETURNING product_id
         )
         UPDATE products SET port = COALESCE($2, port)
           FROM closed WHERE products.id = closed.product_id`,
        [jobId, result.port ?? null],
      );
      if (!r.rowCount) {
        this.logger.warn(`отчёт об успехе по незапущенному заданию ${jobId} — продукт не тронут`);
      }
      return;
    }
    // Порт здесь не трогается намеренно: неудачная ПОВТОРНАЯ попытка снесла бы
    // порт уже работавшего продукта, а хранится он только тут.
    const r = await this.pg.query(
      `WITH closed AS (
          UPDATE product_provision_jobs
             SET status = 'failed', error = $2, finished_at = now()
           WHERE id = $1 AND status = 'running'
          RETURNING product_id
       )
       UPDATE products SET status = 'failed', provision_error = $2
         FROM closed WHERE products.id = closed.product_id`,
      [jobId, result.error ?? 'без причины'],
    );
    if (!r.rowCount) {
      this.logger.warn(`отчёт об отказе по незапущенному заданию ${jobId} — продукт не тронут`);
    }
  }

  /**
   * Переводит в `running` только то, что доказало готовность.
   *
   * Спека куска 1 предупреждала: `provisioning` — тупик той же формы, какой
   * был у `degraded`. Работа выдаётся только при `running`, снять статус
   * некому, отказ молчаливый. Поэтому условие — наблюдаемое состояние, а не
   * отчёт агента: completeJob намеренно не трогает статус продукта, потому
   * что «я развернул» и «оно отвечает» — разные утверждения, и расходились
   * они у нас уже дважды.
   */
  async promoteReady(): Promise<number> {
    // NOT EXISTS — не осторожность, а замок. Измерено на PostgreSQL 16
    // (promotescratch на тестовой ноде), сценарий «повторить» поверх
    // РАБОТАЮЩЕГО сайта:
    //   1. retry ставит продукту provisioning и кладёт задание в очередь;
    //   2. ближайший тик видит живой heartbeat СТАРОГО раннера и ответ 200 от
    //      СТАРОЙ версии сайта — и возвращает продукт в running;
    //   3. claimJob требует p.status = 'provisioning', и задание после этого
    //      не выдаётся никому и никогда (замерено: выборка выдачи пуста);
    //   4. через десять минут таймаут хоронит задание, но продукт правит
    //      только при p.status = 'provisioning' — а он running. Замерено:
    //      RETURNING пуст, значит и строки в логе нет, provision_error NULL.
    // Итог: кнопка нажата, ничего не произошло, ошибки нет нигде.
    //
    // Пока задание не закрыто, «отвечает» означает СТАРУЮ версию, а не
    // результат заведения. Та же ошибка, что в куске 1, где health-check
    // опрашивал осиротевший процесс от прошлой версии и объявлял выкат
    // удачным.
    //
    // Первичное заведение это не ломает — замерено там же: продукт с
    // заданием в done выборкой берётся. Порядок получается ровно нужный:
    // агент отчитался -> задание закрыто -> ближайший тик увидел heartbeat и
    // ответ -> перевод.
    const r = await this.pg.query(
      `SELECT id, slug, kind, runner_seen_at FROM products
        WHERE status = 'provisioning' AND archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = products.id
                             AND j.status IN ('queued','running'))`,
    );
    let promoted = 0;
    for (const p of r.rows) {
      // Раннер молчит — внутри контейнера некому принимать ходы, и продукт в
      // running был бы витриной без начинки. Проверяется СВЕЖЕСТЬ отметки, а
      // не её наличие: см. HEARTBEAT_FRESH_MS.
      if (!this.heartbeatFresh(p.runner_seen_at)) continue;
      try {
        if (p.kind === 'site' && !(await this.answers(p.slug))) continue;
        // Условия отбора повторены В ЗАПИСИ. Выборка выше проверила их за
        // 0–5 секунд до этой строки — ровно на длину пробы, и всё это время
        // состояние продукта мог менять кто угодно. Измерено на PostgreSQL 16,
        // три исхода незащищённой записи:
        //   - «повторить» нажато во время пробы: продукт уезжает в running,
        //     claimJob перестаёт видеть задание, через 10 минут таймаут
        //     оставляет running и provision_error NULL. Тот самый тупик,
        //     воспроизведённый поверх коммита, который его закрывал;
        //   - таймаут похоронил продукт во время пробы: похороненный
        //     воскресает в running, причина затёрта;
        //   - продукт архивирован во время пробы: archived_at выставлен,
        //     статус running.
        // Гонки с пользователем для второго исхода даже не нужно: раньше оба
        // метода звались из одного такта без await между собой.
        //
        // Закрывают их, однако, не сами по себе «условия в записи», а то, что
        // запись — ОДИН оператор со своими предусловиями: см. доку класса.
        // Разложи её на «прочитать — подумать — записать», и повторённые
        // условия станут такой же декорацией, какой были условия выборки.
        const w = await this.pg.query(
          `UPDATE products SET status = 'running', provision_error = NULL
            WHERE id = $1 AND status = 'provisioning' AND archived_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                               WHERE j.product_id = products.id
                                 AND j.status IN ('queued','running'))`,
          [p.id],
        );
        // Счётчик от rowCount, а не безусловный: иначе метод рапортует о
        // переводах, которых не было, и первый же признак того, что защита
        // сработала, теряется.
        promoted += w.rowCount ?? 0;
      } catch (e: any) {
        // Именно по продукту, а не на весь оборот: один битый продукт иначе
        // запирает в provisioning всю очередь — та самая форма молчаливого
        // тупика, ради выхода из которой метод и написан.
        this.logger.error(`продукт ${p.slug}: перевод в running сорвался (${e.message})`);
      }
    }
    return promoted;
  }

  /** «На связи», а не «когда-нибудь выходил на связь». См. HEARTBEAT_FRESH_MS. */
  private heartbeatFresh(seenAt: Date | string | null): boolean {
    if (!seenAt) return false;
    const ts = new Date(seenAt).getTime();
    if (Number.isNaN(ts)) return false;
    return Date.now() - ts <= HEARTBEAT_FRESH_MS;
  }

  /**
   * Проверка по ПУБЛИЧНОМУ адресу: до 127.0.0.1 на хосте бэкенд не дотянется,
   * а заодно это подтверждает, что vhost заведён и TLS работает.
   */
  private async answers(slug: string): Promise<boolean> {
    try {
      const res = await this.fetchFn(`https://${slug}.${PUBLIC_ZONE}/health`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      // Только 2xx. Редирект — это чаще всего заглушка регистратора или
      // дефолтный vhost, то есть «домена ещё нет», а не «продукт работает».
      return res.status >= 200 && res.status < 300;
    } catch {
      // ENOTFOUND, отказ TLS, срок пробы — нормальные состояния ещё не
      // заведённого сайта. Непойманными они унесли бы весь оборот.
      return false;
    }
  }

  async failStaleProvisioning(): Promise<number> {
    // Срок считается по ЗАДАНИЮ, а не по products.created_at. Измерено на
    // живой базе: продукт недельной давности, которому нажали «повторить»,
    // получает status='provisioning' в той же строке — и условие по
    // created_at продукта истинно немедленно. Таймаут убивал бы повтор в тот
    // же тик, до того как агент успеет забрать задание.
    //
    // Заодно снимается задание: без этого оно остаётся в running, частичный
    // индекс product_provision_jobs_one_active держит продукт запертым, и
    // кнопка «повторить» мертва навсегда. Проверено на живой базе — вставка
    // второго задания падает с duplicate key.
    //
    // `p.status = 'provisioning'` — не декорация: зависшее задание бывает и у
    // продукта, уже переведённого в running (повтор поверх работающего), и
    // без сверки таймаут гасил бы рабочий сайт.
    const r = await this.pg.query(
      `WITH stale AS (
         UPDATE product_provision_jobs
            SET status = 'failed',
                error = 'срок заведения истёк (${PROVISION_DEADLINE_MIN} мин)',
                finished_at = now()
          WHERE status IN ('queued','running')
            AND COALESCE(started_at, created_at) < now() - ${DEADLINE_SQL}
         RETURNING product_id)
       UPDATE products p
          SET status = 'failed',
              -- Причина различается по тому, на связи ли раннер. Продукт,
              -- который ОТВЕЧАЕТ, с надписью «не уложился в срок» — это
              -- владелец, видящий рабочий сайт и текст про таймаут. Если
              -- раннер жив, правда другая: агент не закрыл задание.
              provision_error = CASE
                WHEN p.runner_seen_at > now() - ${HEARTBEAT_FRESH_SQL}
                  THEN 'агент не отчитался о завершении заведения (срок ${PROVISION_DEADLINE_MIN} мин)'
                ELSE 'срок заведения истёк (${PROVISION_DEADLINE_MIN} мин)'
              END
         FROM stale
        WHERE p.id = stale.product_id AND p.status = 'provisioning'
       RETURNING p.slug`,
    );
    // ВТОРАЯ ветка. Первая ходит по ЗАДАНИЯМ и потому не видит продукт, у
    // которого задание уже ЗАКРЫТО, а сам он так и не ожил. Измерено на
    // PostgreSQL 16: агент отчитался об успехе, адрес молчит (не выписан
    // сертификат, vhost не тот, контейнер в перезапуске) — задание в done,
    // под условие `status IN ('queued','running')` не попадает, продукт
    // остаётся в provisioning НАВСЕГДА. Ровно тот тупик, ради выхода из
    // которого написан этот файл, просто на шаг позже.
    //
    // Сюда же попадает продукт вообще без задания: create вставляет продукт и
    // задание двумя операторами без транзакции (причина документирована
    // там же), и смерть процесса между ними оставляет то же самое.
    // COALESCE(..., p.created_at) — фолбэк ТОЛЬКО для этого случая; как
    // только у продукта есть хоть одно задание, срок считается по нему.
    // Измерено: повтор девятидневного продукта со свежим заданием не
    // хоронится, продукт без заданий возрастом 99 минут — хоронится,
    // только что созданный без задания — нет.
    const silent = await this.pg.query(
      `UPDATE products p
          SET status = 'failed',
              provision_error = CASE
                WHEN p.runner_seen_at > now() - ${HEARTBEAT_FRESH_SQL}
                  THEN 'задание закрыто, раннер на связи, но публичный адрес не отвечает'
                ELSE 'задание закрыто, продукт не ожил: раннер не выходит на связь'
              END
        -- archived_at выводит строку из-под гейта СОВСЕМ: архивный продукт,
        -- застрявший в provisioning с закрытым заданием, не переводится и не
        -- хоронится — состояние без выхода. Сегодня оно недостижимо, потому
        -- что products.archived_at не пишет ни одна строка кода; принятый в
        -- репозитории приём (см. promoteReady и claimJob) выводит архивные
        -- из-под обработки сам, и здесь он повторён однородности ради. Как
        -- только архивация появится, этому случаю понадобится свой исход.
        WHERE p.status = 'provisioning' AND p.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND COALESCE((SELECT max(COALESCE(j.started_at, j.created_at))
                          FROM product_provision_jobs j WHERE j.product_id = p.id),
                       p.created_at) < now() - ${DEADLINE_SQL}
       RETURNING p.slug`,
    );

    const slugs = [...r.rows, ...silent.rows].map((x: any) => x.slug);
    if (slugs.length) {
      this.logger.warn(`провижининг просрочен: ${slugs.join(', ')}`);
    }
    return slugs.length;
  }
}
