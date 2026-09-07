import { checkHealth, deploy } from './deploy';

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

describe('deploy', () => {
  const okShell = jest.fn(async () => undefined);

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

    expect(phases.length).toBeGreaterThan(0);
  });
});
