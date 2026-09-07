import { tick } from './index';

function makeDeps(over: any = {}) {
  const api = {
    poll: jest.fn(async () => null),
    complete: jest.fn(async () => true),
    ...over.api,
  };
  const executeTurn = over.executeTurn ?? jest.fn(async () => undefined);
  // Параметр типизирован явно: без него TS выводит сигнатуру из тела стрелочной
  // функции как `() => Promise<undefined>` (без аргументов), и `mock.calls[0][0]`
  // ниже не компилируется — пустой кортеж не имеет элемента с индексом 0.
  const sleep = jest.fn(async (_ms: number) => undefined);
  return { api, executeTurn, sleep, config: { pollIntervalMs: 3000 } as any, git: {} as any };
}

describe('tick', () => {
  it('нет связи — ждёт дольше обычного и не падает', async () => {
    // poll вернул null: либо сеть, либо Linkeon на деплое, либо токен отозван.
    // Раннер обязан пережить это молча — падение процесса означает, что
    // продукт клиента перестаёт обслуживаться до ручного вмешательства.
    const d = makeDeps({ api: { poll: jest.fn(async () => null) } });

    await expect(tick(d as any)).resolves.toBeUndefined();

    expect(d.sleep).toHaveBeenCalled();
    expect(d.sleep.mock.calls[0][0]).toBeGreaterThan(3000);
  });

  it('очередь пуста — обычная пауза', async () => {
    const d = makeDeps({ api: { poll: jest.fn(async () => ({ turn: null, product: {} })) } });

    await tick(d as any);

    expect(d.sleep).toHaveBeenCalledWith(3000);
    expect(d.executeTurn).not.toHaveBeenCalled();
  });

  it('есть задание — выполняет его и не спит', async () => {
    const turn = { id: 't-1', prompt: 'go', userId: 'u-1', revertToSha: null };
    const d = makeDeps({ api: { poll: jest.fn(async () => ({ turn, product: {} })) } });

    await tick(d as any);

    expect(d.executeTurn).toHaveBeenCalled();
    // Сразу за ходом — новый опрос, без паузы: клиент мог прислать следующий
    // запрос, пока агент работал.
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('падение хода не останавливает цикл и докладывается серверу', async () => {
    // Без этого продукт останется с ходом в running, и замок заблокирует его
    // до серверного сборщика зависших — полчаса «агент занят» на продукте,
    // где никто не работает.
    const turn = { id: 't-1', prompt: 'go', userId: 'u-1', revertToSha: null };
    const d = makeDeps({
      api: { poll: jest.fn(async () => ({ turn, product: {} })) },
      executeTurn: jest.fn(async () => {
        throw new Error('внезапно');
      }),
    });

    await expect(tick(d as any)).resolves.toBeUndefined();

    expect(d.api.complete).toHaveBeenCalledWith('t-1', expect.objectContaining({ status: 'failed' }));
  });

  it('провал доклада о падении тоже не роняет цикл', async () => {
    // Ход упал, и связи нет — оба отказа сразу. Сборщик на сервере всё равно
    // снимет ход, а раннер обязан продолжать работать.
    const turn = { id: 't-1', prompt: 'go', userId: 'u-1', revertToSha: null };
    const d = makeDeps({
      api: {
        poll: jest.fn(async () => ({ turn, product: {} })),
        complete: jest.fn(async () => {
          throw new Error('сеть');
        }),
      },
      executeTurn: jest.fn(async () => {
        throw new Error('внезапно');
      }),
    });

    await expect(tick(d as any)).resolves.toBeUndefined();
  });
});
