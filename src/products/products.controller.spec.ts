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

    await ctrl.chat(user, 'p-1', { prompt: 'поправь футер' } as any, res as any);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
    // Без этого nginx придержит чанки и стриминг превратится в один ответ в конце.
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    const lines = res.chunks.join('').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['begin', 'item', 'end']);
  });

  it('проверяет владение продуктом до постановки хода', async () => {
    const { ctrl, products, turns } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, 'p-1', { prompt: 'go' } as any, makeRes() as any);

    expect(products.getOwned).toHaveBeenCalledWith('p-1', 'u-1');
    expect(products.getOwned.mock.invocationCallOrder[0]).toBeLessThan(
      turns.enqueue.mock.invocationCallOrder[0],
    );
  });

  it('читает поток по продукту и ходу, а не по одному ходу', async () => {
    // Ключ буфера содержит продукт — это и есть защита от чтения чужого
    // потока. Маршрут обязан передавать оба параметра.
    const { ctrl, turnEvents } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, 'p-1', { prompt: 'go' } as any, makeRes() as any);

    expect(turnEvents.readEvents).toHaveBeenCalledWith('p-1', 't-1');
  });

  it('revertToSha из тела запроса не доезжает до enqueue', async () => {
    // Контроллер обязан перечислять поля явно. Написанный как
    // `enqueue({ ...body, productId: id, userId })` он вернул бы дыру:
    // ValidationPipe стоит с whitelist: false и лишние поля из тела не
    // срезает, а признак отката — это право сбросить прод клиента на
    // произвольный коммит мимо всех проверок revert().
    const { ctrl, turns } = makeController([{ type: 'end' }]);

    await ctrl.chat(user, 'p-1', { prompt: 'go', revertToSha: 'deadbeef' } as any, makeRes() as any);

    expect(turns.enqueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ revertToSha: expect.anything() }),
    );
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
  it('проверяет владение до чтения истории', async () => {
    const { ctrl, products, turns } = makeController([]);

    await ctrl.history(user, 'p-1', makeRes() as any);

    expect(products.getOwned).toHaveBeenCalledWith('p-1', 'u-1');
    expect(products.getOwned.mock.invocationCallOrder[0]).toBeLessThan(
      turns.history.mock.invocationCallOrder[0],
    );
  });
});
