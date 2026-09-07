import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { MiscService } from '../misc/misc.service';

export interface EnqueueInput {
  productId: string;
  userId: string;
  channel: 'web' | 'telegram';
  prompt: string;
  /** Только для служебного хода отката. Заполняется исключительно `revert()`. */
  revertToSha?: string;
}

export interface TurnRow {
  id: string;
  status: string;
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'reverted';

export interface CompleteInput {
  /**
   * Продукт, от имени которого пришёл раннер — всегда `req.product.id` из
   * `RunnerGuard`, никогда значение из запроса. Без этого ограничения раннер
   * продукта A завершил бы ход продукта B, передав его `turnId` в URL.
   */
  productId: string;
  userId: string;
  status: Extract<TurnStatus, 'done' | 'failed' | 'reverted'>;
  result?: string;
  error?: string;
  shaBefore?: string;
  shaAfter?: string;
  tokens?: number;
}

/**
 * Форма, которую `claimNext` отдаёт раннеру. Отличается от `TurnRow`: там
 * `{id, status}` для клиента, здесь всё, что нужно на VM для запуска хода.
 * Значение пересекает границу процесса, поэтому нетипизированным быть не
 * должно.
 */
export interface ClaimedTurn {
  id: string;
  prompt: string;
  channel: string;
  user_id: string;
  /** Непустое => это откат, и раннеру надо сбросить дерево на этот sha. */
  revert_to_sha: string | null;
}

@Injectable()
export class TurnsService {
  private readonly logger = new Logger(TurnsService.name);

  constructor(
    private readonly pg: PgService,
    private readonly misc: MiscService,
    private readonly redis: RedisService,
  ) {}

  async enqueue(input: EnqueueInput): Promise<TurnRow> {
    // Предусловия живут здесь, а не в контроллере, сознательно. Шлагбаум по
    // балансу в чате стоял только на одном входе, и второй — загрузка файлов —
    // про него забыл: до 06.09.2026 пользователь с нулём получал там самый
    // дорогой тип хода без ограничений (см. комментарий в chat.controller.ts).
    // У ходов входов тоже два, web и telegram, поэтому проверка ставится в
    // единственном общем месте.
    // Владение проверяется здесь же, а не только в контроллере, по той же
    // причине, что статус и баланс: у ходов два входа, web и telegram, и
    // будущий телеграм-вход унаследовал бы шлагбаум по балансу даром, а
    // проверку владения молча не получил. Условие в тот же запрос — бесплатно.
    const p = await this.pg.query(
      `SELECT status FROM products WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [input.productId, input.userId],
    );
    const productStatus = p.rows[0]?.status;
    if (!productStatus) throw new NotFoundException('Product not found');
    if (productStatus !== 'running') {
      throw new ConflictException('Продукт сейчас недоступен для правок');
    }

    // Порог тот же, что в чате с ассистентами: balance <= 0 запрещает ход.
    // Ход — это реальный запуск claude -p на VM, то есть живые деньги; при
    // нехватке deductTokens спишет сколько есть и запишет в лог «не хватило
    // баланса», то есть работа окажется выполнена и не оплачена.
    const { ok } = await this.misc.checkTokenBalance(input.userId, 1);
    if (!ok) {
      throw new HttpException('Недостаточно токенов', HttpStatus.PAYMENT_REQUIRED);
    }

    try {
      const r = await this.pg.query(
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, revert_to_sha, status)
         VALUES ($1, $2, $3, $4, $5, 'queued')
         RETURNING id, status`,
        [input.productId, input.userId, input.channel, input.prompt, input.revertToSha ?? null],
      );
      return r.rows[0];
    } catch (e: any) {
      // Только замок product_turns_one_active. Это не ошибка сервера: клиент
      // отправил второй запрос, пока агент ещё работает над первым.
      //
      // Условие обязано быть узким. Безусловный ConflictException превращает
      // падение базы, таймаут пула и нарушение CHECK в спокойное «агент занят»
      // без следа в логах: 4xx не попадает в отчёты об ошибках, и диагностика
      // уходит искать зависший ход, которого нет.
      if (e?.code === '23505') {
        throw new ConflictException('Агент уже работает над предыдущим запросом');
      }
      throw e;
    }
  }

  /**
   * Heartbeat раннера. Пишется на каждом опросе, независимо от наличия хода.
   *
   * Заодно снимает `degraded`. Этот статус ставит мониторинг, когда раннер
   * долго молчит, — и без обратного перехода он тупик: раннер оживёт, будет
   * слать heartbeat, а продукт останется навсегда «нет связи», причём
   * `claimNext` перестанет выдавать ему работу. Опрос и есть доказательство
   * живости, поэтому снимать признак должен он.
   *
   * Остальные статусы не трогаются: `stopped` и `archived` — решение
   * владельца, и heartbeat его не отменяет.
   */
  async touchRunner(productId: string) {
    await this.pg.query(
      `UPDATE products
          SET runner_seen_at = now(),
              status = CASE WHEN status = 'degraded' THEN 'running' ELSE status END
        WHERE id = $1`,
      [productId],
    );
  }

  /**
   * SKIP LOCKED: если раннер продукта по какой-то причине запущен в двух
   * экземплярах, второй не заблокируется на строке, а увидит пустую очередь.
   */
  async claimNext(productId: string): Promise<ClaimedTurn | null> {
    const r = await this.pg.query(
      `UPDATE product_turns
          SET status = 'running', started_at = now()
        WHERE id = (
          SELECT t.id FROM product_turns t
            -- Статус продукта проверяется ЗДЕСЬ, а не только в enqueue.
            -- Между постановкой хода и его забором проходит время: раннер мог
            -- лежать полчаса. Если за это время продукт перевели в stopped,
            -- выдавать по нему работу нельзя — агент будет править живой прод
            -- продукта, который считается выведенным из эксплуатации.
            JOIN products p ON p.id = t.product_id
           WHERE t.product_id = $1 AND t.status = 'queued'
             AND p.status = 'running' AND p.archived_at IS NULL
           -- ORDER BY здесь страховка, а не работающая логика: частичный
           -- уникальный индекс из Task 1 не допускает больше одной строки в
           -- ('queued','running') на продукт, значит сортировать нечего.
           -- Строка остаётся на случай ослабления предиката индекса.
           ORDER BY t.created_at
           -- OF t: блокируем только строку хода, не строку продукта.
           FOR UPDATE OF t SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, prompt, channel, user_id, revert_to_sha`,
      [productId],
    );
    return r.rows[0] ?? null;
  }

  /**
   * Тарифицируется только `done`. `failed` — работа не выполнена; `reverted` —
   * выполнена и тут же отменена автооткатом по health-check. В обоих случаях
   * клиент не получил результата и платить не должен. То же правило уже
   * действует при временном сбое связи с моделью в чате.
   */
  // `AND status = 'running'` делает финализацию переходом состояния, а не
  // перезаписью, и это обязательное условие, а не оптимизация.
  //
  // Маршрут завершения идёт с клиентской VM через интернет: таймаут чтения
  // ответа при успешно доставленном запросе — штатное событие, и раннер
  // обязан ретраить. Без сторожа повтор списывал бы токены второй раз за
  // тот же ход.
  //
  // Второй сценарий дороже: reapStuck (Task 10) переводит зависший ход в
  // `failed`, а опоздавший ответ раннера воскрешал бы его в `done` и брал
  // деньги за работу, за которую решили не брать.
  //
  // Транзакции здесь нет намеренно. `PgService.query` ходит через пул, а
  // `BEGIN` через пул на этом проекте уже давал код, рапортующий об откате,
  // которого не было. Сторож состояния даёт нужное свойство дешевле: повтор
  // становится безвредным no-op, а окно падения процесса превращается в
  // недобор («записано, но не списано»), а не в перебор. Недобор ловится
  // сверкой `tokens_spent` с `token_transactions`, перебор — только жалобой.
  async complete(turnId: string, input: CompleteInput) {
    const claimed = await this.pg.query(
      `UPDATE product_turns
          SET status = $3, result = $4, error = $5,
              sha_before = COALESCE($6, sha_before),
              sha_after = $7,
              tokens_spent = $8,
              finished_at = now()
        WHERE id = $1 AND product_id = $2 AND status = 'running'`,
      [
        turnId,
        // RunnerGuard подтверждает, каким продуктом является раннер, но не то,
        // что переданный в URL turnId принадлежит этому продукту. Без этого
        // условия раннер продукта A завершил бы ход продукта B и списал бы за
        // него с владельца A (userId здесь — это input.userId продукта A).
        input.productId,
        input.status,
        input.result ?? null,
        input.error ?? null,
        input.shaBefore ?? null,
        input.shaAfter ?? null,
        // Клампим: на колонке стоит CHECK (tokens_spent >= 0), а тело запроса
        // раннера типизировано TS-типом при ValidationPipe({whitelist:false}) —
        // рантайм-валидации нет. Раннер с tokens: -5 иначе получит 23514 наружу
        // необработанным 500, ход останется running, и мьютекс продержит продукт
        // до reapStuck через полчаса.
        input.status === 'done' ? Math.max(0, input.tokens ?? 0) : 0,
      ],
    );

    if (claimed.rowCount !== 1) {
      // Тихий успех для раннера здесь правильный — ретрай не должен получать
      // ошибку. Но в лог нужно писать то, что есть, а не догадку: `rowCount`
      // не единица наступает в трёх разных случаях, и только один из них
      // повтор. Битый `turnId` и ход, который раннер завершает не забрав,
      // означают сломанного раннера, получающего `{ok: true}` бесконечно.
      // `.catch` обязателен: эта ветка обслуживает штатный ретрай раннера и
      // бросать не имеет права. Без него кратковременный сбой базы превращает
      // повтор в 500, раннер повторяет, попадает туда же и получает 500 снова.
      // Диагностика не должна быть важнее того, что она диагностирует.
      const d = await this.pg
        .query(`SELECT status FROM product_turns WHERE id = $1`, [turnId])
        .catch(() => ({ rows: [] }) as any);
      const actual = d.rows[0]?.status;
      this.logger.warn(
        actual
          ? `complete: ход ${turnId} в статусе ${actual}, а не running — повтор проигнорирован`
          : `complete: ход ${turnId} не найден`,
      );
      return;
    }

    if (input.status === 'done' && (input.tokens ?? 0) > 0) {
      // deductTokens возвращает, сколько списалось ФАКТИЧЕСКИ — при нехватке
      // баланса меньше запрошенного, и её докблок прямо предлагает этим
      // числом воспользоваться. Пишем его обратно: иначе история в кабинете
      // покажет пользователю расход, которого с него не взяли.
      const used = await this.misc.deductTokens(
        input.userId,
        Math.max(0, input.tokens!),
        `product turn ${turnId}`,
      );
      if (used !== input.tokens) {
        await this.pg.query(`UPDATE product_turns SET tokens_spent = $2 WHERE id = $1`, [turnId, used]);
      }
    }
  }

  /**
   * Откат оформляется обычным ходом: тот же путь reset → build → restart →
   * health на стороне раннера, та же строка в истории. Признак отката несёт
   * отдельная колонка `revert_to_sha`, а не содержимое prompt — prompt здесь
   * человекочитаемый и годится для показа как есть. История остаётся
   * линейной, откат отката работает без отдельного кода. Замок
   * product_turns_one_active работает и здесь — откатить посреди живого хода
   * нельзя.
   */
  async revert(input: { productId: string; turnId: string; userId: string }) {
    const r = await this.pg.query(
      `SELECT id, sha_before FROM product_turns
        WHERE id = $1 AND product_id = $2`,
      [input.turnId, input.productId],
    );
    const target = r.rows[0];
    if (!target) throw new BadRequestException('Ход не найден');
    if (!target.sha_before) throw new BadRequestException('У этого хода нет точки возврата');

    return this.enqueue({
      productId: input.productId,
      userId: input.userId,
      channel: 'web',
      // prompt человекочитаемый и годится для показа в истории как есть.
      // Признак отката несёт отдельная колонка: строковый префикс внутри
      // prompt подделывался бы обычным запросом в чат — тот передаёт тело
      // пользователя в enqueue без разбора, а sha пользователь знает из
      // истории. Плюс префикс пришлось бы парсить раннеру из другого
      // репозитория, и расхождение прошло бы молча.
      prompt: `Откат к ${target.sha_before}`,
      revertToSha: target.sha_before,
    });
  }
}
