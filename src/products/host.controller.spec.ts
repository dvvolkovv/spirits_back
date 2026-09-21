import { NotFoundException } from '@nestjs/common';
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
// id задания — настоящий uuid: колонка uuid-овая, и маршрут отсекает мусор
// до запроса (см. assertUuid).
const J = '44444444-4444-4444-8444-444444444444';

const JOB = {
  jobId: J,
  productId: '77777777-7777-4777-8777-777777777777',
  slug: 'selyanska',
  // Имя и слаг РАЗНЫЕ намеренно: в каркас продукта уезжает именно имя, и
  // маршрут, потерявший его по дороге, на совпадающих значениях был бы
  // неотличим от исправного.
  name: 'Селянська',
  kind: 'bot',
  runnerToken: 'a'.repeat(64),
  secrets: { BOT_TOKEN: '123:abc' },
};

/**
 * Запрос в том виде, в каком его отдаёт HostGuard: метка машины лежит НА
 * ЗАПРОСЕ, потому что выведена из предъявленного токена (см. HostAgentRequest).
 */
const REQ = { hostId: 'own' };

function makeCtrl(over: any = {}) {
  const order: string[] = [];
  const prov = {
    claimJob: jest.fn(async () => {
      order.push('claimJob');
      return JOB;
    }),
    completeJob: jest.fn(async () => undefined),
    touchHostAgent: jest.fn(async () => {
      order.push('touchHostAgent');
    }),
    ...over,
  };
  return { ctrl: new HostController(prov as any), prov, order };
}

describe('HostController.poll', () => {
  it('отдаёт задание целиком — вместе с токеном и секретами', async () => {
    const { ctrl } = makeCtrl();

    const res = await ctrl.poll(REQ);

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
    await expect(ctrl.poll(REQ)).resolves.toEqual({ job: null });
  });

  it('опрос отмечает, что агент был на связи', async () => {
    // Без этой отметки сервер не отличает живого агента от мёртвого: владелец
    // десять минут смотрит на «Заводится…» и читает про истёкший срок, хотя
    // срок ни при чём — забирать задание было некому.
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll(REQ);

    expect(prov.touchHostAgent).toHaveBeenCalledTimes(1);
  });

  it('отметка ставится ТОЙ машине, что спросила', async () => {
    // Метка берётся ИЗ ЗАПРОСА, куда её положил гвард, — из того же места, что
    // и у выдачи. Отметка без метки (одна на всё) была бы отметкой о том, что
    // жив «агент вообще»: опрос одной машины поднимал бы её за обоих, и
    // кабинет объявлял бы живым мёртвого соседа.
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll({ hostId: 'clients' });

    expect(prov.touchHostAgent).toHaveBeenCalledWith('clients');
  });

  it('метка отметки и метка выдачи — ОДНА И ТА ЖЕ', async () => {
    // Разъехавшись, они дают самый неприятный вид лжи: задание уезжает на одну
    // машину, а живой числится другая. Сверяются фактические аргументы, а не
    // намерение.
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll({ hostId: 'clients' });

    expect(prov.touchHostAgent.mock.calls[0]).toEqual(prov.claimJob.mock.calls[0]);
  });

  it('пустая очередь — тоже визит агента', async () => {
    // Отметка о том, что агент ПРИХОДИЛ, не должна зависеть от того, нашлась
    // ли ему работа: заданий не бывает сутками, и отметка «по выдаче» стояла
    // бы всё это время — то есть тревога горела бы на исправной машине.
    const { ctrl, prov } = makeCtrl({ claimJob: jest.fn(async () => null) });

    await ctrl.poll(REQ);

    expect(prov.touchHostAgent).toHaveBeenCalledTimes(1);
  });

  it('отметка ставится ДО выдачи', async () => {
    const { ctrl, order } = makeCtrl();

    await ctrl.poll(REQ);

    // Порядок не косметика: отказ базы на выдаче иначе уносит с собой и
    // отметку, и кабинет показывает «агент не забирает задания» вместо
    // настоящей причины — то есть указывает чинить исправную машину.
    expect(order).toEqual(['touchHostAgent', 'claimJob']);
  });

  it('отметка дожидается записи, а не уезжает в фон', async () => {
    // `void this.provisioning.touchHostAgent()` проходит все проверки выше:
    // вызов состоялся, порядок соблюдён. А неперехваченный отказ из
    // незавершённого промиса на Node 26 убивает процесс — и агент, чинящий
    // отметку, ронял бы бэкенд.
    let written = false;
    const { ctrl } = makeCtrl({
      touchHostAgent: jest.fn(async () => {
        await new Promise((r) => setImmediate(r));
        written = true;
      }),
    });

    await ctrl.poll(REQ);

    expect(written).toBe(true);
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
    await expect(ctrl.poll(REQ)).rejects.toBe(boom);
  });

  it('метка машины доезжает из запроса до выдачи — и метка ТОЙ машины, что спросила', async () => {
    // Две разные метки в одном сценарии намеренно. С одной зелёным проходит
    // самая правдоподобная мутация — константа ('own') в маршруте: пока машина
    // была одна, она и была верным ответом, и заметили бы её только на второй.
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll({ hostId: 'own' });
    await ctrl.poll({ hostId: 'clients' });

    expect(prov.claimJob.mock.calls).toEqual([['own'], ['clients']]);
  });

  it('метка берётся из ЗАПРОСА, а не из тела', async () => {
    // Метку выводит гвард из предъявленного токена. Взятая из тела, она была бы
    // заявлением агента о себе: одна строчка в запросе — и агент машины
    // клиентов забирает задания владельца вместе с расшифрованными секретами
    // его продуктов.
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll({ hostId: 'own', body: { hostId: 'clients' }, query: { hostId: 'clients' } } as any);

    expect(prov.claimJob).toHaveBeenCalledWith('own');
  });

  it('метка не досочиняется маршрутом, когда её нет', async () => {
    // Гвард либо кладёт метку, либо не пускает вовсе, — но подстановка
    // умолчания здесь (`req.hostId ?? 'own'`) пережила бы снятый гвард и увела
    // бы задания на машину владельца молча. Наружу обязано уехать то, что на
    // запросе; отсутствие метки останавливает выдачу в claimJob (там же —
    // почему громко, а не пустой очередью).
    const { ctrl, prov } = makeCtrl();

    await ctrl.poll({} as any);

    expect(prov.claimJob).toHaveBeenCalledWith(undefined);
  });
});

describe('HostController — мусор в :id задания', () => {
  it('мусорный id не уезжает в запрос', async () => {
    // Мусорная строка в uuid-колонке даёт 22P02 — 500-ку вместо 404, плюс
    // строку в логе, выглядящую как поломка базы.
    const { ctrl, prov } = makeCtrl();

    for (const bad of ['не-uuid', '', '44444444-4444-4444-8444']) {
      await expect(ctrl.complete(bad, { ok: true } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(prov.completeJob).not.toHaveBeenCalled();
  });

  it('хороший, но неизвестный id остаётся законным путём', async () => {
    // Отдельно от предыдущего: отчёт по УЖЕ ЗАКРЫТОМУ заданию — это штатный
    // повтор после обрыва связи, и он обязан отвечать { ok: true }, а не 404.
    // Сторож, отбивающий всё подряд, сломал бы именно этот путь.
    const { ctrl, prov } = makeCtrl();
    const unknown = '66666666-6666-4666-8666-666666666666';

    await expect(ctrl.complete(unknown, { ok: true } as any)).resolves.toEqual({ ok: true });
    expect(prov.completeJob).toHaveBeenCalledWith(unknown, { ok: true, port: undefined, error: undefined });
  });
});

describe('HostController.complete', () => {
  it('передаёт порт и признак успеха', async () => {
    const { ctrl, prov } = makeCtrl();

    const res = await ctrl.complete(J, { ok: true, port: 8003 } as any);

    expect(prov.completeJob).toHaveBeenCalledWith(J, { ok: true, port: 8003 });
    expect(res).toEqual({ ok: true });
  });

  it('причина отказа доезжает до сервиса', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete(J, { ok: false, error: 'сборка контейнера не прошла' } as any);

    // Потерянная причина превращается в 'без причины' на карточке продукта:
    // completeJob подставляет её сам, когда error пуст. Владелец видит
    // сорванное заведение без единого слова о том, что случилось.
    expect(prov.completeJob).toHaveBeenCalledWith(J, {
      ok: false,
      error: 'сборка контейнера не прошла',
    });
  });

  it('длинная причина режется маршрутом, а не отбивается', async () => {
    const { ctrl, prov } = makeCtrl();
    const huge = 'docker build: '.padEnd(50_000, 'ы');

    await ctrl.complete(J, { ok: false, error: huge } as any);

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

    await ctrl.complete(J, { ok: false, error: exact } as any);

    // Ровно на потолке подрезки быть не должно: иначе многоточие появляется у
    // сообщений, которые целы, и диагностика врёт в другую сторону.
    expect(prov.completeJob.mock.calls[0][1].error).toBe(exact);
  });

  it('лишние поля тела до сервиса не доезжают', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete(J, {
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
    expect(prov.completeJob).toHaveBeenCalledWith(J, { ok: true, port: 8003 });
  });

  it('id задания берётся из URL, а не из тела', async () => {
    const { ctrl, prov } = makeCtrl();

    await ctrl.complete(J, { ok: true, jobId: '55555555-5555-4555-8555-555555555555' } as any);

    expect(prov.completeJob.mock.calls[0][0]).toBe(J);
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

    const res = await ctrl.complete(J, { ok: true } as any);

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
    await expect(ctrl.complete(J, { ok: true } as any)).rejects.toBe(boom);
  });
});
