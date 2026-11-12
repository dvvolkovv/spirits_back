import { RoutinePushService } from './routine-push.service';
import { RelaySessionBusyError } from '../chat/chat.service';

/**
 * Бэклог e777aa94: рутина, пришедшая посреди разговора человека, не пре-эмптит
 * его ход — agentReply отвечает RelaySessionBusyError, доставка откладывается
 * на 15 минут таймером, а дневной claim освобождается: следующий runDue —
 * персистентная страховка на случай рестарта процесса.
 */

function makeService(chatImpl: jest.Mock, storeOverrides: any = {}) {
  const state = new Map<string, 'active' | 'deleted'>([['u-1', 'active']]);
  const history: any[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/SELECT 1 FROM user_id WHERE internal_id=\$1 AND state='active'/.test(sql.replace(/\s+/g, ' '))) {
        const active = state.get(params[0]) === 'active';
        return { rows: active ? [{ '?column?': 1 }] : [], rowCount: active ? 1 : 0 };
      }
      if (/INSERT INTO custom_chat_history/.test(sql)) {
        const userId = String(params[0]).split('_')[0];
        const guarded = sql.includes('WHERE EXISTS');
        if (!guarded || state.get(userId) === 'active') history.push({ userId, content: params[2] });
        return { rows: [], rowCount: guarded && state.get(userId) !== 'active' ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const push = { sendPush: jest.fn(async () => 1) };
  const store = {
    getById: jest.fn(async () => ({ id: 'r-1', user_id: 'u-1', assistant_id: '12', prompt: 'напомни', title: 't', enabled: true, tz: 'Europe/Moscow' })),
    localDate: jest.fn(() => '2026-11-05'),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => {}),
    ...storeOverrides,
  };
  const svc = new RoutinePushService(pg as any, push as any, { generateAgentReply: chatImpl } as any, store as any);
  return { svc, store, push, state, history };
}

describe('рутина при занятой сессии человека', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('busy — освобождает claim и откладывает на 15 минут, не пишет в историю', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1')).resolves.toBe(0);
    expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05');
    expect((svc as any).retryTimers.size).toBe(1);
    const inserts = (svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]));
    expect(inserts.length).toBe(0);
  });

  it('повтор доставляет, когда сессия свободна: заново claim и запись в историю', async () => {
    const chat = jest.fn()
      .mockImplementationOnce(async () => { throw new RelaySessionBusyError('u-1_12_ru'); })
      .mockImplementationOnce(async () => 'Доброе утро!');
    const { svc, store } = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05');
    expect((svc as any).retryTimers.size).toBe(0);
    const inserts = (svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]));
    expect(inserts.length).toBe(1);
  });

  it('две busy подряд — один таймер', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc } = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    expect((svc as any).retryTimers.size).toBe(1);
  });

  it('рутину удалили за время busy — повтор не доставляет', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');

    store.getById.mockResolvedValueOnce(null);
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('рутину выключили за время busy — повтор не доставляет', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');

    store.getById.mockResolvedValueOnce({ id: 'r-1', enabled: false, tz: 'Europe/Moscow' });
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('другие ошибки пробрасываются, не откладываются', async () => {
    const chat = jest.fn(async () => { throw new Error('relay down'); });
    const { svc } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1')).rejects.toThrow('relay down');
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it('retry после deleted не вызывает LLM, history или push', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, state, history, push } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    expect((svc as any).retryTimers.size).toBe(1);

    state.set('u-1', 'deleted');
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it('fireNow для deleted не вызывает LLM, history или push', async () => {
    const chat = jest.fn(async () => 'не должно генерироваться');
    const { svc, state, history, push } = makeService(chat);
    state.set('u-1', 'deleted');

    expect(await svc.fireNow('u-1', 'r-1')).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it('deleted во время generateAgentReply не пишет history и не отправляет push', async () => {
    let stateRef: Map<string, 'active' | 'deleted'>;
    const chat = jest.fn(async () => {
      stateRef.set('u-1', 'deleted');
      return 'готово';
    });
    const { svc, state, history, push } = makeService(chat);
    stateRef = state;

    expect(await svc.fireNow('u-1', 'r-1')).toEqual({ delivered: 0 });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
  });
});
