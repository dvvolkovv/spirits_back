import { checkHealth, deploy, waitHealthy } from './deploy';

function response(init: { status: number; contentType: string; body: string }) {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? init.contentType : null) },
    text: async () => init.body,
  } as any;
}

describe('checkHealth', () => {
  it('здоров при JSON-ответе 200', async () => {
    const fetchFn = jest.fn(async () => response({ status: 200, contentType: 'application/json', body: '{"ok":true}' }));

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(true);
  });

  it('SPA-фолбэк с кодом 200 и HTML считается НЕздоровым', async () => {
    // На доменах проекта nginx отдаёт index.html с кодом 200 на любой путь,
    // включая несуществующий. Проверка по коду ответа всегда зелёная и потому
    // бесполезна — именно этот случай ловит тест.
    const fetchFn = jest.fn(async () =>
      response({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><div id="root">' }),
    );

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(false);
  });

  it('HTML по content-type нездоров даже без doctype в теле', async () => {
    // Изолирует проверку заголовка. В общем тесте про SPA-фолбэк ответ
    // одновременно и text/html, и с doctype — там любая из двух защит ловит
    // случай в одиночку, поэтому снятие любой из них проходило незамеченным.
    const fetchFn = jest.fn(async () =>
      response({ status: 200, contentType: 'text/html; charset=utf-8', body: '<div>root</div>' }),
    );

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(false);
  });

  it('doctype в теле нездоров даже при честном content-type', async () => {
    // Изолирует проверку тела: заголовок может соврать, а страница-заглушка
    // прийти под application/json.
    const fetchFn = jest.fn(async () =>
      response({ status: 200, contentType: 'application/json', body: '<!doctype html><div id="root">' }),
    );

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(false);
  });

  it('5xx — нездоров', async () => {
    const fetchFn = jest.fn(async () => response({ status: 502, contentType: 'text/plain', body: 'bad gateway' }));

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(false);
  });

  it('сеть упала — нездоров, а не исключение наружу', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(checkHealth('https://x/api/healthz', fetchFn as any)).resolves.toBe(false);
  });

  it('без health_url считается здоровым: проверять нечем', async () => {
    await expect(checkHealth(null, jest.fn() as any)).resolves.toBe(true);
  });
});

describe('waitHealthy', () => {
  it('продукт, поднявшийся не сразу, считается здоровым', async () => {
    // Замерено на живой VM: сразу после pm2 restart порт отвергает
    // соединение, продукт слушает через ~200 мс. Одиночная проба в этот
    // момент красная — и автооткат срабатывал бы на каждом успешном ходе.
    let probe = 0;
    const fetchFn = jest.fn(async () => {
      probe += 1;
      if (probe < 3) throw new Error('ECONNREFUSED');
      return response({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await expect(
      waitHealthy('https://x/api/healthz', fetchFn as any, { sleep: async () => undefined }),
    ).resolves.toBe(true);
    expect(probe).toBe(3);
  });

  it('не поднявшийся за срок — красный', async () => {
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      waitHealthy('https://x/api/healthz', fetchFn as any, {
        timeoutMs: 1000,
        probeEveryMs: 500,
        sleep: async () => undefined,
      }),
    ).resolves.toBe(false);
    // Ровно столько проб, сколько укладывается в срок — не больше и не меньше.
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('без health_url не ждёт вовсе', async () => {
    const fetchFn = jest.fn();

    await expect(waitHealthy(null, fetchFn as any)).resolves.toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('между пробами выдерживается пауза', async () => {
    // Без паузы это busy-loop: тысячи запросов в секунду к поднимающемуся
    // продукту, пока он и так занят стартом.
    const waits: number[] = [];
    const fetchFn = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await waitHealthy('https://x/api/healthz', fetchFn as any, {
      timeoutMs: 1500,
      probeEveryMs: 500,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    });

    expect(waits).toEqual([500, 500]);
  });
});

describe('deploy', () => {
  const okShell = jest.fn(async () => undefined);
  // Без переопределения sleep ожидание здоровья реально спало бы до 30с на
  // каждом тесте с красным health (дефолтный healthTimeoutMs). В самих
  // тестах deploy интересует только факт отката, а не тайминги waitHealthy —
  // те уже разобраны отдельно в describe('waitHealthy', ...) выше.
  const noSleep = async () => undefined;

  it('красный health откатывает на sha_before', async () => {
    const git = { resetHard: jest.fn(async () => undefined) };
    const unhealthy = jest.fn(async () => response({ status: 500, contentType: 'text/plain', body: 'x' }));

    const result = await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell: okShell,
      fetchFn: unhealthy as any,
      sleep: noSleep,
    });

    expect(result.reverted).toBe(true);
    expect(git.resetHard).toHaveBeenCalledWith('aaa111');
  });

  it('после отката пересобирает и поднимает, а не оставляет сломанное', async () => {
    const git = { resetHard: jest.fn(async () => undefined) };
    const shell = jest.fn(async () => undefined);
    const unhealthy = jest.fn(async () => response({ status: 500, contentType: 'text/plain', body: 'x' }));

    await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell,
      fetchFn: unhealthy as any,
      sleep: noSleep,
    });

    // build+restart дважды: первый раз с новым кодом, второй после отката
    expect(shell).toHaveBeenCalledTimes(4);
  });

  it('зелёный health — отката нет', async () => {
    const git = { resetHard: jest.fn(async () => undefined) };
    const healthy = jest.fn(async () => response({ status: 200, contentType: 'application/json', body: '{}' }));

    const result = await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell: okShell,
      fetchFn: healthy as any,
    });

    expect(result.reverted).toBe(false);
    expect(git.resetHard).not.toHaveBeenCalled();
  });

  it('не откатывает продукт, поднявшийся не сразу после рестарта', async () => {
    // Интеграционный уровень: waitHealthy сам по себе уже протестирован выше,
    // но без этого теста здесь мутация «вернуть checkHealth вместо
    // waitHealthy в deploy» прошла бы незамеченной — остальные deploy-тесты
    // либо здоровы с первой пробы, либо падают на сборке/рестарте раньше
    // health-check и до fetchFn вовсе не доходят.
    const git = { resetHard: jest.fn(async () => undefined) };
    let probe = 0;
    const fetchFn = jest.fn(async () => {
      probe += 1;
      if (probe < 3) throw new Error('ECONNREFUSED');
      return response({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const result = await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell: okShell,
      fetchFn: fetchFn as any,
      sleep: noSleep,
    });

    expect(result.reverted).toBe(false);
    expect(git.resetHard).not.toHaveBeenCalled();
    expect(probe).toBe(3);
  });

  it('фазы отчитываются наружу', async () => {
    // Сборка и рестарт — самая долгая часть хода, и для серверного сборщика
    // зависших она выглядит молчанием: события шлёт только claude, а он уже
    // отработал. Ход, чья сборка идёт дольше получаса, снялся бы как мёртвый.
    const phases: string[] = [];
    const healthy = jest.fn(async () => response({ status: 200, contentType: 'application/json', body: '{}' }));

    await deploy({
      git: { resetHard: jest.fn() } as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell: jest.fn(async () => undefined),
      fetchFn: healthy as any,
      onPhase: (p) => phases.push(p),
    });

    // Не `length > 0`: это остаётся истиной за счёт фазы проверки здоровья
    // вне сборки, и снятие отчёта из bringUp проходило незамеченным.
    expect(phases).toEqual(
      expect.arrayContaining([expect.stringContaining('сборка'), expect.stringContaining('перезапуск')]),
    );
  });

  it('отказ сборки откатывает так же, как красный health', async () => {
    // На живой проверке deploy упал на `pm2: not found`, коммит агента
    // остался в дереве, отката не было — чекаут разошёлся с запущенным кодом.
    const git = { resetHard: jest.fn(async () => undefined) };
    let calls = 0;
    const shell = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('pm2: not found');
    });

    const result = await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell,
      fetchFn: jest.fn() as any,
    });

    expect(result.reverted).toBe(true);
    expect(git.resetHard).toHaveBeenCalledWith('aaa111');
  });

  it('отказ рестарта после успешной сборки тоже откатывает', async () => {
    const git = { resetHard: jest.fn(async () => undefined) };
    let calls = 0;
    const shell = jest.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('pm2: not found');
    });

    const result = await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell,
      fetchFn: jest.fn() as any,
    });

    expect(result.reverted).toBe(true);
    expect(git.resetHard).toHaveBeenCalled();
  });

  it('провал подъёма после отката не прячется от клиента', async () => {
    // Если и откаченное не поднялось — продукт лежит, и клиент обязан узнать
    // об этом из потока, а не из лога на чужой машине.
    const phases: string[] = [];
    const git = { resetHard: jest.fn(async () => undefined) };
    const shell = jest.fn(async () => {
      throw new Error('всё сломано');
    });

    await deploy({
      git: git as any,
      shaBefore: 'aaa111',
      buildCmd: 'npm run build',
      restartCmd: 'pm2 restart web',
      healthUrl: 'https://x/api/healthz',
      shell,
      fetchFn: jest.fn() as any,
      onPhase: (p) => phases.push(p),
    });

    expect(phases.some((p) => p.includes('Откат поднять не удалось'))).toBe(true);
  });
});
