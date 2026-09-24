import { executeTurn } from './turn';

function makeDeps(over: any = {}) {
  const git = {
    commitPendingChanges: jest.fn(async () => undefined),
    headSha: jest.fn(async () => 'sha-before'),
    commitAll: jest.fn(async () => 'sha-after'),
    resetHard: jest.fn(async () => undefined),
    push: jest.fn(async () => undefined),
    ...over.git,
  };
  const api = {
    sendEvents: jest.fn(async () => true),
    complete: jest.fn(async () => true),
    ...over.api,
  };
  const runClaude = over.runClaude ?? jest.fn(async () => ({ ok: true }));
  const deploy = over.deploy ?? jest.fn(async () => ({ reverted: false }));
  return { git, api, runClaude, deploy };
}

/** Весь текст, который ход отправил клиенту, одной строкой. */
function eventTexts(api: any): string {
  return api.sendEvents.mock.calls
    .flatMap(([, events]: [string, any[]]) => events ?? [])
    .map((e: any) => e.content ?? e.message ?? '')
    .join('\n');
}

const PRODUCT = {
  checkoutPath: '/srv/app',
  buildCmd: 'npm run build',
  restartCmd: 'pm2 restart web',
  healthUrl: 'https://x/api/healthz',
  repoUrl: null,
  claudeSessionId: null,
};

const TURN = { id: 't-1', prompt: 'поправь футер', userId: 'u-1', revertToSha: null };

describe('executeTurn — обычный ход', () => {
  it('сохраняет ручные правки ДО снятия точки возврата', async () => {
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    // Иначе sha_before укажет на состояние без чужой работы, и откат её сотрёт
    expect(d.git.commitPendingChanges.mock.invocationCallOrder[0]).toBeLessThan(
      d.git.headSha.mock.invocationCallOrder[0],
    );
  });

  it('успешный ход докладывает done с обоими sha', async () => {
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.api.complete).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({ status: 'done', shaBefore: 'sha-before', shaAfter: 'sha-after' }),
    );
  });

  it('красный health докладывает reverted, а не done', async () => {
    const d = makeDeps({ deploy: jest.fn(async () => ({ reverted: true })) });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.api.complete).toHaveBeenCalledWith('t-1', expect.objectContaining({ status: 'reverted' }));
  });

  it('откаченный ход не сообщает sha_after', async () => {
    // Иначе история покажет коммит, которого в дереве уже нет.
    const d = makeDeps({ deploy: jest.fn(async () => ({ reverted: true })) });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    const payload = d.api.complete.mock.calls[0][1];
    expect(payload.shaAfter).toBeUndefined();
  });

  it('упавший claude докладывает failed и НЕ деплоит', async () => {
    const d = makeDeps({ runClaude: jest.fn(async () => ({ ok: false, error: 'claude exited 1' })) });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.deploy).not.toHaveBeenCalled();
    expect(d.api.complete).toHaveBeenCalledWith('t-1', expect.objectContaining({ status: 'failed' }));
  });

  it('упавший claude не коммитит недоделанное', async () => {
    // Агент мог успеть напортить в файлах до падения. Коммитить это значит
    // закрепить полуфабрикат в истории и в sha_after.
    const d = makeDeps({ runClaude: jest.fn(async () => ({ ok: false, error: 'boom' })) });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.git.commitAll).not.toHaveBeenCalled();
  });
});

describe('executeTurn — служебный ход отката', () => {
  // Откат опознаётся по полю, а не по префиксу промпта: строковый контракт
  // между двумя репозиториями разъезжается молча, и его нечем охранять.
  const revertTurn = { id: 't-2', prompt: 'Откат к aaa111', userId: 'u-1', revertToSha: 'aaa111' };

  it('не запускает claude', async () => {
    const d = makeDeps();

    await executeTurn({ turn: revertTurn, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.runClaude).not.toHaveBeenCalled();
  });

  it('сбрасывает дерево на указанный sha и докладывает reverted', async () => {
    const d = makeDeps();

    await executeTurn({ turn: revertTurn, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.git.resetHard).toHaveBeenCalledWith('aaa111');
    expect(d.api.complete).toHaveBeenCalledWith('t-2', expect.objectContaining({ status: 'reverted' }));
  });

  it('откат не тарифицируется', async () => {
    const d = makeDeps();

    await executeTurn({ turn: revertTurn, product: PRODUCT, config: {} as any, ...d } as any);

    const payload = d.api.complete.mock.calls[0][1];
    expect(payload.tokens ?? 0).toBe(0);
  });
});

describe('проводка ожидаемого sha в деплой', () => {
  // Отдельный тест именно на связку. Сверка sha живёт в deploy.ts и покрыта
  // там, но убрать одну строку в turn.ts — и защита отключена целиком, а все
  // прочие тесты остаются зелёными. Проверено мутацией: без этого теста
  // удаление проводки не роняло ни одного из 77.
  it('deploy получает sha именно той правки, что закоммичена', async () => {
    const d = makeDeps({ git: { commitAll: jest.fn(async () => 'sha-новой-правки') } });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSha: 'sha-новой-правки' }),
    );
  });

  it('служебный ход отката sha не сверяет', async () => {
    // При откате дерево возвращается на прежний коммит, и продукт обязан
    // подняться именно на нём. Ожидаемого sha «новой правки» здесь нет —
    // передать сюда shaAfter значило бы уронить каждый откат.
    const d = makeDeps();
    const revertTurn = { ...TURN, revertToSha: 'sha-куда-возвращаемся' };

    await executeTurn({ turn: revertTurn, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ shaBefore: 'sha-куда-возвращаемся' }),
    );
  });
});

describe('резервная копия (git push) — место в ходе и цена отказа', () => {
  const failingPush = () =>
    makeDeps({
      git: {
        push: jest.fn(async () => {
          throw new Error('fatal: The current branch master has no upstream branch.');
        }),
      },
    });

  it('копия делается ПОСЛЕ сборки и проверки здоровья', async () => {
    // Измерено на проде 23.09.2026: push стоял перед deploy, упал на
    // отсутствующем upstream — и ход оборвался ДО сборки. Сайт demo при этом
    // уже жил изменённым (заголовок сменился), проверка здоровья не
    // выполнялась вовсе, автооткат не выполнялся, а клиенту сказали «на сайте
    // всё осталось как было». Порядок здесь — не вкусовщина, а условие того,
    // что отказ копии вообще безопасно пережить.
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.git.push).toHaveBeenCalled();
    expect(d.deploy.mock.invocationCallOrder[0]).toBeLessThan(d.git.push.mock.invocationCallOrder[0]);
  });

  it('на откате копия не делается вовсе', async () => {
    // Откат вернул дерево на прежний коммит — копировать нечего, а отправить
    // в резерв откаченное состояние значит записать туда «правку», которой
    // в живом продукте уже нет.
    const d = makeDeps({ deploy: jest.fn(async () => ({ reverted: true })) });

    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any);

    expect(d.git.push).not.toHaveBeenCalled();
  });

  it('отказ копии не роняет ход: правка уже применена и проверена', async () => {
    const d = failingPush();

    // resolves, а не голый await: если push снова начнёт ронять ход, тест
    // обязан покраснеть утверждением, а не аварией теста.
    await expect(
      executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any),
    ).resolves.toBeUndefined();

    // Сайт живёт новой правкой. Сказать «failed» значит соврать клиенту, что
    // ничего не изменилось.
    expect(d.api.complete).toHaveBeenCalledWith('t-1', expect.objectContaining({ status: 'done' }));
  });

  it('отказ копии виден клиенту строкой события', async () => {
    const d = failingPush();

    // Падение хода здесь гасим намеренно: этот тест меряет ровно одно —
    // видимость отказа. Про статус хода отвечает тест выше.
    await executeTurn({ turn: TURN, product: PRODUCT, config: {} as any, ...d } as any).catch(
      () => undefined,
    );

    // Проглотить молча нельзя: копии нет, а узнать об этом неоткуда — ровно
    // так теряется единственный экземпляр кода клиента.
    expect(eventTexts(d.api)).toMatch(/резервн/i);
  });
});

describe('продукт под pm2 (PRODUCT_START_SCRIPT): перезапуск и порт', () => {
  // Контейнер продукта поднимает entrypoint.sh: `pm2 start $PRODUCT_START_SCRIPT
  // --name product`. Раз переменная задана — продукт живёт под pm2 с этим
  // именем, и раннеру известно, как его перезапустить.
  const PM2 = { productStartScript: 'server.js' } as any;
  const NO_PM2 = { productStartScript: null } as any;
  // Реестр 22.09.2026: у продукта, заведённого самообслуживанием, build_cmd и
  // restart_cmd — NULL.
  const SELF_SERVICE = { ...PRODUCT, buildCmd: null, restartCmd: null, healthUrl: 'http://127.0.0.1:3000/health' };
  const revertTurn = { ...TURN, id: 't-3', revertToSha: 'aaa111' };

  it('restart_cmd пуст — раннер перезапускает pm2 сам', async () => {
    // Без перезапуска правка проверялась против СТАРОГО процесса: sha не
    // сходился, и ход откатывался всегда — если только агент сам не
    // догадывался перезапустить pm2 после своего коммита.
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: SELF_SERVICE, config: PM2, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(expect.objectContaining({ restartCmd: 'pm2 restart product' }));
  });

  it('так же и в служебном ходе отката', async () => {
    const d = makeDeps();

    await executeTurn({ turn: revertTurn, product: SELF_SERVICE, config: PM2, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(expect.objectContaining({ restartCmd: 'pm2 restart product' }));
  });

  it('restart_cmd из одних пробелов — тоже пуст', async () => {
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: { ...SELF_SERVICE, restartCmd: '  ' }, config: PM2, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(expect.objectContaining({ restartCmd: 'pm2 restart product' }));
  });

  it('restart_cmd из реестра не подменяется', async () => {
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: { ...SELF_SERVICE, restartCmd: 'pm2 reload product' }, config: PM2, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(expect.objectContaining({ restartCmd: 'pm2 reload product' }));
  });

  it('продукт не под pm2 — пустой restart_cmd так и остаётся пустым', async () => {
    // Раннер не знает, как перезапускать то, что запущено не им.
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: SELF_SERVICE, config: NO_PM2, ...d } as any);

    expect(d.deploy).toHaveBeenCalledWith(expect.objectContaining({ restartCmd: null }));
  });

  it('деплою передаётся освобождение порта, и оно смотрит в health_url продукта', async () => {
    const d = makeDeps();
    const freeProductPort = jest.fn(async (_input: any) => undefined);

    await executeTurn({ turn: TURN, product: SELF_SERVICE, config: PM2, ...d, freeProductPort } as any);

    const { freePort } = d.deploy.mock.calls[0][0];
    expect(typeof freePort).toBe('function');
    const report = jest.fn();
    await freePort(report);
    expect(freeProductPort).toHaveBeenCalledWith(
      expect.objectContaining({ healthUrl: 'http://127.0.0.1:3000/health', onPhase: report }),
    );
  });

  it('и в служебном ходе отката', async () => {
    const d = makeDeps();
    const freeProductPort = jest.fn(async (_input: any) => undefined);

    await executeTurn({ turn: revertTurn, product: SELF_SERVICE, config: PM2, ...d, freeProductPort } as any);

    const { freePort } = d.deploy.mock.calls[0][0];
    await freePort(jest.fn());
    expect(freeProductPort).toHaveBeenCalledWith(expect.objectContaining({ healthUrl: 'http://127.0.0.1:3000/health' }));
  });

  it('продукт не под pm2 — порт не трогается вовсе', async () => {
    // Без pm2 неизвестно, какой процесс на порту законный: снимать некого.
    const d = makeDeps();

    await executeTurn({ turn: TURN, product: SELF_SERVICE, config: NO_PM2, ...d } as any);

    expect(d.deploy.mock.calls[0][0].freePort).toBeUndefined();
  });
});
