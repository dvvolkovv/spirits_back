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

  it('rpush происходит раньше expire', async () => {
    // Порядок важен: expire по ещё не существующему ключу — no-op. Переставь
    // вызовы местами, и первый же пакет событий останется без TTL навсегда —
    // ключ, легший до create-эффекта rpush, никогда не получит срок жизни.
    const { svc, redis } = makeService();

    await svc.appendEvent('p-1', 't-1', { type: 'progress' });

    expect(redis.rpush.mock.invocationCallOrder[0]).toBeLessThan(
      redis.expire.mock.invocationCallOrder[0],
    );
  });

  it('не кладёт в буфер то, что не является объектом', async () => {
    // Тело маршрута раннера — { events: any[] } без рантайм-валидации.
    // {"events":[null]} не должен долетать до rpush: иначе на чтении
    // event?.type сработает штатно (значение undefined), но JSON.stringify(null)
    // кладёт в буфер бессмысленную строку "null" вместо того, чтобы просто
    // ничего не писать.
    const { svc, redis } = makeService();

    await svc.appendEvent('p-1', 't-1', null);

    expect(redis.rpush).not.toHaveBeenCalled();
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

  it('отменяется в тихом потоке — без единого события в буфере', async () => {
    // Главный тест правки. Снаружи, в `for await` у вызывающего, isCancelled
    // бесполезен ровно в этом сценарии: пока событий нет, генератор не
    // доходит до yield, и проверять флаг некому. Если проверку внутри цикла
    // убрать и оставить только внешнюю (которой здесь и нет — она в
    // контроллере), генератор продолжит крутить lrange/pg/sleep до предела в
    // 1800 тиков, несмотря на отмену.
    jest.useFakeTimers();
    let calls = 0;
    // false в первый раз (даём тику начаться), true во все последующие —
    // моделирует «клиент отвалился между двумя опросами».
    const isCancelled = () => {
      calls++;
      return calls > 1;
    };
    const { svc, redisCalls } = makeService({ lrangeBatches: [[]], turnStatus: 'running' });

    const gen = svc.readEvents('p-1', 't-1', isCancelled);
    const result = gen.next();
    // Первый тик: isCancelled() -> false, lrange, pg, дошли до sleep(500) —
    // отдаём таймеру управление, чтобы генератор продолжил до второго тика,
    // где isCancelled() уже вернёт true.
    await jest.advanceTimersByTimeAsync(500);
    await expect(result).resolves.toEqual({ value: undefined, done: true });

    const lrangeCountAfterCancel = redisCalls.filter((c) => c.method === 'lrange').length;
    expect(lrangeCountAfterCancel).toBe(1);

    // Дальше отмотка времени не должна рождать новые обращения к Redis —
    // именно это увидел зонд ревьюера: число обращений росло и после обрыва.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(redisCalls.filter((c) => c.method === 'lrange').length).toBe(lrangeCountAfterCancel);
  });

  it('финальный дренаж: событие, дописанное между lrange и статусом, доходит до клиента', async () => {
    // lrange вызывается дважды: первый раз ловит одно событие обычным
    // опросом, второй (дренаж) — то, что раннер дописал уже после того, как
    // статус хода стал терминальным, но до второго обращения к буферу.
    const { svc } = makeService({
      lrangeBatches: [
        [JSON.stringify({ type: 'progress', n: 1 })],
        [JSON.stringify({ type: 'progress', n: 2 })],
      ],
      turnStatus: 'done',
    });

    const events = await collect(svc.readEvents('p-1', 't-1'));

    // Оба события обязаны дойти, и только потом end — без дренажа второе
    // событие пропало бы молча, а клиент увидел бы end с обрезанным хвостом.
    expect(events).toEqual([
      { type: 'progress', n: 1 },
      { type: 'progress', n: 2 },
      { type: 'end' },
    ]);
  });

  it('дренаж не дублирует end, если хвост уже содержит терминальное событие', async () => {
    // Зонд ревьюера: раннер дописал хвост с `end` между обычным lrange и
    // проверкой статуса — это не краевой случай, а штатное завершение потока
    // раннером. Без проверки внутри дренажа генератор отдал бы настоящий
    // `end` из хвоста и следом безусловно добавил бы синтетический — клиент
    // увидел бы `end` дважды, и обработчик завершения отработал бы дважды.
    //
    // Существующий тест на дренаж (выше) этого не ловит: там в хвосте два
    // `progress`, ни один не совпадает с `event?.type === 'end'`, поэтому
    // условие внутри дренажа для него безразлично.
    const { svc } = makeService({
      lrangeBatches: [
        [JSON.stringify({ type: 'item', content: 'правлю футер' })],
        [JSON.stringify({ type: 'end' })],
      ],
      turnStatus: 'done',
    });

    const events = await collect(svc.readEvents('p-1', 't-1'));

    const endCount = events.filter((e) => e.type === 'end').length;
    expect(endCount).toBe(1);
    expect(events).toEqual([{ type: 'item', content: 'правлю футер' }, { type: 'end' }]);
  });
});
