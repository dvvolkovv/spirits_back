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
// обязателен: на дефолтах undici чёрная дыра держит соединение дольше, чем
// длится оборот таймера, и следующий оборот наезжает на предыдущий.
const PROBE_TIMEOUT_MS = 5000;

@Injectable()
export class ProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProvisioningService.name);
  private promoter?: NodeJS.Timeout;

  /** Подменяется в тестах. */
  private fetchFn: typeof fetch = (...args) => fetch(...args);

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
      this.promoteReady().catch((e) => this.logger.error(`promoteReady failed: ${e.message}`));
      this.failStaleProvisioning().catch((e) =>
        this.logger.error(`failStaleProvisioning failed: ${e.message}`),
      );
    }, 30 * 1000);
    // unref, иначе таймер держит процесс и jest не завершается.
    this.promoter.unref();
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
   */
  async completeJob(jobId: string, result: { ok: boolean; port?: number; error?: string }) {
    if (result.ok) {
      const closed = await this.pg.query(
        `UPDATE product_provision_jobs SET status = 'done', finished_at = now()
          WHERE id = $1 AND status = 'running'`,
        [jobId],
      );
      if (!closed.rowCount) {
        this.logger.warn(`отчёт об успехе по незапущенному заданию ${jobId} — продукт не тронут`);
        return;
      }
      // Статус продукта здесь НЕ меняется. Перевод в running делает
      // promoteReady по измеримому факту (задача 5): отчёт агента говорит
      // «я развернул», а не «оно отвечает».
      //
      // COALESCE, а не голое присваивание: отчёт об успехе без порта (бот его
      // не публикует) снёс бы порт уже работающего сайта. Хранится он только
      // здесь — восстановить неоткуда.
      await this.pg.query(
        `UPDATE products SET port = COALESCE($2, port)
          WHERE id = (SELECT product_id FROM product_provision_jobs WHERE id = $1)`,
        [jobId, result.port ?? null],
      );
      return;
    }
    const closed = await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [jobId, result.error ?? 'без причины'],
    );
    if (!closed.rowCount) {
      this.logger.warn(`отчёт об отказе по незапущенному заданию ${jobId} — продукт не тронут`);
      return;
    }
    // Порт здесь не трогается намеренно: неудачная ПОВТОРНАЯ попытка снесла бы
    // порт уже работавшего продукта, а хранится он только тут.
    await this.pg.query(
      `UPDATE products SET status = 'failed', provision_error = $2
        WHERE id = (SELECT product_id FROM product_provision_jobs WHERE id = $1)`,
      [jobId, result.error ?? 'без причины'],
    );
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
      // running был бы витриной без начинки.
      if (!p.runner_seen_at) continue;
      try {
        if (p.kind === 'site' && !(await this.answers(p.slug))) continue;
        await this.pg.query(
          `UPDATE products SET status = 'running', provision_error = NULL WHERE id = $1`,
          [p.id],
        );
        promoted++;
      } catch (e: any) {
        // Именно по продукту, а не на весь оборот: один битый продукт иначе
        // запирает в provisioning всю очередь — та самая форма молчаливого
        // тупика, ради выхода из которой метод и написан.
        this.logger.error(`продукт ${p.slug}: перевод в running сорвался (${e.message})`);
      }
    }
    return promoted;
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
                error = 'заведение не уложилось в 10 минут',
                finished_at = now()
          WHERE status IN ('queued','running')
            AND COALESCE(started_at, created_at) < now() - interval '10 minutes'
         RETURNING product_id)
       UPDATE products p
          SET status = 'failed',
              provision_error = 'заведение не уложилось в 10 минут'
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
              provision_error = 'заведение не уложилось в 10 минут: задание закрыто, продукт не ожил'
        WHERE p.status = 'provisioning' AND p.archived_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM product_provision_jobs j
                           WHERE j.product_id = p.id AND j.status IN ('queued','running'))
          AND COALESCE((SELECT max(COALESCE(j.started_at, j.created_at))
                          FROM product_provision_jobs j WHERE j.product_id = p.id),
                       p.created_at) < now() - interval '10 minutes'
       RETURNING p.slug`,
    );

    const slugs = [...r.rows, ...silent.rows].map((x: any) => x.slug);
    if (slugs.length) {
      this.logger.warn(`провижининг просрочен: ${slugs.join(', ')}`);
    }
    return slugs.length;
  }
}
