import { TurnEventsService } from './turn-events.service';

// Регрессия, потерявшая условие выхода из readEvents, не даёт осмысленного
// падения: генератор уходит в бесконечный поллинг с реальными setTimeout, и
// прогон виснет вместо красного assert'а. Низкий таймаут превращает зависание
// в быстрый понятный отказ.
jest.setTimeout(2000);

/**
 * `lrangeBatches` — ответы `lrange` по порядку вызовов (индекс = номер вызова,
 * последний элемент повторяется, если вызовов больше). Индексация по номеру
 * вызова, а не по переданным `start/stop`, — это осознанное упрощение мока:
 * оно не совпадает со строкой, которую проверяют утверждения (аргументы
 * вызова), поэтому не может «подсветить» мутацию за мок вместо кода сервиса.
 */
function makeService(
  opts: {
    lrangeBatches?: string[][];
    turnStatus?: string | null;
  } = {},
) {
  const redisCalls: { method: string; args: any[] }[] = [];
  const lrangeBatches = opts.lrangeBatches ?? [[]];
  let lrangeCallIndex = 0;
  const redis = {
    rpush: jest.fn(async (key: string, value: string) => {
      redisCalls.push({ method: 'rpush', args: [key, value] });
      return 1;
    }),
    expire: jest.fn(async (key: string, ttl: number) => {
      redisCalls.push({ method: 'expire', args: [key, ttl] });
    }),
    lrange: jest.fn(async (key: string, start: number, stop: number) => {
      redisCalls.push({ method: 'lrange', args: [key, start, stop] });
      const batch = lrangeBatches[Math.min(lrangeCallIndex, lrangeBatches.length - 1)];
      lrangeCallIndex++;
      return batch;
    }),
  };

  const pgCalls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (sql.includes('SELECT status FROM product_turns')) {
        return { rows: opts.turnStatus == null ? [] : [{ status: opts.turnStatus }] };
      }
      return { rows: [] };
    }),
  };

  return {
    svc: new TurnEventsService(pg as any, redis as any),
    redis,
    redisCalls,
    pgCalls,
  };
}

async function collect(gen: AsyncGenerator<any>) {
  const out: any[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('TurnEventsService.appendEvent', () => {
  it('пишет в ключ, который содержит и продукт, и ход', async () => {
    // Точная строка ключа, а не просто «вызвался rpush»: подмена
    // `turn:${turnId}:events` без продукта в ключе всё ещё «работает» на
    // одном продукте и ловится только здесь.
    const { svc, redis } = makeService();

    await svc.appendEvent('p-1', 't-1', { type: 'progress' });

    expect(redis.rpush).toHaveBeenCalledWith(
      'product:p-1:turn:t-1:events',
      JSON.stringify({ type: 'progress' }),
    );
  });

  it('ставит TTL в час на ключ событий', async () => {
    const { svc, redis } = makeService();

    await svc.appendEvent('p-1', 't-1', { type: 'progress' });

    expect(redis.expire).toHaveBeenCalledWith('product:p-1:turn:t-1:events', 3600);
  });
});

describe('TurnEventsService.readEvents', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('отдаёт накопленные события по порядку и завершается на end', async () => {
    const { svc, pgCalls } = makeService({
      lrangeBatches: [
        [
          JSON.stringify({ type: 'progress', n: 1 }),
          JSON.stringify({ type: 'progress', n: 2 }),
          JSON.stringify({ type: 'end' }),
        ],
      ],
    });

    const events = await collect(svc.readEvents('p-1', 't-1'));

    expect(events).toEqual([
      { type: 'progress', n: 1 },
      { type: 'progress', n: 2 },
      { type: 'end' },
    ]);
    // Завершение произошло по строке события `end`, а не по опросу статуса в
    // базе: до него дело не дошло вовсе.
    expect(pgCalls.length).toBe(0);
  });

  it('завершается на error, не дожидаясь статуса хода в базе', async () => {
    const { svc, pgCalls } = makeService({
      lrangeBatches: [
        [JSON.stringify({ type: 'progress', n: 1 }), JSON.stringify({ type: 'error', message: 'упал' })],
      ],
    });

    const events = await collect(svc.readEvents('p-1', 't-1'));

    expect(events).toEqual([{ type: 'progress', n: 1 }, { type: 'error', message: 'упал' }]);
    expect(pgCalls.length).toBe(0);
  });

  it('завершается, если ход в базе уже в терминальном статусе', async () => {
    // Раннер умер, не дописав финальное событие в Redis: без опроса базы
    // клиент повис бы навсегда на пустом списке событий.
    const { svc, pgCalls } = makeService({ lrangeBatches: [[]], turnStatus: 'done' });

    const events = await collect(svc.readEvents('p-1', 't-1'));

    expect(events).toEqual([{ type: 'end' }]);
    expect(pgCalls[0].sql).toContain('SELECT status FROM product_turns');
    expect(pgCalls[0].params).toEqual(['t-1']);
  });

  it('не завершается, пока ход running, и не перечитывает уже отданные события', async () => {
    jest.useFakeTimers();
    const key = 'product:p-1:turn:t-1:events';
    const { svc, redisCalls } = makeService({
      lrangeBatches: [[JSON.stringify({ type: 'progress', n: 1 })], [JSON.stringify({ type: 'end' })]],
      turnStatus: 'running',
    });

    const gen = svc.readEvents('p-1', 't-1');

    const r1 = await gen.next();
    expect(r1.value).toEqual({ type: 'progress', n: 1 });

    // На этом шаге генератор уже дошёл до `await sleep(500)` внутри опроса —
    // продвигаем фейковые таймеры вместо реального ожидания.
    const p2 = gen.next();
    await jest.advanceTimersByTimeAsync(500);
    const r2 = await p2;
    expect(r2.value).toEqual({ type: 'end' });

    const lrangeCalls = redisCalls.filter((c) => c.method === 'lrange');
    expect(lrangeCalls[0].args).toEqual([key, 0, -1]);
    // Курсор обязан сдвинуться на число уже отданных событий (1), иначе
    // второй опрос перечитает то же самое событие заново.
    expect(lrangeCalls[1].args).toEqual([key, 1, -1]);
  });
});
