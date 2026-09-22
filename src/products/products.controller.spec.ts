import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProductsController } from './products.controller';

function makeRes() {
  const chunks: string[] = [];
  return {
    chunks,
    setHeader: jest.fn(),
    write: jest.fn((s: string) => {
      chunks.push(s);
      return true;
    }),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

// Минимальный req: нужен только обработчик 'close', которым маршрут узнаёт
// об обрыве клиента.
function makeReq() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    on: (event: string, fn: () => void) => {
      (handlers[event] ??= []).push(fn);
    },
    fireClose: () => (handlers['close'] ?? []).forEach((fn) => fn()),
  };
}

function makeController(events: any[]) {
  const products = {
    list: jest.fn(async () => [{ id: P, name: 'selyanska' }]),
    getOwned: jest.fn(async () => ({ id: P, name: 'selyanska' })),
  };
  const turns = {
    enqueue: jest.fn(async () => ({ id: T })),
    history: jest.fn(async () => []),
    revert: jest.fn(async () => ({ id: 't-revert' })),
  };
  const turnEvents = {
    readEvents: jest.fn(async function* () {
      for (const e of events) yield e;
    }),
  };
  // create отдаёт НЕ только productId намеренно: заведение выпускает больше,
  // чем показывает, и маршрут обязан отбирать. Сегодня лишнего здесь нет, но
  // тест обязан краснеть на `return r`, а не ждать, пока лишнее появится.
  const provisioning = {
    create: jest.fn(async () => ({ productId: 'p-новый', runnerToken: 'ТОКЕН-РАННЕРА' })),
    retry: jest.fn(async () => undefined),
    hostAgentsLiveForUser: jest.fn(async () => true),
  };
  // Гашение отдаёт НЕ `{ ok: true }`: маршрут обязан пересказать
  // администратору, ЧТО именно нашлось по присланной строке (см. BlockResult).
  const blocks = {
    block: jest.fn(async () => ({
      id: P,
      slug: 'shop',
      wasStatus: 'running',
      by: 'домену',
      killedJobs: 0,
      killedTurns: 1,
    })),
    unblock: jest.fn(async () => ({ id: P, slug: 'shop', by: 'слагу', killedJobs: 1 })),
  };
  return {
    ctrl: new ProductsController(
      products as any,
      turns as any,
      turnEvents as any,
      provisioning as any,
      blocks as any,
    ),
    products,
    turns,
    turnEvents,
    provisioning,
    blocks,
  };
}

// id продукта и хода — НАСТОЯЩИЕ uuid: колонки uuid-овые, маршруты отсекают
// мусор до запроса (см. assertUuid), и фикстура вида 'p-1' проверяла бы путь,
// которого на проде не бывает.
const P = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const user = { userId: 'u-1' };

describe('ProductsController.chat', () => {
  it('отдаёт NDJSON тем же протоколом, что и чат с ассистентами', async () => {
    const { ctrl } = makeController([
      { type: 'begin' },
      { type: 'item', content: 'правлю футер' },
      { type: 'end' },
    ]);
    const res = makeRes();

    await ctrl.chat(user, P, { prompt: 'поправь футер' } as any, makeReq() as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    // Без этого nginx придержит чанки и стриминг превратится в один ответ в конце.
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    const lines = res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['begin', 'item', 'end']);
  });

  it('проверяет владение продуктом до постановки хода', async () => {
    const { ctrl, products, turns } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, P, { prompt: 'go' } as any, makeReq() as any, makeRes() as any);

    expect(products.getOwned).toHaveBeenCalledWith(P, 'u-1');
    expect(products.getOwned.mock.invocationCallOrder[0]).toBeLessThan(
      turns.enqueue.mock.invocationCallOrder[0],
    );
  });

  it('непринятое владение не ставит ход', async () => {
    // Проверка порядка через invocationCallOrder здесь недостаточна: она
    // фиксирует момент ОБРАЩЕНИЯ к getOwned, а не его завершения, поэтому
    // потеря `await` её не роняет — enqueue() был бы вызван «после» getOwned
    // текстуально, но не дождавшись его отказа.
    //
    // Этот тест проверяет саму гарантию: если владение не подтверждено,
    // enqueue не должен быть вызван вовсе.
    const { ctrl, products, turns } = makeController([]);
    products.getOwned.mockRejectedValue(new NotFoundException('Product not found'));

    await expect(
      ctrl.chat(user, P, { prompt: 'go' } as any, makeReq() as any, makeRes() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('читает поток по продукту и ходу, а не по одному ходу', async () => {
    // Ключ буфера содержит продукт — это и есть защита от чтения чужого
    // потока. Маршрут обязан передавать оба параметра.
    const { ctrl, turnEvents } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, P, { prompt: 'go' } as any, makeReq() as any, makeRes() as any);

    // Третий аргумент — предикат отмены (см. readEvents в
    // turn-events.service.ts); в этом тесте важны только первые два.
    expect(turnEvents.readEvents).toHaveBeenCalledWith(P, T, expect.any(Function));
  });

  it('revertToSha из тела запроса не доезжает до enqueue', async () => {
    // Контроллер обязан перечислять поля явно. Написанный как
    // `enqueue({ ...body, productId: id, userId })` он вернул бы дыру:
    // ValidationPipe стоит с whitelist: false и лишние поля из тела не
    // срезает, а признак отката — это право сбросить прод клиента на
    // произвольный коммит мимо всех проверок revert().
    const { ctrl, turns } = makeController([{ type: 'end' }]);

    await ctrl.chat(
      user,
      P,
      { prompt: 'go', revertToSha: 'deadbeef' } as any,
      makeReq() as any,
      makeRes() as any,
    );

    expect(turns.enqueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ revertToSha: expect.anything() }),
    );
  });

  it('обрыв клиента прекращает чтение потока', async () => {
    // ВАЖНО (отклонение от синхронного fireClose сразу после вызова chat()):
    // getOwned() и enqueue() внутри chat() — обе async-функции без внутренних
    // await, но `await` в самом chat() всё равно требует минимум один тик
    // микрозадач на каждую, чтобы продолжить выполнение. req.on('close', ...)
    // регистрируется только ПОСЛЕ обеих. Синхронный `req.fireClose()` сразу
    // после `ctrl.chat(...)` (как в первой версии этого теста) стабильно
    // ничего не обрывает — обработчик ещё не зарегистрирован, — и тест
    // одинаково "проходил" бы что с проверкой clientGone, что без неё.
    //
    // Вместо подсчёта тиков привязываем обрыв к наблюдаемому событию: клиент
    // исчезает сразу после получения первого чанка. Это не только надёжнее
    // (не зависит от числа await до регистрации обработчика), но и ближе к
    // реальности — соединение рвётся уже во время стрима, а не до его начала.
    const { ctrl } = makeController([
      { type: 'begin' },
      { type: 'item', content: 'первый' },
      { type: 'item', content: 'второй' },
      { type: 'end' },
    ]);
    const req = makeReq();
    const res = makeRes();
    res.write.mockImplementationOnce((s: string) => {
      res.chunks.push(s);
      req.fireClose();
      return true;
    });

    await ctrl.chat(user, P, { prompt: 'go' } as any, req as any, res as any);

    const types = res.chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    expect(types).toEqual(['begin']);
    // Обрыв не просто прекращает запись — res.end() тоже не должен звонить
    // в уже закрытый сокет.
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('ProductsController — привязка отмены', () => {
  it('обрыв клиента виден генератору, а не только внешней проверке', async () => {
    // Внешний `if (clientGone) break` работает, только пока идут события,
    // поэтому все тесты на обрыв проходят и с отвязанным предикатом:
    // подмена `() => clientGone` на `() => false` оставляла набор зелёным и
    // молча возвращала дыру. Заглушка ниже не отдаёт ничего — значит внешняя
    // проверка не сработает никогда, и связка держится только на предикате.
    const { ctrl, turnEvents } = makeController([]);
    let captured: (() => boolean) | undefined;
    turnEvents.readEvents = jest.fn((_p: any, _t: any, isCancelled: () => boolean) => {
      captured = isCancelled;
      return (async function* () {})();
    }) as any;

    const req = makeReq();
    await ctrl.chat(user, P, { prompt: 'go' } as any, req as any, makeRes() as any);
    req.fireClose();

    expect(captured).toBeDefined();
    expect(captured!()).toBe(true);
  });
});

describe('ProductsController.revert', () => {
  it('проверяет владение и ставит откат', async () => {
    const { ctrl, products, turns } = makeController([]);
    const res = makeRes();

    await ctrl.revert(user, P, T, res as any);

    expect(products.getOwned).toHaveBeenCalledWith(P, 'u-1');
    expect(turns.revert).toHaveBeenCalledWith({ productId: P, turnId: T, userId: 'u-1' });
  });
});

describe('ProductsController.create', () => {
  it('заводит продукт от имени владельца токена', async () => {
    const { ctrl, provisioning } = makeController([]);

    await ctrl.create(user, {
      name: 'Селянська',
      slug: 'selyanska',
      kind: 'site',
      secrets: { BOT_TOKEN: '123:abc' },
    } as any);

    expect(provisioning.create).toHaveBeenCalledWith({
      userId: 'u-1',
      name: 'Селянська',
      slug: 'selyanska',
      kind: 'site',
      secrets: { BOT_TOKEN: '123:abc' },
      // Признак администратора — часть каждого заведения, а не довесок: по
      // нему выбирается машина. Обычный пользователь — false, а не
      // отсутствие поля: `isAdmin` объявлен обязательным именно затем, чтобы
      // забытый признак был ошибкой типов, а не тихой маршрутизацией.
      isAdmin: false,
    });
  });

  it('владелец берётся из токена, а не из тела', async () => {
    // ValidationPipe стоит с whitelist: false, поэтому userId из тела доезжает
    // до маршрута. Спред тела в create() отдал бы любому авторизованному
    // пользователю право заводить продукты на чужой аккаунт — вместе с
    // расходом его токенов и чужим слагом в публичной зоне.
    const { ctrl, provisioning } = makeController([]);

    await ctrl.create(user, {
      name: 'Селянська',
      slug: 'selyanska',
      kind: 'site',
      userId: 'u-чужой',
    } as any);

    expect(provisioning.create).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }));
  });

  it('признак администратора берётся у гварда, а не из тела запроса', async () => {
    // Признак решает, на машины какой аудитории уедет продукт (кусок 4а).
    // ValidationPipe стоит с whitelist: false, поэтому `isAdmin` из тела
    // доезжает до маршрута насквозь — спред тела отдал бы любому желающему
    // право поставить свой продукт рядом с боевыми.
    const { ctrl, provisioning } = makeController([]);

    await ctrl.create({ userId: 'u-1', isAdmin: false } as any, {
      name: 'Сайт',
      slug: 'site-1',
      kind: 'site',
      isAdmin: true,
    } as any);

    expect(provisioning.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
  });

  it('признак администратора доезжает до заведения, когда он ЕСТЬ', async () => {
    // Обратная половина: реализация, зашившая false, прошла бы тест выше
    // зелёной и увела бы все продукты владельца на клиентские машины.
    const { ctrl, provisioning } = makeController([]);

    await ctrl.create({ userId: 'u-1', isAdmin: true } as any, {
      name: 'Сайт',
      slug: 'site-1',
      kind: 'site',
    } as any);

    expect(provisioning.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: true }));
  });

  it('правдоподобное не-true администратором не считается', async () => {
    // `user` здесь `any` — из JwtGuard он приходит с настоящим boolean, но
    // проверки типа на этом пути нет ни одной. Приведение к истинности сделало
    // бы админом строку 'false'. Любое не-true уводит продукт на клиентскую
    // машину, то есть в безопасную сторону.
    for (const bad of ['true', 'false', 1, {}, [], undefined]) {
      const { ctrl, provisioning } = makeController([]);

      await ctrl.create({ userId: 'u-1', isAdmin: bad } as any, {
        name: 'Сайт',
        slug: 'site-1',
        kind: 'site',
      } as any);

      expect(provisioning.create).toHaveBeenCalledWith(expect.objectContaining({ isAdmin: false }));
    }
  });

  it('продукт без секретов заводится с пустым набором, а не с undefined', async () => {
    // create перебирает Object.entries(secrets) и решает по длине, звать ли
    // шифрование. undefined там разбирается только потому, что внутри стоит
    // свой `?? {}` — маршрут не должен на это опираться.
    const { ctrl, provisioning } = makeController([]);

    await ctrl.create(user, { name: 'Сайт', slug: 'site-1', kind: 'site' } as any);

    expect(provisioning.create).toHaveBeenCalledWith(expect.objectContaining({ secrets: {} }));
  });

  it('токен раннера в браузер не уезжает', async () => {
    // Открытый токен раннера — ключ от чекаута продукта. Он нужен агенту
    // хоста, а не браузеру: `return r` отдал бы его в ответе и в логи прокси.
    const { ctrl } = makeController([]);

    const res = await ctrl.create(user, { name: 'Сайт', slug: 'site-1', kind: 'site' } as any);

    expect(res).toEqual({ id: 'p-новый' });
    // Не только «поле не то»: ключ мог бы приехать под другим именем или
    // вложенным.
    expect(JSON.stringify(res)).not.toContain('ТОКЕН-РАННЕРА');
    expect(Object.keys(res)).toEqual(['id']);
  });

  it('отказ заведения долетает до клиента, а не превращается в успех', async () => {
    const { ctrl, provisioning } = makeController([]);
    provisioning.create.mockRejectedValue(new ConflictException('слаг уже занят'));

    await expect(
      ctrl.create(user, { name: 'Сайт', slug: 'занят', kind: 'site' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ProductsController.retry', () => {
  it('повторяет заведение своего продукта', async () => {
    const { ctrl, provisioning } = makeController([]);

    const res = await ctrl.retry(user, P);

    // Оба аргумента точно: владелец — второй, и подмена его местами с id
    // прошла бы зелёной на любой проверке вида toHaveBeenCalled().
    expect(provisioning.retry).toHaveBeenCalledWith(P, 'u-1');
    expect(res).toEqual({ ok: true });
  });

  it('отказ повтора не превращается в ok: true', async () => {
    // Чужой продукт и продукт не в состоянии отказа сервис отбивает
    // NotFound-ом; проглоченный маршрутом, он стал бы «повторяем» на кнопке,
    // после которой ничего не происходит.
    const { ctrl, provisioning } = makeController([]);
    provisioning.retry.mockRejectedValue(new NotFoundException('продукт не найден'));
    const alien = '33333333-3333-4333-8333-333333333333';

    await expect(ctrl.retry(user, alien)).rejects.toBeInstanceOf(NotFoundException);
    // Чужой продукт обязан быть ВАЛИДНЫМ uuid: иначе отказ приходит от
    // assertUuid, сервис не зовётся вовсе, и тест зеленеет по соседней
    // причине, ничего не проверяя.
    expect(provisioning.retry).toHaveBeenCalledWith(alien, 'u-1');
  });
});

describe('ProductsController — мусор в :id', () => {
  const junk = ['не-uuid', '../../etc/passwd', "1 OR 1=1", '', '11111111-1111-4111-8111'];

  it('ни один клиентский маршрут не уносит мусорный id в базу', async () => {
    // uuid-колонка отбивает мусорную строку ошибкой 22P02, то есть 500-кой:
    // страница ошибки вместо честной 404 и строка в логе, выглядящая как
    // поломка базы. Образец приёма — src/speech/speech.controller.ts.
    for (const bad of junk) {
      const { ctrl, products, turns, provisioning } = makeController([]);

      await expect(ctrl.history(user, bad, makeRes() as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(
        ctrl.chat(user, bad, { prompt: 'go' } as any, makeReq() as any, makeRes() as any),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(ctrl.revert(user, bad, T, makeRes() as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(ctrl.retry(user, bad)).rejects.toBeInstanceOf(NotFoundException);

      // Отбой ДО запроса, а не после: иначе 404 приходит из базы, но 22P02
      // туда уже съездил.
      expect(products.getOwned).not.toHaveBeenCalled();
      expect(turns.history).not.toHaveBeenCalled();
      expect(turns.enqueue).not.toHaveBeenCalled();
      expect(turns.revert).not.toHaveBeenCalled();
      expect(provisioning.retry).not.toHaveBeenCalled();
    }
  });

  it('мусорный turnId в откате отбивается так же, как productId', async () => {
    // У revert параметров ДВА, и проверка только первого оставляла бы вторую
    // половину дыры открытой: turnId уезжает в такой же WHERE id = $1.
    const { ctrl, products, turns } = makeController([]);

    await expect(ctrl.revert(user, P, 'не-uuid', makeRes() as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(turns.revert).not.toHaveBeenCalled();
    // Владение тоже не спрашивается: отбой раньше.
    expect(products.getOwned).not.toHaveBeenCalled();
  });

  it('законный uuid проходит дальше', async () => {
    // Обратная сторона: сторож, отбивающий ВСЁ, прошёл бы все проверки выше.
    const { ctrl, provisioning } = makeController([]);

    await expect(ctrl.retry(user, P)).resolves.toEqual({ ok: true });
    expect(provisioning.retry).toHaveBeenCalledWith(P, 'u-1');
  });
});

describe('ProductsController.history', () => {
  it('чужой продукт не отдаёт историю', async () => {
    // Проверка порядка через invocationCallOrder здесь недостаточна: она
    // фиксирует момент ОБРАЩЕНИЯ к getOwned, а не его завершения, поэтому
    // потеря `await` её не роняет. А без await отказ всплывает уже после
    // того, как история прочитана и отдана.
    //
    // Этот тест проверяет саму гарантию: если владение не подтверждено,
    // history не должен быть вызван вовсе.
    const { ctrl, products, turns } = makeController([]);
    products.getOwned.mockRejectedValue(new NotFoundException('Product not found'));

    await expect(ctrl.history(user, P, makeRes() as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(turns.history).not.toHaveBeenCalled();
  });

  it('своя история читается с владельцем в запросе', async () => {
    const { ctrl, turns } = makeController([]);

    await ctrl.history(user, P, makeRes() as any);

    expect(turns.history).toHaveBeenCalledWith(P, 'u-1');
  });
});

describe('ProductsController.list', () => {
  it('тело остаётся массивом строк, а не конвертом', async () => {
    // Кабинет читает ответ массивом (`Array.isArray(rows) ? rows : null` в
    // productsApi.list) и на конверт отвечает «не удалось обновить список».
    // Статика и API катятся одним скриптом, но открытая вкладка живёт своей
    // жизнью сутками, поэтому конверт здесь — это сломанный кабинет у всех,
    // кто не перезагрузился.
    const { ctrl } = makeController([]);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(Array.isArray(res.json.mock.calls[0][0])).toBe(true);
    expect(res.json.mock.calls[0][0]).toEqual([{ id: P, name: 'selyanska' }]);
  });

  it('живой агент хоста виден в ответе', async () => {
    const { ctrl } = makeController([]);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('X-Host-Agent', 'live');
  });

  it('вердикт спрашивается про машины ВЛАДЕЛЬЦА ТОКЕНА', async () => {
    // С реестром «жив ли агент» и «дойдёт ли работа до МОЕЙ машины» — разные
    // вопросы. Вердикт, собранный по хостингу вообще, молчит ровно там, где
    // нужен: живой агент одной машины отвечает за мёртвого соседа, и продукт
    // на умершей машине висит «Заводится…» при зелёном индикаторе.
    const { ctrl, provisioning } = makeController([]);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(provisioning.hostAgentsLiveForUser).toHaveBeenCalledWith('u-1');
  });

  it('словарь заголовка — ровно live и silent', async () => {
    // Кабинет сверяет значение со списком известных и читает ЛЮБОЕ другое как
    // «сервер ничего не сказал», то есть ГАСИТ тревогу (productsApi.list).
    // Подробность вида `silent:clients` — это молчаливое выключение
    // предупреждения у всех, кто не перезагрузил вкладку.
    const { ctrl, provisioning } = makeController([]);

    for (const [live, expected] of [
      [true, 'live'],
      [false, 'silent'],
    ] as const) {
      provisioning.hostAgentsLiveForUser.mockResolvedValueOnce(live);
      const res = makeRes();
      await ctrl.list(user, res as any);
      const [, value] = res.setHeader.mock.calls.find(([h]: any[]) => h === 'X-Host-Agent')!;
      expect(value).toBe(expected);
    }
  });

  it('молчащий агент хоста виден в ответе', async () => {
    // Без этого владелец узнаёт о мёртвом агенте только через десять минут и
    // с неверной причиной — «срок заведения истёк».
    const { ctrl, provisioning } = makeController([]);
    provisioning.hostAgentsLiveForUser.mockResolvedValueOnce(false);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('X-Host-Agent', 'silent');
  });

  it('заголовок уходит раньше тела', async () => {
    // setHeader после res.json() в express бросает ERR_HTTP_HEADERS_SENT:
    // заголовки уже отправлены. Перестановка двух строк местами ломает
    // маршрут целиком, а не только вердикт.
    const { ctrl } = makeController([]);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(res.setHeader.mock.invocationCallOrder[0]).toBeLessThan(
      res.json.mock.invocationCallOrder[0],
    );
  });

  it('сорванная проверка агента не роняет список и не выдумывает тревогу', async () => {
    // Вердикт — приписка к ответу, а не сам ответ. 500 вместо списка продуктов
    // из-за недоступной отметки был бы платой большей, чем вся польза от неё,
    // а «агент молчит», выведенное из СВОЕГО отказа, отправило бы владельца
    // чинить исправную машину.
    const { ctrl, provisioning } = makeController([]);
    provisioning.hostAgentsLiveForUser.mockRejectedValueOnce(new Error('нет такой таблицы'));
    const res = makeRes();

    await expect(ctrl.list(user, res as any)).resolves.not.toThrow();

    expect(res.json).toHaveBeenCalledWith([{ id: P, name: 'selyanska' }]);
    expect(res.setHeader).toHaveBeenCalledWith('X-Host-Agent', 'live');
  });

  it('список спрашивается за владельца токена', async () => {
    const { ctrl, products } = makeController([]);
    const res = makeRes();

    await ctrl.list(user, res as any);

    expect(products.list).toHaveBeenCalledWith('u-1');
  });
});

/**
 * МАРШРУТЫ ГАШЕНИЯ.
 *
 * ЧЕГО ЭТОТ ФАЙЛ НЕ ПРОВЕРЯЕТ: гвардов. Здесь методы зовутся НАПРЯМУЮ, минуя
 * Nest, и `@UseGuards(AdminGuard)` не исполняется вовсе — снятый декоратор
 * оставит всё ниже зелёным. Второй рубеж сторожит products.routes.spec.ts по
 * метаданным, и это разделение намеренное: каждый из двух рубежей снимается
 * одной правкой, невидимой для прогона соседа.
 *
 * Здесь же — проверка в теле метода: откуда берётся признак администратора и
 * что считается истиной.
 */
describe('ProductsController.block / unblock', () => {
  const admin = { userId: 'u-админ', isAdmin: true };
  const KEY = { key: 'shop.p.linkeon.io', reason: 'мошенничество' };

  it('обычный пользователь не гасит, и сервис не зовётся вовсе', async () => {
    // «Не зовётся» — половина утверждения, без которой тест ничего не стоит:
    // отказ ПОСЛЕ вызова сервиса выглядел бы точно так же, а продукт был бы
    // уже погашен.
    const { ctrl, blocks } = makeController([]);

    await expect(ctrl.block({ userId: 'u-1', isAdmin: false }, KEY)).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(blocks.block).not.toHaveBeenCalled();
  });

  it('администратором делает ровно `true`, а не всё, что похоже на правду', async () => {
    // `user` здесь `any`: значение доезжает из JwtGuard без единой проверки
    // типа. Приведение к истинности сделало бы администратором СТРОКУ 'false'
    // — самую вероятную форму, в какой признак приезжает из чужого хранилища.
    const { ctrl, blocks } = makeController([]);

    for (const isAdmin of ['false', 'true', 1, {}, 'admin', null, undefined]) {
      await expect(ctrl.block({ userId: 'u-1', isAdmin } as any, KEY)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(ctrl.unblock({ userId: 'u-1', isAdmin } as any, KEY)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    }

    expect(blocks.block).not.toHaveBeenCalled();
    expect(blocks.unblock).not.toHaveBeenCalled();
  });

  it('пользователя нет вовсе — тоже отказ, а не падение', async () => {
    // Маршрут закрыт JwtGuard, то есть `undefined` сюда не приходит. Но цена
    // ошибки несимметрична: `user.isAdmin` на undefined — это TypeError, то
    // есть 500, и ровно в этом случае отказ обязан остаться отказом.
    const { ctrl } = makeController([]);

    await expect(ctrl.block(undefined as any, KEY)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('признак администратора В ТЕЛЕ не даёт ничего', async () => {
    // ValidationPipe стоит с `whitelist: false`, DTO у этого маршрута нет —
    // лишние поля тела доезжают до метода как есть. Спред тела или чтение
    // `body.isAdmin` здесь было бы правом погасить любой чужой продукт одной
    // строчкой в запросе.
    const { ctrl, blocks } = makeController([]);

    await expect(
      ctrl.block({ userId: 'u-1', isAdmin: false }, { ...KEY, isAdmin: true } as any),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(blocks.block).not.toHaveBeenCalled();
  });

  it('администратор гасит: ключ и причина уезжают в сервис в том же порядке', async () => {
    const { ctrl, blocks } = makeController([]);

    await ctrl.block(admin, KEY);

    // Переставленные местами аргументы дали бы отказ «не сказано, за что
    // гасим» на любом запросе — но только на живом сервере: здесь сервис
    // подменён и молча примет любой порядок.
    expect(blocks.block).toHaveBeenCalledWith('shop.p.linkeon.io', 'мошенничество');
  });

  it('ответ называет, ЧТО именно погашено, а не «ok»', async () => {
    // Искали по строке из жалобы. `{ ok: true }` не отвечает ни на один
    // вопрос администратора: какой продукт оказался под этим доменом, был ли
    // он вообще живым и не оборвал ли я кому-то идущую правку.
    const { ctrl } = makeController([]);

    const out: any = await ctrl.block(admin, KEY);

    expect(out).toMatchObject({
      slug: 'shop',
      by: 'домену',
      wasStatus: 'running',
      killedTurns: 1,
    });
    expect(out.ok).toBeUndefined();
  });

  it('снятие блокировки закрыто тем же рубежом и отвечает тем же', async () => {
    const { ctrl, blocks } = makeController([]);

    await expect(ctrl.unblock({ userId: 'u-1', isAdmin: false }, { key: 'shop' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(blocks.unblock).not.toHaveBeenCalled();

    await expect(ctrl.unblock(admin, { key: 'shop' })).resolves.toMatchObject({ slug: 'shop' });
    expect(blocks.unblock).toHaveBeenCalledWith('shop');
  });

  it('отказ в правах — 403, а не «не найден»', async () => {
    // Тот же код, которым отвечает AdminGuard: снаружи неразличимо, какой из
    // двух рубежей сработал, и это правильно — рубежи про одно и то же.
    // 404 здесь означал бы, что чужой продукт «не существует», то есть
    // превращал бы отказ в правах в подсказку о наличии продукта.
    const { ctrl } = makeController([]);

    const err: any = await ctrl.block({ userId: 'u-1' }, KEY).catch((e) => e);

    expect(err.getStatus()).toBe(403);
  });
});
