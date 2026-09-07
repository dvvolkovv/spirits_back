import { RunnerController } from './runner.controller';

function makeController(claimResult: any) {
  const turns = {
    claimNext: jest.fn(async () => claimResult),
    complete: jest.fn(async () => undefined),
    touchRunner: jest.fn(async () => undefined),
  };
  const turnEvents = {
    appendEvent: jest.fn(async () => undefined),
  };
  return { ctrl: new RunnerController(turns as any, turnEvents as any), turns, turnEvents };
}

// Фикстура повторяет то, что кладёт в запрос RunnerGuard — всю строку
// продукта. Именно поэтому маршрут обязан собирать ответ явным списком.
const req = (
  product: any = {
    id: 'p-1',
    user_id: 'u-1',
    checkout_path: '/srv/app',
    build_cmd: 'npm run build',
    restart_cmd: 'pm2 restart web',
    health_url: 'https://x/api/healthz',
    repo_url: null,
    claude_session_id: null,
  },
) => ({ product });

describe('RunnerController.poll', () => {
  it('отдаёт задание вместе с контекстом продукта', async () => {
    const { ctrl } = makeController({
      id: 't-1',
      prompt: 'поправь футер',
      user_id: 'u-1',
      revert_to_sha: null,
    });

    const res = await ctrl.poll(req() as any);

    expect(res).toMatchObject({
      turn: { id: 't-1', prompt: 'поправь футер' },
      product: { checkoutPath: '/srv/app' },
    });

    // Набор ключей проверяется точно, а не toMatchObject. Guard кладёт в
    // req.product всю строку продукта, включая user_id и claude_session_id;
    // маршрут, пробросивший её целиком или получивший новое поле в guard,
    // отдал бы раннеру лишнее — и этот тест это заметит.
    expect(Object.keys(res.product).sort()).toEqual(
      ['buildCmd', 'checkoutPath', 'claudeSessionId', 'healthUrl', 'repoUrl', 'restartCmd'].sort(),
    );
    expect(Object.keys(res.turn!).sort()).toEqual(['id', 'prompt', 'revertToSha', 'userId'].sort());
  });

  it('heartbeat пишется до выдачи задания, а не после', async () => {
    // Порядок наблюдаем, а не косметичен. Если продукт в degraded, touchRunner
    // возвращает его в running — и claimNext, отбирающий только по
    // p.status = 'running', выдаст ход в том же цикле. Обратный порядок отдал
    // бы turn: null, и работа поехала бы только следующим опросом.
    const { ctrl, turns } = makeController(null);

    await ctrl.poll(req() as any);

    expect(turns.touchRunner.mock.invocationCallOrder[0]).toBeLessThan(
      turns.claimNext.mock.invocationCallOrder[0],
    );
  });

  it('пустая очередь — turn: null, а не ошибка', async () => {
    const { ctrl } = makeController(null);

    await expect(ctrl.poll(req() as any)).resolves.toMatchObject({ turn: null });
  });

  it('каждый опрос обновляет heartbeat, даже когда заданий нет', async () => {
    const { ctrl, turns } = makeController(null);

    await ctrl.poll(req() as any);

    // Признак живости не должен зависеть от того, случился ли ход: алерт,
    // опирающийся на запись, которую не делает путь ошибки, залипает.
    expect(turns.touchRunner).toHaveBeenCalledWith('p-1');
  });
});

describe('RunnerController.complete', () => {
  it('передаёт исход хода в сервис', async () => {
    const { ctrl, turns } = makeController(null);

    await ctrl.complete(req() as any, 't-1', {
      status: 'done',
      result: 'готово',
      shaBefore: 'aaa',
      shaAfter: 'bbb',
      tokens: 1500,
    } as any);

    // productId берётся из req.product, а не из тела или URL: guard знает,
    // каким продуктом является раннер, но не то, что turnId принадлежит ему.
    expect(turns.complete).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'done', tokens: 1500, productId: 'p-1', userId: 'u-1' }),
    );
  });

  it('productId из тела запроса игнорируется', async () => {
    // Раннер продукта A не должен уметь адресоваться к продукту B, дописав
    // поле в тело. ValidationPipe стоит с whitelist: false и лишнее не срежет.
    const { ctrl, turns } = makeController(null);

    await ctrl.complete(req() as any, 't-1', { status: 'done', productId: 'p-999' } as any);

    expect(turns.complete).toHaveBeenCalledWith('t-1', expect.objectContaining({ productId: 'p-1' }));
  });
});

describe('RunnerController.events', () => {
  it('пишет события с продуктом из guard, а не из запроса', async () => {
    // Раннер продукта A не должен уметь адресоваться к чужому продукту,
    // подставив id в URL: ключ буфера обязан строиться по req.product.id.
    const { ctrl, turnEvents } = makeController(null);

    await ctrl.events(req() as any, 't-1', {
      events: [{ type: 'item', content: 'правлю футер' }, { type: 'end' }],
    } as any);

    expect(turnEvents.appendEvent).toHaveBeenNthCalledWith(1, 'p-1', 't-1', {
      type: 'item',
      content: 'правлю футер',
    });
    expect(turnEvents.appendEvent).toHaveBeenNthCalledWith(2, 'p-1', 't-1', { type: 'end' });
  });

  it('пустой список событий не падает', async () => {
    const { ctrl, turnEvents } = makeController(null);

    await expect(ctrl.events(req() as any, 't-1', {} as any)).resolves.toEqual({ ok: true });
    expect(turnEvents.appendEvent).not.toHaveBeenCalled();
  });
});
