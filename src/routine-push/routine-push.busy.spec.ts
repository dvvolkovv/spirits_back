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
 * RelaySessionBusyError или пустая генерация — отметка возвращается
 * (releaseToday), следующий часовой крон попробует снова. looksLikeFailure
 * (CLI вернул ошибку текстом) — день НЕ возвращаем, это не «сессия занята
 * прямо сейчас», повтор раз в час на сломанной авторизации CLI слал бы
 * алерты без толку.
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
    const ok = await store.releaseToday('r1', '2026-11-03', null);
    expect(ok).toBe(true);
    const call = calls.find((c) => /UPDATE routine_pushes/.test(c.sql));
    expect(call).toBeDefined();
    expect(call!.sql).toMatch(/last_sent_date\s*=\s*\$3/);
    expect(call!.sql).toMatch(/WHERE id = \$1 AND last_sent_date = \$2/);
    expect(call!.params).toEqual(['r1', '2026-11-03', null]);
  });

  it('не трогает отметку, если её уже сменили (gone stale) — возвращает false', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const store = new RoutineStore(pg as any);
    const ok = await store.releaseToday('r1', '2026-11-03', null);
    expect(ok).toBe(false);
  });
});

describe('RoutinePushService.runDue — перенос при занятой сессии/сбое', () => {
  afterEach(() => jest.clearAllMocks());

  it('RelaySessionBusyError — releaseToday вызван с прежним last_sent_date, пуш не отправлен, другие рутины продолжаются', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = {
      generateAgentReply: jest.fn()
        .mockRejectedValueOnce(new RelaySessionBusyError())
        .mockResolvedValueOnce('Доброе утро!'),
    };
    const rows = [row({ id: 'r1', user_id: 'u1', last_sent_date: null }), row({ id: 'r2', user_id: 'u2', last_sent_date: null })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', null);
    expect(store.releaseToday).toHaveBeenCalledTimes(1); // r2 доставлена, её не трогаем
    expect(push.sendPush).toHaveBeenCalledTimes(1); // только r2
    expect(chat.generateAgentReply).toHaveBeenCalledTimes(2); // обе рутины попытались
  });

  it('пустая генерация (сбойный ход) — releaseToday вызван, пуш не отправлен', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReply: jest.fn(async () => '') };
    const rows = [row({ last_sent_date: '2026-11-02' })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', '2026-11-02');
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('looksLikeFailure (CLI вернул ошибку текстом) — день НЕ возвращаем, повтор не планируем', async () => {
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReply: jest.fn(async () => 'Failed to authenticate: OAuth session expired') };
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
      generateAgentReply: jest.fn()
        .mockResolvedValueOnce('Failed to authenticate: OAuth session expired') // r1: CLI-сбой текстом, delivered=0
        .mockResolvedValueOnce('Доброе утро!'), // r2: настоящая доставка
    };
    const rows = [row({ id: 'r1', user_id: 'u1' }), row({ id: 'r2', user_id: 'u2' })];
    const store = makeStore({ listEnabled: jest.fn(async () => rows) });
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    await svc.runDue();

    expect(sendTelegramAlert).toHaveBeenCalledWith(expect.stringContaining('Рутинные пуши разосланы: 1'));
  });
});

describe('RoutinePushService.fireNow — «Проверить сейчас» честно про busy/failed', () => {
  afterEach(() => jest.clearAllMocks());

  it('на занятой сессии релея — { delivered: 0, busy: true }, пуш не отправлен', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReply: jest.fn(async () => { throw new RelaySessionBusyError(); }) };
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

  it('на пустой генерации — { delivered: 0, failed: true }, пуш не отправлен', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const push = { sendPush: jest.fn(async () => 1) };
    const chat = { generateAgentReply: jest.fn(async () => '') };
    const store = { getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })) };
    const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);

    const result = await svc.fireNow('u1', 'r1');

    expect(result).toEqual({ delivered: 0, failed: true });
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
