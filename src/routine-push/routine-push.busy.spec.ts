import { RoutinePushService } from './routine-push.service';
import { RoutinePushController } from './routine-push.controller';
import { RoutineStore } from './routine-store.service';
import { RelaySessionBusyError } from '../chat/relay-session-busy';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
import { sendTelegramAlert } from '../common/telegram-alert';

/**
 * Рутина (RoutinePushService.deliver, крон раз в час и «Проверить сейчас») —
 * один из вызывающих ChatService.agentReply БЕЗ sessionIdOverride (бэклог
 * e777aa94): делит сессию релея с чатом человека. До этой правки
 * `claimToday` помечал день отправленным ДО генерации — сбой (занятая
 * сессия человека или сбойный ход) съедал день рутины до следующего
 * запуска по расписанию (сутки, не час).
 *
 * Решение: прежнее значение last_sent_date запоминается до claimToday;
 * день возвращается (releaseToday) ТОЛЬКО когда сессия была занята
 * (RelaySessionBusyError) или ход перебил человек (failReason ===
 * 'preempted') — в обоих случаях это не наша вина, сессия освободится в
 * течение часа. Прочие сбои (transient_after_write — релей сам не
 * переигрывает, т.к. запись могла уже пройти; max_turns — ход дорогой,
 * рутины не тарифицируются; cli_fatal и т.п.) и исключения потока — день
 * съеден, повтора нет (ревью 03.11, п.3): часовой повтор там не поможет и
 * только слал бы алерты. looksLikeFailure (CLI вернул ошибку текстом,
 * success=true) — отдельный механизм, день тоже не возвращаем.
 *
 * deliver() зовёт generateAgentReplyOutcome (не generateAgentReply): нужен
 * failReason, чтобы различить «день возвращаем» от «день съеден».
 */

function makeStore(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    listEnabled: jest.fn(async () => []),
    scheduledToday: jest.fn(() => true),
    localHour: jest.fn(() => 9),
    localDate: jest.fn(() => '2026-11-03'),
    toISO: jest.fn((d: any) => String(d)),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...overrides,
  };
}

const row = (overrides: Partial<Record<string, any>> = {}) => ({
  id: 'r1', user_id: 'u1', title: 'Энергия дня', assistant_id: '14',
  prompt: 'энергия дня', send_hour: 8, tz: 'Europe/Moscow', days: null,
  last_sent_date: null,
  ...overrides,
});

/** Исход generateAgentReplyOutcome на удачный ход (линия сборки как в chat.service.ts). */
const ok = (text: string) => ({ text, failed: false, failReason: undefined });
const failed = (failReason: string, text = '') => ({ text, failed: true, failReason });

describe('RoutineStore.releaseToday', () => {
  it('возвращает prev в last_sent_date, только если там ещё today', async () => {
    const calls: { sql: string; params: any[] }[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return { rows: [{ id: 'r1' }], rowCount: 1 };
      }),
    };
    const store = new RoutineStore(pg as any);
    const res = await store.releaseToday('r1', '2026-11-03', null);
    expect(res).toBe(true);
    const call = calls.find((c) => /UPDATE routine_pushes/.test(c.sql));
    expect(call).toBeDefined();
    expect(call!.sql).toMatch(/last_sent_date\s*=\s*\$3/);
    expect(call!.sql).toMatch(/WHERE id = \$1 AND last_sent_date = \$2/);
    expect(call!.params).toEqual(['r1', '2026-11-03', null]);
  });

  it('не трогает отметку, если её уже сменили (gone stale) — возвращает false', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const store = new RoutineStore(pg as any);
    const res = await store.releaseToday('r1', '2026-11-03', null);
    expect(res).toBe(false);
  });
});

describe('RoutinePushService.runDue — перенос при занятой сессии/перебитом ходе; прочие сбои — без повтора', () => {
  afterEach(() => jest.clearAllMocks());

  it('RelaySessionBusyError — releaseToday вызван с прежним last_sent_date, пуш не отправлен, другие рутины продолжаются', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = {
      generateAgentReplyOutcome: jest.fn()
        .mockRejectedValueOnce(new RelaySessionBusyError())
        .mockResolvedValueOnce(ok('Доброе утро!')),
    };
    const rows = [row({ id: 'r1', user_id: 'u1', last_sent_date: null }), row({ id: 'r2', user_id: 'u2', last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', null);
    expect(store.releaseToday).toHaveBeenCalledTimes(1); // r2 доставлена, её не трогаем
    expect(push.sendPush).toHaveBeenCalledTimes(1); // только r2
    expect(chat.generateAgentReplyOutcome).toHaveBeenCalledTimes(2); // обе рутины попытались
  });

  it('failReason: preempted (человек перебил ход на релее) — releaseToday вызван, пуш не отправлен', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => failed('preempted', 'обрывок')) };
    const rows = [row({ last_sent_date: '2026-11-02' })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', '2026-11-02');
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('preempted — внутренний лог deliver() «empty text» идёт через log(), не warn() (ожидаемый исход)', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => failed('preempted', 'обрывок')) };
    const rows = [row({ last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    await svc.runDue();

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('empty text'))).toBe(false);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('empty text'))).toBe(true);
  });

  it('прочий (не preempted) сбой — внутренний лог deliver() «empty text» остаётся warn()', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => failed('max_turns')) };
    const rows = [row({ last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.runDue();

    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('empty text'))).toBe(true);
  });

  it.each(['transient_after_write', 'max_turns', 'cli_fatal'])(
    'failReason: %s — день НЕ возвращаем, повтора нет, пуша нет',
    async (reason) => {
      const push = { sendPush: jest.fn(async () => 1) };
      const chat = { generateAgentReplyOutcome: jest.fn(async () => failed(reason)) };
      const rows = [row({ last_sent_date: null })];
      const store = makeStore({ listEnabled: jest.fn(async () => rows) });
      const pg = { query: jest.fn(async () => ({ rows: [] })) };
      const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

      await svc.runDue();

      expect(store.releaseToday).not.toHaveBeenCalled();
      expect(push.sendPush).not.toHaveBeenCalled();
    },
  );

  it('пустой текст без failReason (генерация молчит) — тоже день НЕ возвращаем, как прочие сбои', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => ok('')) }; // failed:false, но текст пуст
    const rows = [row({ last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('looksLikeFailure (CLI вернул ошибку текстом) — день НЕ возвращаем, повтор не планируем', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => ok('Failed to authenticate: OAuth session expired')) };
    const rows = [row({ last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('сводка в TG считает только реально доставленные, не все попытки (CLI-сбой текстом не в счёте)', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = {
      generateAgentReplyOutcome: jest.fn()
        .mockResolvedValueOnce(ok('Failed to authenticate: OAuth session expired')) // r1: CLI-сбой текстом, delivered=0
        .mockResolvedValueOnce(ok('Доброе утро!')), // r2: настоящая доставка
    };
    const rows = [row({ id: 'r1', user_id: 'u1' }), row({ id: 'r2', user_id: 'u2' })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('Рутинные пуши разосланы: 1'));
  });

  it('лог «отложена» — по id рутины (uuid), без user_id и без заголовка рутины (без номеров в журнале)', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = {
      generateAgentReplyOutcome: jest.fn()
        .mockRejectedValueOnce(new RelaySessionBusyError())
        .mockResolvedValueOnce(failed('preempted', 'обрывок')),
    };
    const rows = [
      row({ id: 'routine-uuid-1', user_id: 'u1', title: 'Моя рутина', last_sent_date: null }),
      row({ id: 'routine-uuid-2', user_id: 'u1', title: 'Другая рутина', last_sent_date: '2026-11-02' }),
    ];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    await svc.runDue();

    const deferredLines = logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('отложена'));
    expect(deferredLines).toHaveLength(2);
    for (const line of deferredLines) {
      expect(line).not.toContain('u1');
      expect(line).not.toContain('Моя рутина');
      expect(line).not.toContain('Другая рутина');
    }
    expect(deferredLines[0]).toContain('routine-uuid-1');
    expect(deferredLines[1]).toContain('routine-uuid-2');
  });
});

describe('RoutinePushService.fireNow — «Проверить сейчас» честно про busy/failed', () => {
  afterEach(() => jest.clearAllMocks());

  it('на занятой сессии релея — { delivered: 0, busy: true }, пуш не отправлен', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => { throw new RelaySessionBusyError(); }) };
    const store = { getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    const result = await svc.fireNow('u1', 'r1');

    expect(result).toEqual({ delivered: 0, busy: true });
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('на пустой/сбойной генерации — { delivered: 0, failed: true }, пуш не отправлен (busy — отдельный признак)', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReplyOutcome: jest.fn(async () => failed('max_turns')) };
    const store = { getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    const result = await svc.fireNow('u1', 'r1');

    expect(result).toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
    expect(result!.busy).toBeUndefined();
    expect(push.sendPush).not.toHaveBeenCalled();
  });
});

describe('RoutinePushController — action:test пробрасывает busy/failed в JSON', () => {
  it('busy: true уходит в ответ', async () => {
    const routines = { fireNow: jest.fn(async () => ({ delivered: 0, busy: true })) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, delivered: 0, busy: true });
  });

  it('failed: true уходит в ответ', async () => {
    const routines = { fireNow: jest.fn(async () => ({ delivered: 0, failed: true })) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, delivered: 0, failed: true });
  });

  it('обычная доставка — ни busy, ни failed в ответе', async () => {
    const routines = { fireNow: jest.fn(async () => ({ delivered: 1 })) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.json).toHaveBeenCalledWith({ ok: true, delivered: 1 });
  });
});
