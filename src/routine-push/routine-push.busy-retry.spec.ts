import { RoutinePushService } from './routine-push.service';
import { RelaySessionBusyError } from '../chat/chat.service';

/**
 * Бэклог e777aa94: рутина, пришедшая посреди разговора человека, больше не
 * пре-эмптит его ход — agentReply отвечает RelaySessionBusyError, а доставка
 * откладывается таймером на 15 минут. runDue при этом идёт дальше, fireNow не
 * держит HTTP. Повторная попытка доставляет, когда сессия свободна.
 */

function makeService(chatImpl: jest.Mock) {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => {}) };
  const store = {};
  const svc = new RoutinePushService(pg as any, push as any, { generateAgentReply: chatImpl } as any, store as any);
  return svc;
}

describe('рутина при занятой сессии человека', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('busy — откладывает на 15 минут, не пишет в историю и не падает', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const svc = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни')).resolves.toBe(0);
    expect((svc as any).retryTimers.size).toBe(1);
    expect((svc as any).pg.query).not.toHaveBeenCalled();
  });

  it('повторная попытка доставляет, когда сессия свободна', async () => {
    const chat = jest.fn()
      .mockImplementationOnce(async () => { throw new RelaySessionBusyError('u-1_12_ru'); })
      .mockImplementationOnce(async () => 'Доброе утро!');
    const svc = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни');
    expect((svc as any).retryTimers.size).toBe(1);

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(chat).toHaveBeenCalledTimes(2);
    expect((svc as any).retryTimers.size).toBe(0);
    // Текст записан в историю основной сессии.
    const inserts = (svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]));
    expect(inserts.length).toBe(1);
  });

  it('две busy подряд не плодят второй таймер', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const svc = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни');
    await (svc as any).deliver('u-1', '12', 'напомни');
    expect((svc as any).retryTimers.size).toBe(1);
  });

  it('другие ошибки по-прежнему пробрасываются, не откладываются', async () => {
    const chat = jest.fn(async () => { throw new Error('relay down'); });
    const svc = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни')).rejects.toThrow('relay down');
    expect((svc as any).retryTimers.size).toBe(0);
  });
});
