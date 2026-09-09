import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
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

@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly pg: PgService,
    private readonly secrets: SecretsService,
  ) {}

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
   * двоим, иначе два развёртывания пойдут в один каталог.
   */
  async claimJob(): Promise<ClaimedJob | null> {
    const r = await this.pg.query(
      `UPDATE product_provision_jobs j
          SET status = 'running', started_at = now()
        WHERE j.id = (
          SELECT id FROM product_provision_jobs
           WHERE status = 'queued'
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
      RETURNING j.id, j.product_id,
                (SELECT slug FROM products WHERE id = j.product_id) AS slug,
                (SELECT kind FROM products WHERE id = j.product_id) AS kind,
                (SELECT secrets_encrypted FROM products WHERE id = j.product_id) AS box`,
    );
    const row = r.rows[0];
    // Пустая очередь — обычное состояние: агент опрашивает нас в цикле.
    // Ничего не выпускаем и в базу больше не ходим: холостой перевыпуск
    // runner_token_hash отобрал бы доступ у раннера, ничего не записав в лог.
    if (!row) return null;

    // Новый токен на каждое задание. Старый невосстановим — в базе только
    // sha256, открытое значение отдавалось агенту один раз.
    const runnerToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(runnerToken).digest('hex');
    await this.pg.query(`UPDATE products SET runner_token_hash = $2 WHERE id = $1`, [
      row.product_id,
      hash,
    ]);

    return {
      jobId: row.id,
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
   */
  async completeJob(jobId: string, result: { ok: boolean; port?: number; error?: string }) {
    if (result.ok) {
      await this.pg.query(
        `UPDATE product_provision_jobs SET status = 'done', finished_at = now() WHERE id = $1`,
        [jobId],
      );
      // Статус продукта здесь НЕ меняется. Перевод в running делает
      // promoteReady по измеримому факту (задача 5): отчёт агента говорит
      // «я развернул», а не «оно отвечает».
      await this.pg.query(
        `UPDATE products SET port = $2
          WHERE id = (SELECT product_id FROM product_provision_jobs WHERE id = $1)`,
        [jobId, result.port ?? null],
      );
      return;
    }
    await this.pg.query(
      `UPDATE product_provision_jobs SET status = 'failed', error = $2, finished_at = now()
        WHERE id = $1`,
      [jobId, result.error ?? 'без причины'],
    );
    // Порт здесь не трогается намеренно: неудачная ПОВТОРНАЯ попытка снесла бы
    // порт уже работавшего продукта, а хранится он только тут.
    await this.pg.query(
      `UPDATE products SET status = 'failed', provision_error = $2
        WHERE id = (SELECT product_id FROM product_provision_jobs WHERE id = $1)`,
      [jobId, result.error ?? 'без причины'],
    );
  }
}
