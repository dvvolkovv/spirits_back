import { MeetingWebhookDeliveryService, retryDelayMs } from './meet-webhook-delivery.service';

const EVENT = {
  id: '1',
  callId: 'c1',
  trigger: 'bot.state_change',
  message: { v: 1, type: 'meet_bot_state', state: 'joined', fatal: false },
  attempts: 1,
};

describe('MeetingWebhookDeliveryService', () => {
  let inbox: Record<string, jest.Mock>;
  let calls: { load: jest.Mock; isActive: jest.Mock };
  let livekit: { send: jest.Mock };
  let svc: MeetingWebhookDeliveryService;

  beforeEach(() => {
    inbox = {
      claimBatch: jest.fn().mockResolvedValue([]),
      markDelivered: jest.fn().mockResolvedValue(true),
      markDiscarded: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue('pending'),
      cleanup: jest.fn().mockResolvedValue({ completed: 0, dead: 0 }),
    };
    calls = {
      load: jest.fn().mockResolvedValue({ id: 'c1', room_name: 'meet_c1', status: 'active' }),
      isActive: jest.fn().mockReturnValue(true),
    };
    livekit = { send: jest.fn().mockResolvedValue(undefined) };
    svc = new MeetingWebhookDeliveryService(inbox as any, calls as any, livekit as any);
    for (const level of ['log', 'warn', 'error', 'debug']) {
      jest.spyOn((svc as any).logger, level).mockImplementation(() => {});
    }
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('доставляет точное сообщение в комнату и отмечает delivered', async () => {
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect(livekit.send).toHaveBeenCalledWith('meet_c1', EVENT.message);
    expect(inbox.markDelivered).toHaveBeenCalledWith('1', 1);
    expect(inbox.markFailed).not.toHaveBeenCalled();
  });

  it('неактивный звонок — discard без отправки', async () => {
    calls.isActive.mockReturnValue(false);
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect(inbox.markDiscarded).toHaveBeenCalledWith('1', 1, 'call missing or inactive');
    expect(livekit.send).not.toHaveBeenCalled();
    expect(inbox.markFailed).not.toHaveBeenCalled();
  });

  it('отсутствующий звонок — discard; stale discard не ретраит', async () => {
    calls.load.mockResolvedValue(null);
    inbox.markDiscarded.mockResolvedValue(false);
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect(inbox.markDiscarded).toHaveBeenCalledWith('1', 1, 'call missing or inactive');
    expect(livekit.send).not.toHaveBeenCalled();
    expect(inbox.markFailed).not.toHaveBeenCalled();
    expect((svc as any).logger.debug).toHaveBeenCalled();
  });

  it('временный сбой отправки: pending, затем вторая попытка доставляет', async () => {
    livekit.send.mockRejectedValueOnce(new Error('room busy'));
    inbox.claimBatch
      .mockResolvedValueOnce([EVENT])
      .mockResolvedValueOnce([{ ...EVENT, attempts: 2 }]);
    await svc.pump();
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'room busy', expect.any(Date));
    expect(inbox.markDelivered).not.toHaveBeenCalled();
    await svc.pump();
    expect(inbox.markDelivered).toHaveBeenCalledWith('1', 2);
    expect(livekit.send).toHaveBeenCalledTimes(2);
  });

  it('calls.load упал на 10-й попытке: dead, без отправки', async () => {
    calls.load.mockRejectedValue(new Error('db unavailable'));
    inbox.markFailed.mockResolvedValue('dead');
    inbox.claimBatch.mockResolvedValueOnce([{ ...EVENT, attempts: 10 }]);
    await svc.pump();
    expect(livekit.send).not.toHaveBeenCalled();
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 10, 'db unavailable', expect.any(Date));
    expect((svc as any).logger.error).toHaveBeenCalled();
  });

  it('зависшая отправка обрывается через 10 секунд', async () => {
    jest.useFakeTimers();
    livekit.send.mockReturnValue(new Promise(() => {}));
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    const run = svc.pump();
    await jest.advanceTimersByTimeAsync(10_000);
    await run;
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'livekit send timeout', expect.any(Date));
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });

  it('markDelivered упал после отправки — markFailed (исход неопределён, повтор)', async () => {
    inbox.markDelivered.mockRejectedValue(new Error('db died after send'));
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect(livekit.send).toHaveBeenCalledTimes(1);
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'db died after send', expect.any(Date));
  });

  it('markDelivered вернул false — stale, markFailed не зовём', async () => {
    inbox.markDelivered.mockResolvedValue(false);
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect(inbox.markFailed).not.toHaveBeenCalled();
    expect((svc as any).logger.warn).toHaveBeenCalled();
  });

  it('markFailed вернул null — нет ложного лога pending/dead', async () => {
    livekit.send.mockRejectedValue(new Error('boom'));
    inbox.markFailed.mockResolvedValue(null);
    inbox.claimBatch.mockResolvedValueOnce([EVENT]);
    await svc.pump();
    expect((svc as any).logger.error).not.toHaveBeenCalled();
    expect((svc as any).logger.warn).not.toHaveBeenCalled();
    expect((svc as any).logger.debug).toHaveBeenCalled();
  });

  it('markFailed сам упал — батч не падает, остальные события идут дальше', async () => {
    livekit.send.mockRejectedValueOnce(new Error('boom'));
    inbox.markFailed.mockRejectedValue(new Error('pg down'));
    inbox.claimBatch.mockResolvedValueOnce([EVENT, { ...EVENT, id: '2' }]);
    await expect(svc.pump()).resolves.toBeUndefined();
    expect(inbox.markDelivered).toHaveBeenCalledWith('2', 1);
  });

  it('recovered-событие логируется предупреждением с id', async () => {
    inbox.claimBatch.mockResolvedValueOnce([{ ...EVENT, recovered: true }]);
    await svc.pump();
    expect((svc as any).logger.warn).toHaveBeenCalledWith(expect.stringContaining('1'));
  });

  it('реентерабельный pump не делает второй claim', async () => {
    let release!: (v: any[]) => void;
    inbox.claimBatch.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const first = svc.pump();
    await svc.pump();
    expect(inbox.claimBatch).toHaveBeenCalledTimes(1);
    release([]);
    await first;
  });

  it('running сбрасывается, если claimBatch упал', async () => {
    inbox.claimBatch.mockRejectedValueOnce(new Error('pg'));
    await expect(svc.pump()).rejects.toThrow('pg');
    await svc.pump();
    expect(inbox.claimBatch).toHaveBeenCalledTimes(2);
  });

  it('kick не бросает и не даёт unhandled rejection', async () => {
    inbox.claimBatch.mockRejectedValueOnce(new Error('pg'));
    expect(() => svc.kick()).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect((svc as any).logger.error).toHaveBeenCalled();
  });

  it('poll делегирует в kick', () => {
    const kick = jest.spyOn(svc, 'kick').mockImplementation(() => {});
    svc.poll();
    expect(kick).toHaveBeenCalled();
  });

  it('retryDelayMs: 1/2/3/4/5/10 → 1s/2s/5s/15s/60s/60s', () => {
    expect([1, 2, 3, 4, 5, 10].map(retryDelayMs)).toEqual([1000, 2000, 5000, 15000, 60000, 60000]);
  });

  it('retention вызывает cleanup и глотает ошибки', async () => {
    await svc.retention();
    expect(inbox.cleanup).toHaveBeenCalledTimes(1);
    inbox.cleanup.mockRejectedValue(new Error('x'));
    await expect(svc.retention()).resolves.toBeUndefined();
  });
});
