import { RoutinePushService } from './routine-push.service';
import { RoutinePushController } from './routine-push.controller';
import { RoutineStore } from './routine-store.service';
import { RelaySessionBusyError } from '../chat/chat.service';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));
import { sendTelegramAlert } from '../common/telegram-alert';

const ok = (text: string) => ({ text, failed: false, failReason: undefined });
const failed = (failReason?: string, text = '') => ({ text, failed: true, failReason });
const row = (overrides: Record<string, any> = {}) => ({
  id: 'r1', user_id: 'u1', title: 'Энергия дня', assistant_id: '14',
  prompt: 'энергия дня', send_hour: 8, tz: 'Europe/Moscow', days: null,
  last_sent_date: null,
  ...overrides,
});

function makeStore(overrides: Record<string, jest.Mock> = {}) {
  return {
    listEnabled: jest.fn(async () => []),
    getById: jest.fn(async () => ({
      id: 'r1', userId: 'u1', title: 'Энергия дня', assistantId: '14',
      prompt: 'энергия дня', sendHour: 8, tz: 'Europe/Moscow', days: null,
      enabled: true, lastSentDate: null,
    })),
    scheduledToday: jest.fn(() => true),
    localHour: jest.fn(() => 9),
    localDate: jest.fn(() => '2026-11-03'),
    toISO: jest.fn((d: any) => String(d).slice(0, 10)),
    claimToday: jest.fn(async () => true),
    releaseToday: jest.fn(async () => true),
    ...overrides,
  };
}

function makeService(
  chatImpl: jest.Mock,
  rows: any[] = [row()],
  storeOverrides: Record<string, jest.Mock> = {},
) {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const push = { sendPush: jest.fn(async () => 1) };
  const store = makeStore({
    listEnabled: jest.fn(async () => rows),
    ...storeOverrides,
  });
  const chat = { generateAgentReplyOutcome: chatImpl };
  const svc = new RoutinePushService(pg as any, push as any, chat as any, store as any);
  return { svc, store, push, chat, pg };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe('RoutineStore.releaseToday — восстановление прежнего дня', () => {
  it('возвращает prev только при ещё совпадающем today', async () => {
    const pg = {
      query: jest.fn(async (_sql: string, _params: any[] = []) => ({ rows: [{ id: 'r1' }], rowCount: 1 })),
    };
    const store = new RoutineStore(pg as any);

    await expect(store.releaseToday('r1', '2026-11-03', '2026-11-02')).resolves.toBe(true);
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringMatching(/UPDATE routine_pushes SET last_sent_date = \$3/),
      ['r1', '2026-11-03', '2026-11-02'],
    );
    expect(pg.query.mock.calls[0][0]).toMatch(/WHERE id = \$1 AND last_sent_date = \$2 RETURNING id/);
  });

  it('stale claim не трогает и сообщает false', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) };
    const store = new RoutineStore(pg as any);
    await expect(store.releaseToday('r1', '2026-11-03', null)).resolves.toBe(false);
  });
});

describe('runDue — день освобождается только при busy/preempted', () => {
  it('busy — release с prev, пуша нет, следующая рутина продолжается', async () => {
    const chat = jest.fn()
      .mockRejectedValueOnce(new RelaySessionBusyError('u1_14_ru'))
      .mockResolvedValueOnce(ok('Доброе утро!'));
    const rows = [row({ id: 'r1' }), row({ id: 'r2', user_id: 'u2' })];
    const { svc, store, push } = makeService(chat, rows);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', null);
    expect(store.releaseToday).toHaveBeenCalledTimes(1);
    expect(push.sendPush).toHaveBeenCalledTimes(1);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it('preempted — release с прежним last_sent_date, пуша нет, текущий retry сохранён', async () => {
    const chat = jest.fn(async () => failed('preempted', 'обрывок'));
    const { svc, store, push } = makeService(chat, [row({ last_sent_date: '2026-11-02' })]);

    await svc.runDue();

    expect(store.releaseToday).toHaveBeenCalledWith('r1', '2026-11-03', '2026-11-02');
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(1);
  });

  it.each([
    ['transient_after_write', failed('transient_after_write')],
    ['max_turns', failed('max_turns')],
    ['cli_fatal', failed('cli_fatal')],
    ['cli_failure_text', ok('Failed to authenticate: OAuth session expired')],
    ['empty', ok('')],
  ])('%s — без release, истории, пуша, автоматического retry и TG', async (_name, outcome) => {
    const chat = jest.fn(async () => outcome);
    const { svc, store, push, pg } = makeService(chat);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
    const inserts = pg.query.mock.calls.filter((c: any[]) => /INSERT INTO custom_chat_history/.test(c[0]));
    expect(inserts).toHaveLength(0);
  });

  it('исключение потока — день не освобождается, retry и TG не запускаются', async () => {
    const chat = jest.fn(async () => { throw new Error('relay down'); });
    const { svc, store, push } = makeService(chat);

    await svc.runDue();

    expect(store.releaseToday).not.toHaveBeenCalled();
    expect(push.sendPush).not.toHaveBeenCalled();
    expect((svc as any).retryTimers.size).toBe(0);
    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('TG-сводка считает только delivered>0, не попытки и не запись в историю', async () => {
    const chat = jest.fn()
      .mockResolvedValueOnce(ok('Failed to authenticate: OAuth session expired'))
      .mockResolvedValueOnce(ok('Первый ответ'))
      .mockResolvedValueOnce(ok('Второй ответ'));
    const rows = [row({ id: 'r1' }), row({ id: 'r2', user_id: 'u2' }), row({ id: 'r3', user_id: 'u3' })];
    const { svc, push } = makeService(chat, rows);
    push.sendPush.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await svc.runDue();

    expect(push.sendPush).toHaveBeenCalledTimes(2);
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlert).toHaveBeenCalledWith('🔔 Рутинные пуши разосланы: 1');
  });

  it.each([
    ['preempted', 'log'],
    ['max_turns', 'warn'],
  ])('deliver логирует %s через %s без userId и заголовка', async (reason, level) => {
    const chat = jest.fn(async () => failed(reason, 'обрывок'));
    const { svc } = makeService(chat);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.runDue();

    const deliverLines = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((c) => String(c[0])).filter((s) => s.startsWith('routine deliver:'));
    expect(deliverLines).toHaveLength(1);
    expect(deliverLines[0]).toContain(reason);
    expect(deliverLines[0]).not.toContain('u1');
    expect(deliverLines[0]).not.toContain('Энергия дня');
    const expectedSpy = level === 'log' ? logSpy : warnSpy;
    const otherSpy = level === 'log' ? warnSpy : logSpy;
    expect(expectedSpy.mock.calls.some((c) => String(c[0]).startsWith('routine deliver:'))).toBe(true);
    expect(otherSpy.mock.calls.some((c) => String(c[0]).startsWith('routine deliver:'))).toBe(false);
  });

  it('пустой ответ — warn «пустой ответ», без userId, заголовка и ложного failReason', async () => {
    const chat = jest.fn(async () => ok(''));
    const { svc } = makeService(chat);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.runDue();

    const deliverLines = warnSpy.mock.calls.map((c) => String(c[0]))
      .filter((s) => s.startsWith('routine deliver:'));
    expect(deliverLines).toHaveLength(1);
    expect(deliverLines[0]).toContain('пустой ответ');
    expect(deliverLines[0]).not.toContain('ход не завершён');
    expect(deliverLines[0]).not.toContain('u1');
    expect(deliverLines[0]).not.toContain('Энергия дня');
  });

  it('CLI failure текстом — лог без userId, заголовка и самого текста ошибки', async () => {
    const text = 'Failed to authenticate: OAuth session expired';
    const chat = jest.fn(async () => ok(text));
    const { svc } = makeService(chat);
    const errorSpy = jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    await svc.runDue();

    const deliverLines = errorSpy.mock.calls.map((c) => String(c[0]))
      .filter((s) => s.startsWith('routine deliver:'));
    expect(deliverLines).toHaveLength(1);
    expect(deliverLines[0]).toContain('cli_failure_text');
    expect(deliverLines[0]).not.toContain(text);
    expect(deliverLines[0]).not.toContain('u1');
    expect(deliverLines[0]).not.toContain('Энергия дня');
  });

  it('busy/preempted deferred-логи не содержат userId и пользовательский заголовок', async () => {
    const chat = jest.fn()
      .mockRejectedValueOnce(new RelaySessionBusyError('u1_14_ru'))
      .mockResolvedValueOnce(failed('preempted', 'обрывок'));
    const rows = [
      row({ id: 'routine-uuid-1', title: 'Моя рутина' }),
      row({ id: 'routine-uuid-2', title: 'Другая рутина', last_sent_date: '2026-11-02' }),
    ];
    const { svc } = makeService(chat, rows);
    const logSpy = jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);

    await svc.runDue();

    const deferred = logSpy.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('отложена'));
    expect(deferred).toHaveLength(2);
    expect(deferred[0]).toContain('routine-uuid-1');
    expect(deferred[1]).toContain('routine-uuid-2');
    for (const line of deferred) {
      expect(line).not.toContain('u1');
      expect(line).not.toContain('Моя рутина');
      expect(line).not.toContain('Другая рутина');
    }
  });
});

describe('fireNow и action:test — честные delivered/busy/failed', () => {
  it('busy — { delivered:0, busy:true }, пуша нет и чужой claim не откатывается', async () => {
    const chat = jest.fn(async () => { throw new RelaySessionBusyError('u1_14_ru'); });
    const { svc, store, push } = makeService(chat);

    await expect(svc.fireNow('u1', 'r1')).resolves.toEqual({ delivered: 0, busy: true });
    expect(push.sendPush).not.toHaveBeenCalled();
    expect(store.releaseToday).not.toHaveBeenCalled();
  });

  it('max_turns — { delivered:0, failed:true, failReason }, busy отсутствует', async () => {
    const chat = jest.fn(async () => failed('max_turns'));
    const { svc, push } = makeService(chat);

    const result = await svc.fireNow('u1', 'r1');
    expect(result).toEqual({ delivered: 0, failed: true, failReason: 'max_turns' });
    expect(result!.busy).toBeUndefined();
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it('CLI failure текстом — failed:true с безопасной локальной причиной', async () => {
    const chat = jest.fn(async () => ok('Failed to authenticate: OAuth session expired'));
    const { svc, push } = makeService(chat);

    await expect(svc.fireNow('u1', 'r1')).resolves.toEqual({
      delivered: 0, failed: true, failReason: 'cli_failure_text',
    });
    expect(push.sendPush).not.toHaveBeenCalled();
  });

  it.each([
    [{ delivered: 0, busy: true }, { ok: true, delivered: 0, busy: true }],
    [{ delivered: 0, failed: true, failReason: 'max_turns' }, { ok: true, delivered: 0, failed: true }],
    [{ delivered: 1 }, { ok: true, delivered: 1 }],
  ])('контроллер пробрасывает %j как %j', async (serviceResult, expected) => {
    const routines = { fireNow: jest.fn(async () => serviceResult) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.json).toHaveBeenCalledWith(expected);
  });

  it('контроллер сохраняет 404 для отсутствующей рутины', async () => {
    const routines = { fireNow: jest.fn(async () => null) };
    const ctrl = new RoutinePushController(routines as any, {} as any);
    const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };

    await ctrl.mutate({ userId: 'u1' } as any, { action: 'test', id: 'r1' }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'not found' });
  });
});
