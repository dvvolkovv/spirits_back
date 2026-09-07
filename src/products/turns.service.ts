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
}

export interface TurnRow {
  id: string;
  status: string;
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'reverted';

export interface CompleteInput {
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
    const p = await this.pg.query(
      `SELECT status FROM products WHERE id = $1 AND archived_at IS NULL`,
      [input.productId],
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
        `INSERT INTO product_turns (product_id, user_id, channel, prompt, status)
         VALUES ($1, $2, $3, $4, 'queued')
         RETURNING id, status`,
        [input.productId, input.userId, input.channel, input.prompt],
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
   * SKIP LOCKED: если раннер продукта по какой-то причине запущен в двух
   * экземплярах, второй не заблокируется на строке, а увидит пустую очередь.
   */
  async claimNext(productId: string): Promise<ClaimedTurn | null> {
    const r = await this.pg.query(
      `UPDATE product_turns
          SET status = 'running', started_at = now()
        WHERE id = (
          SELECT id FROM product_turns
           WHERE product_id = $1 AND status = 'queued'
           -- ORDER BY здесь страховка, а не работающая логика: частичный
           -- уникальный индекс из Task 1 не допускает больше одной строки в
           -- ('queued','running') на продукт, значит сортировать нечего.
           -- Строка остаётся на случай ослабления предиката индекса.
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        RETURNING id, prompt, channel, user_id`,
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
          SET status = $2, result = $3, error = $4,
              sha_before = COALESCE($5, sha_before),
              sha_after = $6,
              tokens_spent = $7,
              finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [
        turnId,
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
      const d = await this.pg.query(`SELECT status FROM product_turns WHERE id = $1`, [turnId]);
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
   * Откат оформляется обычным ходом со специальным prompt'ом: тот же путь
   * reset → build → restart → health на стороне раннера, та же строка в
   * истории. История остаётся линейной, откат отката работает без отдельного
   * кода. Замок product_turns_one_active работает и здесь — откатить посреди
   * живого хода нельзя.
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
      prompt: `__revert__:${target.sha_before}`,
    });
  }
}
