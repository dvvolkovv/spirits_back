import {
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
}
