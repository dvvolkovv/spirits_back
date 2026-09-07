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
