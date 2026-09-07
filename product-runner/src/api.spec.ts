import { LinkeonApi } from './api';

function makeApi(responder: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const fetchFn = jest.fn(async (url: string, init: any) => {
    calls.push({ url, init });
    return responder(url, init);
  });
  const api = new LinkeonApi(
    { linkeonUrl: 'https://test.linkeon.io', runnerToken: 'tok' } as any,
    fetchFn as any,
  );
  return { api, calls };
}

const ok = (body: any) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });

describe('LinkeonApi.poll', () => {
  it('ходит на маршрут раннера с Bearer-токеном', async () => {
    const { api, calls } = makeApi(() => ok({ turn: null, product: {} }));

    await api.poll();

    expect(calls[0].url).toBe('https://test.linkeon.io/webhook/products/runner/poll');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
  });

  it('сетевая ошибка не роняет раннера — возвращает null', async () => {
    const { api } = makeApi(() => {
      throw new Error('ECONNRESET');
    });

    await expect(api.poll()).resolves.toBeNull();
  });

  it('401 не роняет раннера', async () => {
    // json() намеренно возвращает валидное тело: без проверки res.ok код
    // молча принял бы тело ошибки за PollResult, и тест обязан ловить именно
    // это, а не полагаться на то, что res.json() вообще бросит исключение.
    const { api } = makeApi(() => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
      json: async () => ({ turn: null, product: {} }),
    }));

    await expect(api.poll()).resolves.toBeNull();
  });

  it('битый JSON в ответе не роняет раннера', async () => {
    // Прокси или страница ошибки могут вернуть 200 с HTML вместо JSON.
    const { api } = makeApi(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }));

    await expect(api.poll()).resolves.toBeNull();
  });
});

describe('LinkeonApi.sendEvents', () => {
  it('пустой пакет не отправляется', async () => {
    const { api, calls } = makeApi(() => ok({ ok: true }));

    await api.sendEvents('t-1', []);

    expect(calls).toHaveLength(0);
  });

  it('события уходят пакетом на маршрут своего хода', async () => {
    const { api, calls } = makeApi(() => ok({ ok: true }));

    await api.sendEvents('t-1', [{ type: 'begin' }, { type: 'item', content: 'x' }]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/turns/t-1/events');
    expect(JSON.parse(calls[0].init.body).events).toHaveLength(2);
  });

  it('отказ доставки виден вызывающему', async () => {
    // Раннер должен уметь вернуть события в буфер и досылать: ход при этом
    // не прерывается, агент уже работает.
    const { api } = makeApi(() => ({ ok: false, status: 502, text: async () => 'bad gateway' }));

    await expect(api.sendEvents('t-1', [{ type: 'begin' }])).resolves.toBe(false);
  });
});

describe('LinkeonApi.complete', () => {
  it('исход уходит на маршрут своего хода', async () => {
    const { api, calls } = makeApi(() => ok({ ok: true }));

    await api.complete('t-1', { status: 'done', tokens: 100 });

    expect(calls[0].url).toContain('/turns/t-1/complete');
    expect(JSON.parse(calls[0].init.body)).toMatchObject({ status: 'done', tokens: 100 });
  });

  it('сетевая ошибка не роняет раннера', async () => {
    const { api } = makeApi(() => {
      throw new Error('ETIMEDOUT');
    });

    await expect(api.complete('t-1', { status: 'done' })).resolves.toBe(false);
  });
});

describe('LinkeonApi — таймауты', () => {
  it(
    'повисший poll не блокирует раннера навсегда',
    async () => {
      // Мок, который никогда не отвечает сам — только по abort. Без таймаута
      // этот тест висел бы до срабатывания jest-таймаута, что и есть модель
      // реального отказа: процесс жив, цикл стоит.
      //
      // Важно: если signal вообще не передан (мутация, убирающая
      // withTimeout), промис НЕ бросает синхронно на addEventListener —
      // иначе catch-блок в poll() поймает эту случайную TypeError и вернёт
      // тот же null, что и при штатном abort, и тест зазеленеет по неверной
      // причине, не заметив пропажи таймаута вовсе. Вместо этого промис молча
      // никогда не разрешается, и при отсутствии signal тест сам виснет —
      // ловится собственным укороченным таймаутом теста (см. третий аргумент
      // it), а не подставным исключением.
      const fetchFn = jest.fn(
        (_url: string, init: any) =>
          new Promise((_resolve, reject) => {
            if (!init.signal) return;
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      const api = new LinkeonApi(
        { linkeonUrl: 'https://x', runnerToken: 'tok', pollTimeoutMs: 50 } as any,
        fetchFn as any,
      );

      await expect(api.poll()).resolves.toBeNull();
    },
    300,
  );

  it('запрос получает signal', async () => {
    const fetchFn = jest.fn(async (_url: string, _init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ turn: null, product: {} }),
    }));
    const api = new LinkeonApi({ linkeonUrl: 'https://x', runnerToken: 'tok' } as any, fetchFn as any);

    await api.poll();

    expect(fetchFn.mock.calls[0][1].signal).toBeDefined();
  });

  it('таймер снимается после успешного ответа', async () => {
    // Иначе каждый запрос оставляет висящий таймер: на длинном прогоне это
    // тысячи таймеров и процесс, который не завершается по SIGTERM.
    const spy = jest.spyOn(global, 'clearTimeout');
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ turn: null, product: {} }) }));
    const api = new LinkeonApi({ linkeonUrl: 'https://x', runnerToken: 'tok' } as any, fetchFn as any);

    await api.poll();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
