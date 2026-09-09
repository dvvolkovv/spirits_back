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
   * Открытый runner-токен возвращается вызывающему один раз: в базе только
   * sha256, восстановить нечем.
   */
  async create(input: CreateInput): Promise<{ productId: string; runnerToken: string }> {
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
    const runnerToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(runnerToken).digest('hex');
    // NULL, а не коробка от {}: по нему задача 4 решает, звать ли decrypt.
    // decrypt(null) — сырой TypeError, поэтому признак «секретов нет» обязан
    // читаться до вызова.
    const box = Object.keys(input.secrets ?? {}).length
      ? this.secrets.encrypt(input.secrets, productId)
      : null;

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

    return { productId, runnerToken };
  }
}
