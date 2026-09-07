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
