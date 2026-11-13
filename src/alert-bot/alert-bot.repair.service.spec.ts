import { AlertBotRepairService } from './alert-bot.repair.service';
import { RepairJobRecord, RepairRecord } from './alert-bot.repair-store';
import { RepairTurnInput } from './alert-bot.types';

const REPAIR_ID = 'repair-1';
const TURN_ID = 'turn-1';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function repair(status: RepairRecord['status'] = 'requested'): RepairRecord {
  return {
    id: REPAIR_ID,
    updateId: 1,
    turnId: status === 'requested' ? null : TURN_ID,
    chatId: '100',
    adminTgId: '200',
    instruction: 'Почини ошибку',
    status,
    failureKind: null,
    mutationCount: 0,
    createdAt: new Date('2026-11-12T00:00:00Z'),
    finishedAt: null,
  };
}

function job(sequence: number, kind: 'exec' | 'verify', mutates: boolean): RepairJobRecord {
  return {
    id: `job-${sequence}`,
    repairId: REPAIR_ID,
    sequence,
    host: 'test',
    command: kind === 'exec' ? 'pnpm fix' : 'pnpm test',
    kind,
    mutates,
    interruptible: true,
    timeoutMs: 1000,
    status: 'succeeded',
    exitCode: 0,
    stdout: '',
    stderr: '',
    failureKind: null,
  };
}

function input(overrides: Partial<RepairTurnInput> = {}): RepairTurnInput {
  return {
    updateId: 1,
    chatId: '100',
    tgUserId: '200',
    adminUserId: 'admin-1',
    questionMessageId: 300,
    question: 'Почини ошибку',
    privateChat: true,
    mode: 'repair',
    repairId: REPAIR_ID,
    ...overrides,
  };
}

describe('AlertBotRepairService', () => {
  const savedAdmins = process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS;
  let store: Record<string, jest.Mock>;
  let ai: { repair: jest.Mock };
  let executor: { stopRepair: jest.Mock; stopAll: jest.Mock };
  let service: AlertBotRepairService;

  beforeEach(() => {
    process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = '200';
    store = {
      admitRepair: jest.fn().mockResolvedValue({ status: 'accepted', repairId: REPAIR_ID }),
      abandon: jest.fn().mockResolvedValue(true),
      findRepair: jest.fn().mockResolvedValue(repair()),
      findActiveRepair: jest.fn().mockResolvedValue(repair('running')),
      markRepairRunning: jest.fn().mockResolvedValue(true),
      requestCancel: jest.fn().mockResolvedValue(true),
      finishRepair: jest.fn().mockResolvedValue(true),
      listJobs: jest.fn().mockResolvedValue([]),
    };
    ai = {
      repair: jest.fn().mockResolvedValue({
        text: 'Готово', costUsd: 0.25, tools: ['repair_exec'], noCause: false,
      }),
    };
    executor = { stopRepair: jest.fn().mockResolvedValue(undefined), stopAll: jest.fn().mockResolvedValue(undefined) };
    service = new AlertBotRepairService(store as any, ai as any, executor as any);
  });

  afterEach(() => {
    if (savedAdmins === undefined) delete process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS;
    else process.env.ALERT_BOT_REPAIR_ADMIN_TG_IDS = savedAdmins;
    jest.restoreAllMocks();
  });

  it('подтверждает исправление по verify после последнего mutation и маскирует summary', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const hashPath = '/tmp/7c332707003ac67af11cf1ec081e4744/a.docx';
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);
    ai.repair.mockResolvedValue({
      text: `Исправлен ${uuid}; отчёт ${hashPath}`,
      costUsd: 0.5,
      tools: ['repair_exec', 'repair_verify'],
      noCause: false,
    });
    const history = [{ question: 'Диагноз', answer: 'Причина' }];

    const result = await service.run(REPAIR_ID, TURN_ID, input(), history);

    expect(ai.repair).toHaveBeenCalledWith(expect.objectContaining({
      ...input(), history, mode: 'repair', repairId: REPAIR_ID, turnId: TURN_ID,
      signal: expect.any(AbortSignal),
    }));
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'verified', 1);
    expect(result).toEqual({
      text: 'Исправлено и проверено\nИсправлен [id]; отчёт /tmp/[скрыто]/a.docx',
      costUsd: 0.5,
      tools: ['repair_exec', 'repair_verify'],
      turnStatus: 'ok',
    });
  });

  it('timeout без verify завершает repair как timeout', async () => {
    ai.repair.mockRejectedValue(Object.assign(new Error('raw timeout'), { kind: 'timeout' }));
    store.listJobs.mockResolvedValue([job(1, 'exec', true)]);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'timeout', 1);
    expect(result.text).toContain('Не исправлено: время истекло');
    expect(result.turnStatus).toBe('timeout');
    expect(result.costUsd).toBe(0);
    expect(result.tools).toEqual([]);
  });

  it('noCause без mutation завершает repair как failed без выдуманного исправления', async () => {
    ai.repair.mockResolvedValue({ text: 'Недостаточно фактов', costUsd: 0.1, tools: [], noCause: true });

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'failed', 0);
    expect(result.text).toBe('Не исправлено: причина не подтверждена\nНедостаточно фактов');
    expect(result.turnStatus).toBe('error');
  });

  it('failed модель не отменяет verified, доказанный успешной final verify в журнале', async () => {
    ai.repair.mockRejectedValue(Object.assign(new Error('raw failure'), { kind: 'failed' }));
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'verified', 1);
    expect(result.turnStatus).toBe('ok');
    expect(result.text).toBe(
      'Исправлено и проверено\nМодель завершилась без текстового пояснения; смотри служебный статус.',
    );
  });

  it('late stop после AI success не позволяет verified перекрыть cancel_requested', async () => {
    await service.stop('100', '200');
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce(repair('cancel_requested'));
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(ai.repair).toHaveBeenCalledTimes(1);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 1);
    expect(result.turnStatus).toBe('error');
    expect(result.text).toContain('Исправление остановлено админом');
    expect(result.text).not.toContain('Исправлено и проверено');
  });

  it('внутренний cancel_requested после AI означает interrupted, а не admin cancel', async () => {
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce(repair('cancel_requested'));
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(ai.repair).toHaveBeenCalledTimes(1);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 1);
    expect(result.text).toContain('Исход неизвестен: исправление прервано');
    expect(result.text).not.toContain('остановлено админом');
  });

  it('stop между derive и finish повторно вычисляет cancelled вместо потерянного verified', async () => {
    await service.stop('100', '200');
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce(repair('cancel_requested'));
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);
    store.finishRepair
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(store.finishRepair).toHaveBeenNthCalledWith(1, REPAIR_ID, 'verified', 1);
    expect(store.finishRepair).toHaveBeenNthCalledWith(2, REPAIR_ID, 'cancelled', 1);
    expect(result.turnStatus).toBe('error');
    expect(result.text).toContain('Исправление остановлено админом');
  });

  it('terminal, сохранённый конкурентным finish, не перезаписывается и используется в ответе', async () => {
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValueOnce({ ...repair('cancelled'), finishedAt: new Date('2026-11-12T01:00:00Z') });
    store.listJobs.mockResolvedValue([job(1, 'exec', true), job(2, 'verify', false)]);
    store.finishRepair.mockResolvedValue(false);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(store.finishRepair).toHaveBeenCalledTimes(1);
    expect(result.turnStatus).toBe('error');
    expect(result.text).toContain('Исправление остановлено админом');
  });

  it('/stop отменяет активный repair, будит модель и останавливает executor', async () => {
    const started = deferred();
    let signal: AbortSignal | undefined;
    ai.repair.mockImplementation((call: { signal: AbortSignal }) => {
      signal = call.signal;
      started.resolve();
      return new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })), { once: true });
      });
    });
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await started.promise;

    await expect(service.stop('100', '200')).resolves.toBe('Исправление остановлено');
    await expect(running).resolves.toMatchObject({ turnStatus: 'error' });

    expect(signal?.aborted).toBe(true);
    expect(store.requestCancel).toHaveBeenCalledWith(REPAIR_ID);
    expect(executor.stopRepair).toHaveBeenCalledWith(REPAIR_ID);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 0);
  });

  it('admin cancel повторно ждёт local stopRepair перед snapshot и получает cancelled', async () => {
    const started = deferred();
    ai.repair.mockImplementation((call: { signal: AbortSignal }) => {
      started.resolve();
      return new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })), { once: true });
      });
    });
    store.listJobs.mockImplementation(() => {
      const closed = executor.stopRepair.mock.calls.length >= 2;
      return [{
        ...job(1, 'exec', true), host: 'prod',
        status: closed ? 'cancelled' : 'running', exitCode: null,
      }];
    });
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await started.promise;

    await service.stop('100', '200');
    const result = await running;

    expect(executor.stopRepair).toHaveBeenCalledTimes(2);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 1);
    expect(result.text).toContain('Исправление остановлено админом');
  });

  it('admin cancel не ждёт remote close и running remote остаётся interrupted', async () => {
    const started = deferred();
    ai.repair.mockImplementation((call: { signal: AbortSignal }) => {
      started.resolve();
      return new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })), { once: true });
      });
    });
    store.listJobs.mockResolvedValue([{ ...job(1, 'exec', true), host: 'relay', status: 'running', exitCode: null }]);
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await started.promise;

    await service.stop('100', '200');
    const result = await running;

    expect(executor.stopRepair).toHaveBeenCalledTimes(2);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 1);
    expect(result.text).toContain('Исход неизвестен: исправление прервано');
  });

  it('/stop не даёт non-admin вызвать mutation', async () => {
    await expect(service.stop('100', '999')).resolves.toBe('Доступ только для администраторов');

    expect(store.findActiveRepair).not.toHaveBeenCalled();
    expect(store.requestCancel).not.toHaveBeenCalled();
    expect(executor.stopRepair).not.toHaveBeenCalled();
  });

  it('/stop без активного repair ничего не отменяет', async () => {
    store.findActiveRepair.mockResolvedValue(null);

    await expect(service.stop('100', '200')).resolves.toBe('Нет активного исправления');

    expect(store.requestCancel).not.toHaveBeenCalled();
    expect(executor.stopRepair).not.toHaveBeenCalled();
  });

  it('/stop при проигранной cancellation race возвращает сохранённый terminal, а не stopped', async () => {
    store.requestCancel.mockResolvedValue(false);
    store.findRepair.mockResolvedValue({
      ...repair('verified'), mutationCount: 1, finishedAt: new Date('2026-11-12T01:00:00Z'),
    });

    await expect(service.stop('100', '200')).resolves.toBe('Исправлено и проверено');

    expect(executor.stopRepair).not.toHaveBeenCalled();
  });

  it('/stop при requestCancel=false и cancel_requested всё равно abort-ит живой AI', async () => {
    const started = deferred();
    let signal: AbortSignal | undefined;
    let rejectAi!: (reason: unknown) => void;
    ai.repair.mockImplementation((call: { signal: AbortSignal }) => {
      signal = call.signal;
      started.resolve();
      return new Promise((_, reject) => {
        rejectAi = reject;
        call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })), { once: true });
      });
    });
    store.requestCancel.mockResolvedValue(false);
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('running'))
      .mockResolvedValue(repair('cancel_requested'));
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await started.promise;

    await expect(service.stop('100', '200')).resolves.toBe('Исправление останавливается');
    const aborted = Boolean(signal?.aborted);
    if (!aborted) {
      rejectAi(new Error('cleanup after red'));
      await running;
    }
    expect(aborted).toBe(true);
    if (aborted) await expect(running).resolves.toMatchObject({ turnStatus: 'error' });
    expect(executor.stopRepair).toHaveBeenCalledWith(REPAIR_ID);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 0);
  });

  it('внутренний cancel_requested до run не вызывает AI и фиксирует interrupted', async () => {
    store.findRepair.mockResolvedValue(repair('cancel_requested'));

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(ai.repair).not.toHaveBeenCalled();
    expect(store.markRepairRunning).not.toHaveBeenCalled();
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 0);
    expect(result).toEqual({
      text: 'Исход неизвестен: исправление прервано', costUsd: 0, tools: [], turnStatus: 'error',
    });
  });

  it('stop до attach: markRepairRunning=false перечитывает cancel_requested и завершает turn result', async () => {
    await service.stop('100', '200');
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('cancel_requested'));
    store.markRepairRunning.mockResolvedValue(false);

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(ai.repair).not.toHaveBeenCalled();
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 0);
    expect(result).toMatchObject({ turnStatus: 'error', text: expect.stringContaining('Исправление остановлено админом') });
  });

  it('stop после attach отменяет controller и завершает cancelled до AI', async () => {
    await service.stop('100', '200');
    const abort = jest.spyOn(AbortController.prototype, 'abort');
    store.findRepair
      .mockResolvedValueOnce(repair())
      .mockResolvedValueOnce(repair('cancel_requested'));

    const result = await service.run(REPAIR_ID, TURN_ID, input());

    expect(abort).toHaveBeenCalledTimes(1);
    expect(ai.repair).not.toHaveBeenCalled();
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'cancelled', 0);
    expect(result.turnStatus).toBe('error');
  });

  it('finishRepair=false превращает terminal write в repair_fenced без повторной записи', async () => {
    store.finishRepair.mockResolvedValue(false);

    await expect(service.run(REPAIR_ID, TURN_ID, input())).rejects.toMatchObject({ kind: 'repair_fenced' });

    expect(store.finishRepair).toHaveBeenCalledTimes(1);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'unverified', 0);
  });

  it('не запускает AI, если repair уже нельзя перевести в running', async () => {
    store.markRepairRunning.mockResolvedValue(false);

    await expect(service.run(REPAIR_ID, TURN_ID, input())).rejects.toMatchObject({ kind: 'repair_not_requested' });

    expect(ai.repair).not.toHaveBeenCalled();
    expect(store.finishRepair).not.toHaveBeenCalled();
  });

  it('stopAll во время начального findRepair не запускает AI и завершает interrupted', async () => {
    const initial = deferred<RepairRecord>();
    store.findRepair
      .mockImplementationOnce(() => initial.promise)
      .mockResolvedValue(repair('running'));
    const running = service.run(REPAIR_ID, TURN_ID, input());
    expect(store.findRepair).toHaveBeenCalledTimes(1);

    await service.stopAll();
    initial.resolve(repair());
    const result = await running;

    expect(ai.repair).not.toHaveBeenCalled();
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 0);
    expect(result.text).toContain('Исход неизвестен: исправление прервано');
  });

  it('stopAll перед derive не даёт verified после уже завершённого AI', async () => {
    const jobs = deferred<RepairJobRecord[]>();
    const listed = deferred();
    store.listJobs.mockImplementation(() => {
      listed.resolve();
      return jobs.promise;
    });
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await listed.promise;

    await service.stopAll();
    jobs.resolve([job(1, 'exec', true), job(2, 'verify', false)]);
    const result = await running;

    expect(ai.repair).toHaveBeenCalledTimes(1);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 1);
    expect(result.text).not.toContain('Исправлено и проверено');
  });

  it('stopAll означает shutdown interrupted, а не отмену админом', async () => {
    const started = deferred();
    let signal: AbortSignal | undefined;
    ai.repair.mockImplementation((call: { signal: AbortSignal }) => {
      signal = call.signal;
      started.resolve();
      return new Promise((_, reject) => {
        call.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { kind: 'aborted' })), { once: true });
      });
    });
    const running = service.run(REPAIR_ID, TURN_ID, input());
    await started.promise;

    await service.stopAll();
    const result = await running;

    expect(signal?.aborted).toBe(true);
    expect(executor.stopAll).toHaveBeenCalledTimes(1);
    expect(store.finishRepair).toHaveBeenCalledWith(REPAIR_ID, 'interrupted', 0);
    expect(result.turnStatus).toBe('error');
    expect(result.text).toContain('Исход неизвестен: исправление прервано');
    expect(result.text).not.toContain('остановлено админом');
  });

  it('admit и abandon делегируют журналу до attachTurn', async () => {
    await expect(service.admit({
      updateId: 1, chatId: '100', adminTgId: '200', instruction: 'Почини ошибку',
    })).resolves.toEqual({ status: 'accepted', repairId: REPAIR_ID });
    await expect(service.abandon(REPAIR_ID)).resolves.toBe(true);

    expect(store.admitRepair).toHaveBeenCalledWith({
      updateId: 1, chatId: '100', adminTgId: '200', instruction: 'Почини ошибку',
    });
    expect(store.abandon).toHaveBeenCalledWith(REPAIR_ID);
  });
});
