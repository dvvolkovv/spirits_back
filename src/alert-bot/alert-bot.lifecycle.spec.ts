import 'reflect-metadata';
import { inspect } from 'util';
import * as telegramAlert from '../common/telegram-alert';
import { AlertBotLifecycle } from './alert-bot.lifecycle';

const ORIGINAL_ENV = { ...process.env };
const RESTART_REPLY = 'Ответ оборвался перезапуском — спросите ещё раз';

type Mocks = {
  store: {
    migrate: jest.Mock<Promise<void>, []>;
    interruptInProgress: jest.Mock<Promise<Array<{ id: string; chatId: string; questionMessageId: number }>>, []>;
    recordAlert: jest.Mock<Promise<void>, [string, number, string]>;
    cleanup: jest.Mock<Promise<void>, []>;
    requeueProcessingUpdates: jest.Mock<Promise<void>, []>;
  };
  repairStore: {
    migrate: jest.Mock<Promise<void>, []>;
  };
  ops: {
    start: jest.Mock<Promise<void>, []>;
    stop: jest.Mock<Promise<void>, []>;
  };
  telegram: {
    registerWebhook: jest.Mock<Promise<void>, []>;
    sendMessage: jest.Mock<Promise<{ message_id: number }>, [string, string, number]>;
  };
  pg: {
    registerPreCloseHook: jest.Mock<void, [() => Promise<void>]>;
  };
};

function makeMocks(): Mocks {
  return {
    store: {
      migrate: jest.fn().mockResolvedValue(undefined),
      interruptInProgress: jest.fn().mockResolvedValue([]),
      recordAlert: jest.fn().mockResolvedValue(undefined),
      cleanup: jest.fn().mockResolvedValue(undefined),
      requeueProcessingUpdates: jest.fn().mockResolvedValue(undefined),
    },
    repairStore: {
      migrate: jest.fn().mockResolvedValue(undefined),
    },
    ops: {
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
    },
    telegram: {
      registerWebhook: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
    },
    pg: {
      registerPreCloseHook: jest.fn(),
    },
  };
}

function enabled(): void {
  process.env.ALERT_BOT_WEBHOOK_URL = 'https://example.test/webhook/alert-bot/telegram';
  process.env.ALERT_BOT_WEBHOOK_SECRET = 'secret';
}

describe('AlertBotLifecycle', () => {
  let mocks: Mocks;
  let lifecycle: AlertBotLifecycle;
  let sinkSpy: jest.SpyInstance<void, [telegramAlert.AlertSentSink | null]>;

  beforeEach(() => {
    jest.useFakeTimers();
    mocks = makeMocks();
    lifecycle = new (AlertBotLifecycle as any)(
      mocks.store, mocks.ops, mocks.telegram,
      { idle: jest.fn().mockResolvedValue(undefined) },
      { retryFailedUpdates: jest.fn().mockResolvedValue(undefined), stopAdmission: jest.fn() },
      mocks.pg,
    );
    (lifecycle as any).repairStore = mocks.repairStore;
    sinkSpy = jest.spyOn(telegramAlert, 'setAlertSentSink');
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
    telegramAlert.setAlertSentSink(null);
    process.env = { ...ORIGINAL_ENV };
  });

  it('без URL/secret выполняет только миграцию и не открывает вход', async () => {
    delete process.env.ALERT_BOT_WEBHOOK_URL;
    delete process.env.ALERT_BOT_WEBHOOK_SECRET;

    await lifecycle.onModuleInit();

    expect(mocks.store.migrate).toHaveBeenCalledTimes(1);
    expect(mocks.repairStore.migrate).toHaveBeenCalledTimes(1);
    expect(mocks.store.migrate.mock.invocationCallOrder[0]).toBeLessThan(mocks.repairStore.migrate.mock.invocationCallOrder[0]);
    expect(mocks.repairStore.migrate.mock.invocationCallOrder[0]).toBeLessThan(mocks.pg.registerPreCloseHook.mock.invocationCallOrder[0]);
    expect(mocks.pg.registerPreCloseHook).toHaveBeenCalledTimes(1);
    expect(mocks.store.interruptInProgress).not.toHaveBeenCalled();
    expect(mocks.ops.start).not.toHaveBeenCalled();
    expect(mocks.telegram.registerWebhook).not.toHaveBeenCalled();
    expect(sinkSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('при включении соблюдает порядок запуска, ставит sink и отвечает на каждый прерванный вопрос', async () => {
    enabled();
    const calls: string[] = [];
    mocks.store.migrate.mockImplementation(async () => { calls.push('migrate'); });
    mocks.repairStore.migrate.mockImplementation(async () => { calls.push('repair.migrate'); });
    mocks.store.interruptInProgress.mockImplementation(async () => {
      calls.push('interrupt');
      return [
        { id: 'turn-1', chatId: 'chat-1', questionMessageId: 101 },
        { id: 'turn-2', chatId: 'chat-2', questionMessageId: 202 },
      ];
    });
    mocks.ops.start.mockImplementation(async () => { calls.push('ops.start'); });
    mocks.store.requeueProcessingUpdates.mockImplementation(async () => { calls.push('requeue'); });
    sinkSpy.mockImplementation((sink) => { if (sink) calls.push('sink'); });
    mocks.telegram.sendMessage.mockImplementation(async (chatId) => {
      calls.push(`reply:${chatId}`);
      return { message_id: 1 };
    });
    mocks.store.cleanup.mockImplementation(async () => { calls.push('cleanup'); });

    await lifecycle.onModuleInit();

    expect(calls).toEqual([
      'migrate', 'repair.migrate', 'ops.start', 'interrupt', 'requeue', 'sink', 'reply:chat-1', 'reply:chat-2', 'cleanup',
    ]);
    expect(mocks.telegram.sendMessage).toHaveBeenNthCalledWith(1, 'chat-1', RESTART_REPLY, 101);
    expect(mocks.telegram.sendMessage).toHaveBeenNthCalledWith(2, 'chat-2', RESTART_REPLY, 202);
    expect(mocks.telegram.registerWebhook).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(2);

    const sink = sinkSpy.mock.calls[0][0];
    expect(sink).not.toBeNull();
    await sink!('chat-1', 303, 'alert text');
    expect(mocks.store.recordAlert).toHaveBeenCalledWith('chat-1', 303, 'alert text');
  });

  it('ошибка registerWebhook журналируется без сырого текста и не валит запуск', async () => {
    enabled();
    const loggerError = jest.spyOn((lifecycle as any).logger, 'error').mockImplementation(() => undefined);
    mocks.telegram.registerWebhook.mockRejectedValue(Object.assign(new Error('RAW-SECRET-DETAIL'), { code: 'ETELEGRAM' }));

    await expect(lifecycle.onModuleInit()).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerError).toHaveBeenCalledWith('alert-bot registration failed: ETELEGRAM');
    const logs = inspect(loggerError.mock.calls, { depth: null });
    expect(logs).not.toContain('RAW-SECRET-DETAIL');
  });

  it('onModuleDestroy снимает sink и очищает intervals, ops останавливается заранее', async () => {
    enabled();
    await lifecycle.onModuleInit();
    expect(jest.getTimerCount()).toBe(2);

    await lifecycle.beforeApplicationShutdown();
    await lifecycle.onModuleDestroy();

    expect(sinkSpy).toHaveBeenLastCalledWith(null);
    expect(jest.getTimerCount()).toBe(0);
    expect(mocks.ops.stop).toHaveBeenCalledTimes(1);
  });

  it('beforeApplicationShutdown ограниченно ждёт turns и останавливает ops до закрытия пула', async () => {
    enabled();
    const calls: string[] = [];
    const turns = { idle: jest.fn(() => { calls.push('turns.idle'); return new Promise<void>(() => {}); }) };
    const service = { retryFailedUpdates: jest.fn(), stopAdmission: jest.fn() };
    mocks.ops.stop.mockImplementation(async () => { calls.push('ops.stop'); });
    lifecycle = new (AlertBotLifecycle as any)(mocks.store, mocks.ops, mocks.telegram, turns, service, mocks.pg);
    (lifecycle as any).repairStore = mocks.repairStore;
    await lifecycle.onModuleInit();

    const shutdown = (lifecycle as any).beforeApplicationShutdown();
    await jest.advanceTimersByTimeAsync(5000);
    await shutdown;
    calls.push('pool.close');
    await lifecycle.onModuleDestroy();

    expect(calls).toEqual(['turns.idle', 'ops.stop', 'pool.close']);
    expect(mocks.ops.stop).toHaveBeenCalledTimes(1);
  });

  it('ошибка repair migration не открывает turns и ops', async () => {
    enabled();
    const failure = new Error('repair migration failed');
    mocks.repairStore.migrate.mockRejectedValue(failure);

    await expect(lifecycle.onModuleInit()).rejects.toBe(failure);

    expect(mocks.store.interruptInProgress).not.toHaveBeenCalled();
    expect(mocks.ops.start).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ошибка миграции пробрасывается, вход и ops не открываются', async () => {
    enabled();
    const failure = new Error('migration failed');
    mocks.store.migrate.mockRejectedValue(failure);

    await expect(lifecycle.onModuleInit()).rejects.toBe(failure);

    expect(mocks.store.interruptInProgress).not.toHaveBeenCalled();
    expect(mocks.repairStore.migrate).not.toHaveBeenCalled();
    expect(mocks.ops.start).not.toHaveBeenCalled();
    expect(mocks.telegram.registerWebhook).not.toHaveBeenCalled();
    expect(sinkSpy).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
