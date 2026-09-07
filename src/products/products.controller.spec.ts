import { NotFoundException } from '@nestjs/common';
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
    list: jest.fn(async () => [{ id: 'p-1', name: 'selyanska' }]),
    getOwned: jest.fn(async () => ({ id: 'p-1', name: 'selyanska' })),
  };
  const turns = {
    enqueue: jest.fn(async () => ({ id: 't-1' })),
    history: jest.fn(async () => []),
    revert: jest.fn(async () => ({ id: 't-revert' })),
  };
  const turnEvents = {
    readEvents: jest.fn(async function* () {
      for (const e of events) yield e;
    }),
  };
  return {
    ctrl: new ProductsController(products as any, turns as any, turnEvents as any),
    products,
    turns,
    turnEvents,
  };
}

const user = { userId: 'u-1' };

describe('ProductsController.chat', () => {
  it('отдаёт NDJSON тем же протоколом, что и чат с ассистентами', async () => {
    const { ctrl } = makeController([
      { type: 'begin' },
      { type: 'item', content: 'правлю футер' },
      { type: 'end' },
    ]);
    const res = makeRes();

    await ctrl.chat(user, 'p-1', { prompt: 'поправь футер' } as any, makeReq() as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    // Без этого nginx придержит чанки и стриминг превратится в один ответ в конце.
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    const lines = res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['begin', 'item', 'end']);
  });

  it('проверяет владение продуктом до постановки хода', async () => {
    const { ctrl, products, turns } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, 'p-1', { prompt: 'go' } as any, makeReq() as any, makeRes() as any);

    expect(products.getOwned).toHaveBeenCalledWith('p-1', 'u-1');
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
      ctrl.chat(user, 'p-1', { prompt: 'go' } as any, makeReq() as any, makeRes() as any),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(turns.enqueue).not.toHaveBeenCalled();
  });

  it('читает поток по продукту и ходу, а не по одному ходу', async () => {
    // Ключ буфера содержит продукт — это и есть защита от чтения чужого
    // потока. Маршрут обязан передавать оба параметра.
    const { ctrl, turnEvents } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, 'p-1', { prompt: 'go' } as any, makeReq() as any, makeRes() as any);

    // Третий аргумент — предикат отмены (см. readEvents в
    // turn-events.service.ts); в этом тесте важны только первые два.
    expect(turnEvents.readEvents).toHaveBeenCalledWith('p-1', 't-1', expect.any(Function));
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
      'p-1',
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

    await ctrl.chat(user, 'p-1', { prompt: 'go' } as any, req as any, res as any);

    const types = res.chunks.join('').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    expect(types).toEqual(['begin']);
    // Обрыв не просто прекращает запись — res.end() тоже не должен звонить
    // в уже закрытый сокет.
    expect(res.end).not.toHaveBeenCalled();
  });
});

describe('ProductsController.revert', () => {
  it('проверяет владение и ставит откат', async () => {
    const { ctrl, products, turns } = makeController([]);
    const res = makeRes();

    await ctrl.revert(user, 'p-1', 't-1', res as any);

    expect(products.getOwned).toHaveBeenCalledWith('p-1', 'u-1');
    expect(turns.revert).toHaveBeenCalledWith({ productId: 'p-1', turnId: 't-1', userId: 'u-1' });
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

    await expect(ctrl.history(user, 'p-1', makeRes() as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(turns.history).not.toHaveBeenCalled();
  });

  it('своя история читается с владельцем в запросе', async () => {
    const { ctrl, turns } = makeController([]);

    await ctrl.history(user, 'p-1', makeRes() as any);

    expect(turns.history).toHaveBeenCalledWith('p-1', 'u-1');
  });
});
