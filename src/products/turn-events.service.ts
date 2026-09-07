import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';

/**
 * Буфер событий хода. Отдельный сервис, а не метод `TurnsService`: это
 * единственный потребитель Redis, и продуктовый ключ сделал его
 * самодостаточным — ни один метод жизненного цикла хода ему не нужен.
 */
@Injectable()
export class TurnEventsService {
  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Продукт в ключе — это ограничение по конструкции, а не проверка.
   *
   * Клиент дочитывает поток по своему маршруту и составляет ключ из своих же
   * параметров, поэтому до чужого хода не дотянется в принципе. Раннер,
   * пославший события не в тот ход, пишет в ключ, который никто не читает.
   * Проверять нечего и забыть нечего — в отличие от варианта с явной
   * проверкой принадлежности на каждом маршруте.
   */
  private eventsKey(productId: string, turnId: string) {
    return `product:${productId}:turn:${turnId}:events`;
  }

  /** Раннер шлёт сюда события хода; живут час — этого хватает на дочитывание. */
  async appendEvent(productId: string, turnId: string, event: any) {
    // Тело маршрута раннера типизировано TS-типом при ValidationPipe с
    // whitelist: false — рантайм-проверки нет. `{"events":[null]}` положил бы
    // в буфер строку "null", а на чтении `event.type` дал бы TypeError уже
    // ПОСЛЕ отправки заголовков: клиент увидел бы обрыв сокета без события
    // error. Отбрасываем то, что событием быть не может.
    if (!event || typeof event !== 'object') return;
    const key = this.eventsKey(productId, turnId);
    await this.redis.rpush(key, JSON.stringify(event));
    await this.redis.expire(key, 3600);
  }

  /**
   * Читает события хода по мере поступления. Завершается на `end` или `error`,
   * либо когда ход в базе уже не `queued`/`running` — иначе клиент повиснет
   * навсегда, если раннер умер, не дописав финальное событие.
   *
   * `isCancelled` — необязательный признак отмены клиентом. Опрашивается
   * ВНУТРИ цикла, а не только снаружи в `for await` у вызывающего. Снаружи он
   * бесполезен ровно в том случае, ради которого нужен: пока событий нет,
   * генератор не доходит до yield, управление вызывающему не возвращается, и
   * проверять флаг некому. А клиент чаще всего отваливается именно в тишине —
   * агент думает, ответа нет минуту, пользователь закрывает вкладку.
   * Брошенное соединение иначе стоит до 1800 тиков по паре запросов, то есть
   * тысяч обращений к Redis и Postgres, и всё это время занят воркер.
   */
  async *readEvents(
    productId: string,
    turnId: string,
    isCancelled: () => boolean = () => false,
  ): AsyncGenerator<any> {
    const key = this.eventsKey(productId, turnId);
    let cursor = 0;
    for (let tick = 0; tick < 1800; tick++) {
      if (isCancelled()) return;
      const batch = await this.redis.lrange(key, cursor, -1);
      for (const raw of batch) {
        cursor++;
        const event = JSON.parse(raw);
        yield event;
        if (event?.type === 'end' || event?.type === 'error') return;
      }
      const r = await this.pg.query(`SELECT status FROM product_turns WHERE id = $1`, [turnId]);
      const status = r.rows[0]?.status;
      if (status && status !== 'queued' && status !== 'running') {
        // Финальный дренаж перед выходом. События, дописанные между lrange
        // выше и этим запросом, иначе не прочитаются никогда: генератор
        // завершится, не заглянув в буфер повторно, и клиент получит `end` с
        // обрезанным хвостом.
        for (const raw of await this.redis.lrange(key, cursor, -1)) {
          cursor++;
          const event = JSON.parse(raw);
          yield event;
          // Своего `end` достаточно. Без этой проверки дренаж отдаёт хвост и
          // следом добавляет синтетический `end` — а хвост, ради которого он
          // написан, это последние события раннера, который завершает поток
          // именно `end`. То есть штатное срабатывание давало бы дубль
          // терминального события, и обработчик завершения на клиенте
          // отрабатывал бы дважды.
          if (event?.type === 'end' || event?.type === 'error') return;
        }
        yield { type: 'end' };
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    yield { type: 'error', message: 'Ход не завершился за отведённое время' };
  }
}
