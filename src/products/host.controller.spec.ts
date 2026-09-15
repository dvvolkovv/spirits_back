import { HostController } from './host.controller';

/**
 * ГРАНИЦА ЭТОГО ФАЙЛА: поведение самого маршрута и ничего больше. Гварды,
 * адрес маршрута и разбор тела трубой валидации живут в
 * products.routes.spec.ts — здесь они НЕ проверяются, и `new HostController(…)`
 * остаётся зелёным при снятом гварде, забытой регистрации в модуле и выкинутом
 * DTO. Ровно поэтому сторожа тех трёх вещей вынесены в отдельный файл.
 */

// Задание в том виде, в каком его собирает claimJob. Токен и секреты внутри не
// декорация: другой доставки у них нет — открытый токен существует ровно один
// раз, в теле этого ответа.
const JOB = {
  jobId: 'j-1',
  productId: 'p-1',
  slug: 'selyanska',
  // Имя и слаг РАЗНЫЕ намеренно: в каркас продукта уезжает именно имя, и
  // маршрут, потерявший его по дороге, на совпадающих значениях был бы
  // неотличим от исправного.
  name: 'Селянська',
  kind: 'bot',
  runnerToken: 'a'.repeat(64),
  secrets: { BOT_TOKEN: '123:abc' },
};

function makeCtrl(over: any = {}) {
  const prov = {
    claimJob: jest.fn(async () => JOB),
    completeJob: jest.fn(async () => undefined),
    ...over,
  };
  return { ctrl: new HostController(prov as any), prov };
}

describe('HostController.poll', () => {
  it('отдаёт задание целиком — вместе с токеном и секретами', async () => {
    const { ctrl } = makeCtrl();

    const res = await ctrl.poll();

    // Точное равенство, а не toMatchObject: маршрут, пересобравший задание
    // явным списком полей (как это верно сделано у раннера), потерял бы здесь
    // secrets — и бот уехал бы в контейнер без токена, молча и с успешным
    // заведением. Задание собирает claimJob, а не строка базы, поэтому
    // пробрасывать его целиком здесь правильно.
    expect(res).toEqual({ job: JOB });
    expect(Object.keys(res)).toEqual(['job']);
  });

  it('пустая очередь отдаёт job: null, а не ошибку', async () => {
    const { ctrl } = makeCtrl({ claimJob: jest.fn(async () => null) });

    // Агент опрашивает нас в цикле: пустая очередь — обычное состояние, а не
    // отказ. 500 в этом месте заливал бы лог агента на каждом обороте.
    await expect(ctrl.poll()).resolves.toEqual({ job: null });
  });

  it('сорванная выдача не выглядит пустой очередью', async () => {
    const boom = new Error('база недоступна');
    const { ctrl } = makeCtrl({
      claimJob: jest.fn(async () => {
        throw boom;
      }),
    });

    // try/catch с `return { job: null }` здесь означал бы, что упавшая база
    // неотличима от «работы нет»: агент крутит опрос, задания стоят в очереди,
    // в логе пусто. Ошибка обязана долетать до агента.
    await expect(ctrl.poll()).rejects.toBe(boom);
  });
});

describe('HostController.complete', () => {
  it('передаёт порт и признак успеха', async () => {
    const { ctrl, prov } = makeCtrl();

    const res = await ctrl.complete('j-1', { ok: true, port: 8003 } as any);

    expect(prov.completeJob).toHaveBeenCalledWith('j-1', { ok: true, port: 8003 });
    expect(res).toEqual({ ok: true });
  });

  it('причина отказа доезжает до сервиса', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete('j-1', { ok: false, error: 'сборка контейнера не прошла' } as any);

    // Потерянная причина превращается в 'без причины' на карточке продукта:
    // completeJob подставляет её сам, когда error пуст. Владелец видит
    // сорванное заведение без единого слова о том, что случилось.
    expect(prov.completeJob).toHaveBeenCalledWith('j-1', {
      ok: false,
      error: 'сборка контейнера не прошла',
    });
  });

  it('длинная причина режется маршрутом, а не отбивается', async () => {
    const { ctrl, prov } = makeCtrl();
    const huge = 'docker build: '.padEnd(50_000, 'ы');

    await ctrl.complete('j-1', { ok: false, error: huge } as any);

    const sent = prov.completeJob.mock.calls[0][1].error;
    expect(sent).toHaveLength(2000);
    // Начало сохранено — именно там причина, а не в хвосте.
    expect(sent.startsWith('docker build: ')).toBe(true);
    // Хвост помечен: иначе по обрезанной строке не отличить «сообщение
    // кончилось» от «мы его срезали».
    expect(sent.endsWith('…')).toBe(true);
  });

  it('причина по границе потолка не трогается', async () => {
    const { ctrl, prov } = makeCtrl();
    const exact = 'э'.repeat(2000);

    await ctrl.complete('j-1', { ok: false, error: exact } as any);

    // Ровно на потолке подрезки быть не должно: иначе многоточие появляется у
    // сообщений, которые целы, и диагностика врёт в другую сторону.
    expect(prov.completeJob.mock.calls[0][1].error).toBe(exact);
  });

  it('лишние поля тела до сервиса не доезжают', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete('j-1', {
      ok: true,
      port: 8003,
      status: 'done',
      productId: 'p-999',
    } as any);

    // ValidationPipe поднят с whitelist: false, а class-transformer копирует на
    // экземпляр DTO и незнакомые поля — тело приезжает в маршрут КАК ЕСТЬ.
    // Поэтому параметры собираются явным списком, как в RunnerController.
    // Утверждение точное (не objectContaining): спред тела иначе проходит
    // зелёным.
    expect(prov.completeJob).toHaveBeenCalledWith('j-1', { ok: true, port: 8003 });
  });

  it('id задания берётся из URL, а не из тела', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete('j-1', { ok: true, jobId: 'j-999' } as any);

    expect(prov.completeJob.mock.calls[0][0]).toBe('j-1');
  });

  it('ok: true отдаётся только после того, как запись состоялась', async () => {
    // Потерянный `await` ловится ЗДЕСЬ, а не только проверкой ниже: без него
    // маршрут возвращается раньше, чем отработала запись. Отдельный тест
    // нужен потому, что проверка через reject роняет весь воркер jest
    // (неперехваченный отказ на Node 26 убивает процесс) — красным это,
    // конечно, будет, но без строки о том, ЧТО именно сломано.
    let written = false;
    const { ctrl } = makeCtrl({
      completeJob: jest.fn(async () => {
        await new Promise((r) => setImmediate(r));
        written = true;
      }),
    });

    const res = await ctrl.complete('j-1', { ok: true } as any);

    expect(written).toBe(true);
    expect(res).toEqual({ ok: true });
  });

  it('несостоявшаяся запись не превращается в ok: true', async () => {
    const boom = new Error('запись не прошла');
    // Отказ «прочитан» заранее СПЕЦИАЛЬНО: проглоченный маршрутом (`void` или
    // пустой catch) он иначе всплывает неперехваченным и на Node 26 убивает
    // воркер jest целиком — прогон краснеет, но без единой строки о том, что
    // сломано. С уже навешенным обработчиком тот же дефект краснит ИМЕННО
    // этот тест.
    const rejected = Promise.reject(boom);
    rejected.catch(() => undefined);
    const { ctrl } = makeCtrl({ completeJob: jest.fn(() => rejected) });

    // Агент, получивший { ok: true } на несостоявшейся записи, считает
    // задание закрытым и уходит — а задание висит в running до сборщика
    // зависших, то есть десять минут, и заканчивается чужой формулировкой про
    // срок.
    await expect(ctrl.complete('j-1', { ok: true } as any)).rejects.toBe(boom);
  });
});
