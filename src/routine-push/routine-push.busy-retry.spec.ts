import { RoutinePushService } from './routine-push.service';
import { RelaySessionBusyError } from '../chat/chat.service';

/**
 * Рутина не пре-эмптит ход человека. Busy/preempted освобождают только свой
 * claim и получают один retry; остальные сбои оставляют день застолбленным.
 */

const success = (text = 'Доброе утро!') => ({ text, failed: false, failReason: undefined });

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
    getById: jest.fn(async () => ({
      id: 'r-1', userId: 'u-1', assistantId: '12', prompt: 'напомни', title: 't',
      enabled: true, tz: 'Europe/Moscow', lastSentDate: null,
    })),
    listEnabled: jest.fn(async () => []),
    scheduledToday: jest.fn(() => true),
    localHour: jest.fn(() => 12),
    localDate: jest.fn(() => '2026-11-05'),
    toISO: jest.fn((value: any) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...storeOverrides,
  };
  const svc = new RoutinePushService(
    pg as any, push as any, { generateAgentReplyOutcome: chatImpl } as any, store as any,
  );
  return { svc, store, push, state, history };
}

function dueRow(overrides: any = {}) {
  return {
    id: 'r-1', user_id: 'u-1', assistant_id: '12', prompt: 'напомни', title: 't',
    send_hour: 8, tz: 'Europe/Moscow', days: null, last_sent_date: null,
    ...overrides,
  };
}

describe('рутина при занятой сессии человека', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('busy — DeliverResult и retry без записи history или безусловного release', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
      .resolves.toEqual({ delivered: 0, busy: true });
    expect(store.releaseToday).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(1);
    expect((svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]))).toEqual([]);
  });

  it('повтор доставляет: актуальная routine, claim с userId и history', async () => {
    const chat = jest.fn()
      .mockImplementationOnce(async () => { throw new RelaySessionBusyError('u-1_12_ru'); })
      .mockImplementationOnce(async () => success());
    const { svc, store } = makeService(chat);

    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05', 'u-1');
    expect(store.releaseToday).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
    expect((svc as any).pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]))).toHaveLength(1);
  });

  it('две busy подряд — один timer', async () => {
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

  it('другие ошибки пробрасываются и не откладываются', async () => {
    const chat = jest.fn(async () => { throw new Error('relay down'); });
    const { svc } = makeService(chat);
    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1')).rejects.toThrow('relay down');
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it('retry после deleted не вызывает claim, LLM, history или push', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store, state, history, push } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');
    state.set('u-1', 'deleted');

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(store.claimToday).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it('fireNow для deleted не вызывает LLM, history или push', async () => {
    const chat = jest.fn(async () => success('не должно генерироваться'));
    const { svc, state, history, push } = makeService(chat);
    state.set('u-1', 'deleted');

    expect(await svc.fireNow('u-1', 'r-1')).toBeNull();
    expect(chat).not.toHaveBeenCalled();
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('deleted во время generateAgentReplyOutcome не пишет history и не отправляет push', async () => {
    let stateRef: Map<string, 'active' | 'deleted'>;
    const chat = jest.fn(async () => {
      stateRef.set('u-1', 'deleted');
      return success('готово');
    });
    const { svc, state, history, push } = makeService(chat);
    stateRef = state;

    expect(await svc.fireNow('u-1', 'r-1')).toEqual({ delivered: 0 });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('max_turns — failed без retry и release, claim остаётся', async () => {
    const chat = jest.fn(async () => ({ text: '', failed: true, failReason: 'max_turns' }));
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
      .resolves.toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
    expect((svc as any).retryTimers.size).toBe(0);
    expect(store.releaseToday).not.toHaveBeenCalled();
  });

  it('preempted — failed с retry, release выполняет владелец claim', async () => {
    const chat = jest.fn(async () => ({ text: '', failed: true, failReason: 'preempted' }));
    const { svc, store } = makeService(chat);

    await expect((svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1'))
      .resolves.toEqual({ delivered: 0, failed: true, failReason: 'preempted' });
    expect((svc as any).retryTimers.size).toBe(1);
    expect(store.releaseToday).not.toHaveBeenCalled();
  });

  it('повтор снова busy — release нового claim с prev и один retry', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const { svc, store } = makeService(chat);
    await (svc as any).deliver('u-1', '12', 'напомни', 't', 'r-1');

    await jest.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05', 'u-1');
    expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05', null);
    expect((svc as any).retryTimers.size).toBe(1);
  });

  it('runDue busy освобождает claim с исходным prev', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u-1_12_ru'); });
    const previous = new Date('2026-11-04T00:00:00Z');
    const { svc, store } = makeService(chat, {
      listEnabled: jest.fn(async () => [dueRow({ last_sent_date: previous })]),
    });

    await svc.runDue();

    expect(store.claimToday).toHaveBeenCalledWith('r-1', '2026-11-05', 'u-1');
    expect(store.releaseToday).toHaveBeenCalledWith('r-1', '2026-11-05', '2026-11-04');
  });

  it('runDue non-preempted failure не делает release и не ставит retry', async () => {
    const chat = jest.fn(async () => ({ text: '', failed: true, failReason: 'max_turns' }));
    const { svc, store } = makeService(chat, {
      listEnabled: jest.fn(async () => [dueRow()]),
    });

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
  });

  it.each(['disabled', 'owner'])('гонка %s между list и claim — нет claim/deliver', async (race) => {
    const current = { enabled: true, owner: 'u-1' };
    const chat = jest.fn(async () => success());
    const claimToday = jest.fn(async (_id: string, _today: string, userId?: string) => {
      // Старая двухаргументная форма моделирует UPDATE без owner/enabled fence.
      if (userId === undefined) return true;
      return current.enabled && current.owner === userId;
    });
    const listEnabled = jest.fn(async () => {
      const snapshot = dueRow();
      if (race === 'disabled') current.enabled = false;
      else current.owner = 'u-other';
      return [snapshot];
    });
    const { svc } = makeService(chat, { listEnabled, claimToday });

    await svc.runDue();

    expect(chat).not.toHaveBeenCalled();
  });

  it('нулевое число подписок — delivered=0, но не generation failure', async () => {
    const chat = jest.fn(async () => success());
    const { svc, push } = makeService(chat);
    push.sendPush.mockResolvedValue(0);

    expect(await svc.fireNow('u-1', 'r-1')).toEqual({ delivered: 0 });
  });

  it('ошибка CLI текстом — failed/cli_failure_text без history/push/retry', async () => {
    const chat = jest.fn(async () => success('Failed to authenticate: OAuth session expired'));
    const { svc, store, history, push } = makeService(chat);

    expect(await svc.fireNow('u-1', 'r-1')).toEqual({
      delivered: 0, failed: true, failReason: 'cli_failure_text',
    });
    expect(history).toEqual([]);
    expect(push.sendPush).not.toHaveBeenCalled();
    expect(store.releaseToday).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
  });
});
