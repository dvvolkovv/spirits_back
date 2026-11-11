import { RoutinePushService } from './routine-push.service';
import { RelaySessionBusyError } from '../chat/chat.service';

/**
 * Бэклог e777aa94: рутина, пришедшая посреди разговора человека, не пре-эмптит
 * его ход — agentReply отвечает RelaySessionBusyError, доставка откладывается
 * на 15 минут таймером, а дневной claim освобождается владельцем claim:
 * следующий runDue — персистентная страховка на случай рестарта процесса.
 */

function makeService(chatImpl: jest.Mock, storeOverrides: any = {}) {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => 1) };
  const store = {
    getById: jest.fn(async () => ({
      id: 'r-1', userId: 'u-1', assistantId: '12', prompt: 'напомни', title: 't',
      enabled: true, tz: 'Europe/Moscow', lastSentDate: null,
    })),
    localDate: jest.fn(() => '2026-11-05'),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...storeOverrides,
  };
  const svc = new RoutinePushService(
    pg as any, push as any, { generateAgentReplyOutcome: chatImpl } as any, store as any,
  );
  return { svc, store };
}

describe('рутина при занятой сессии человека', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('busy — откладывает на 15 минут, не пишет в историю и не откатывает чужой claim', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
      .resolves.toEqual({ delivered: 0, busy: true });
    expect(store.releaseToday).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(1);
    const inserts = (svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]));
    expect(inserts.length).toBe(0);
  });

  it('повтор доставляет, когда сессия свободна: заново claim и запись в историю', async () => {
    const chat = jest.fn()
      .mockImplementationOnce(async () => { throw new RelaySessionBusyError('u-1_12_ru'); })
      .mockImplementationOnce(async () => ({ text: 'Доброе утро!', failed: false, failReason: undefined }));
    const { svc, store } = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05');
    expect(store.releaseToday).not.toHaveBeenCalled();
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

  it('max_turns — failed без retry и без release', async () => {
    const chat = jest.fn(async () => ({ text: '', failed: true, failReason: 'max_turns' }));
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
      .resolves.toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
    expect((svc as any).retryTimers.size).toBe(0);
    expect(store.releaseToday).not.toHaveBeenCalled();
  });

  it('повтор снова busy — освобождает новый claim с prev и оставляет один retry', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05');
    expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05', null);
    expect((svc as any).retryTimers.size).toBe(1);
  });
});
