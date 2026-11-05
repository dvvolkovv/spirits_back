jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { ClaudeCliCallError } from '../common/services/claude-cli.service';
import { AlertBotTurns } from './alert-bot.turns';
import { TurnInput } from './alert-bot.types';

const TICKET_1 = '11111111-1111-4111-8111-111111111111';
const TICKET_2 = '22222222-2222-4222-8222-222222222222';
const TICKET_4 = '44444444-4444-4444-8444-444444444444';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function question(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    updateId: 1,
    chatId: '100',
    tgUserId: '200',
    adminUserId: 'admin-1',
    questionMessageId: 300,
    question: 'Что происходит?',
    privateChat: true,
    ...overrides,
  };
}

describe('AlertBotTurns', () => {
  const savedOrigin = process.env.ADMIN_ORIGIN;
  const savedRate = process.env.ALERT_BOT_RATE_PER_HOUR;
  let store: Record<string, jest.Mock>;
  let telegram: Record<string, jest.Mock>;
  let ai: { answer: jest.Mock };
  let status: { summary: jest.Mock };
  let chat: { beginStream: jest.Mock; endStream: jest.Mock };
  let support: { findTicketByPrefix: jest.Mock };
  let logger: { error: jest.Mock; warn: jest.Mock; log: jest.Mock; debug: jest.Mock };
  let turns: AlertBotTurns;

  beforeEach(() => {
    process.env.ADMIN_ORIGIN = 'https://my.linkeon.io/';
    store = {
      tryCreateTurn: jest.fn().mockResolvedValue('turn-1'),
      admitDraftQuestion: jest.fn().mockResolvedValue({ status: 'accepted', turnId: 'draft-turn-1' }),
      createTurn: jest.fn().mockResolvedValue('system-turn-1'),
      recordSystemTurn: jest.fn().mockResolvedValue('system-turn-1'),
      attachAnswerMessage: jest.fn().mockResolvedValue(undefined),
      attachAnswerMessages: jest.fn().mockResolvedValue(undefined),
      markPlaceholderStarted: jest.fn().mockResolvedValue(undefined),
      deferPlaceholder: jest.fn().mockResolvedValue(undefined),
      attachPlaceholder: jest.fn().mockResolvedValue(undefined),
      markModelStarted: jest.fn().mockResolvedValue(undefined),
      markDeliveryStarted: jest.fn().mockResolvedValue(undefined),
      deferDelivery: jest.fn().mockResolvedValue(undefined),
      completeDelivery: jest.fn().mockResolvedValue(undefined),
      finishTurn: jest.fn().mockResolvedValue(true),
      turnChain: jest.fn().mockResolvedValue([]),
      recentTurns: jest.fn().mockResolvedValue([]),
      countRecentTurns: jest.fn(),
    };
    store.admitTurn = jest.fn(async (input: TurnInput, maxPerHour: number) => {
      const turnId = await store.tryCreateTurn(input, maxPerHour);
      return turnId ? { status: 'accepted', turnId } : { status: 'rate_limited' };
    });
    telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 901 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockImplementation(async (...args: any[]) => {
        await args[5]?.([901]);
        return [901];
      }),
    };
    ai = {
      answer: jest.fn().mockResolvedValue({ text: 'Всё спокойно', costUsd: 0.02, tools: ['health'] }),
    };
    status = { summary: jest.fn().mockResolvedValue('Алерты: горящих нет') };
    chat = { beginStream: jest.fn(), endStream: jest.fn() };
    support = { findTicketByPrefix: jest.fn().mockResolvedValue(null) };
    logger = { error: jest.fn(), warn: jest.fn(), log: jest.fn(), debug: jest.fn() };
    turns = new AlertBotTurns(
      store as any,
      telegram as any,
      ai as any,
      status as any,
      chat as any,
      support as any,
    );
    (turns as any).logger = logger;
  });

  afterEach(async () => {
    await turns.idle();
    if (savedOrigin === undefined) delete process.env.ADMIN_ORIGIN;
    else process.env.ADMIN_ORIGIN = savedOrigin;
    if (savedRate === undefined) delete process.env.ALERT_BOT_RATE_PER_HOUR;
    else process.env.ALERT_BOT_RATE_PER_HOUR = savedRate;
    jest.restoreAllMocks();
  });

  it('сохраняет placeholder, отправляет ответ с реальными тикетами и завершает ход с метриками', async () => {
    const text = 'Смотри #11111111 и #22222222; #33333333 не найден, зато есть #44444444. Повтор #11111111.';
    ai.answer.mockResolvedValue({ text, costUsd: 0.02, tools: ['health', 'tickets'] });
    telegram.sendChunks.mockImplementation(async (...args: any[]) => {
      const onIds = args[5];
      for (const ids of [[901], [901, 902], [901, 902, 903]]) await onIds?.(ids);
      return [901, 902, 903];
    });
    support.findTicketByPrefix.mockImplementation(async (prefix: string) => {
      if (prefix === '11111111') return { id: TICKET_1 };
      if (prefix === '22222222') return { id: TICKET_2 };
      if (prefix === '44444444') return { id: TICKET_4 };
      return null;
    });

    await expect(turns.enqueue(question())).resolves.toBe('accepted');
    await turns.idle();

    expect(telegram.sendMessage).toHaveBeenCalledWith('100', '🔎 Смотрю…', 300);
    expect(store.attachAnswerMessage).not.toHaveBeenCalled();
    expect(store.attachAnswerMessages).toHaveBeenCalledWith('turn-1', [901, 902, 903]);
    expect(chat.beginStream).toHaveBeenCalledTimes(1);
    expect(chat.endStream).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks).toHaveBeenCalledTimes(1);
    const [chatId, answerText, firstMessageId, replyTo, markup] = telegram.sendChunks.mock.calls[0];
    expect([chatId, answerText, firstMessageId, replyTo]).toEqual(['100', text, 901, 300]);
    const buttons = markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button: any) => button.text)).toEqual([
      'Открыть #11111111', 'Открыть #22222222', 'Открыть #44444444',
    ]);
    expect(buttons.map((button: any) => button.url)).toEqual([
      `https://my.linkeon.io/admin?tab=support&ticket=${TICKET_1}`,
      `https://my.linkeon.io/admin?tab=support&ticket=${TICKET_2}`,
      `https://my.linkeon.io/admin?tab=support&ticket=${TICKET_4}`,
    ]);
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      status: 'ok', answer: text, tools: ['health', 'tickets'], costUsd: 0.02,
      durationMs: expect.any(Number),
    }));
    expect(store.finishTurn.mock.invocationCallOrder[0]).toBeLessThan(
      telegram.sendChunks.mock.invocationCallOrder[0],
    );
    expect(store.completeDelivery).toHaveBeenCalledWith('turn-1', [901, 902, 903]);
  });

  it('ищет не более десяти уникальных ticket-prefix candidates за ответ', async () => {
    const prefixes = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(8, '0'));
    ai.answer.mockResolvedValue({ text: prefixes.map((prefix) => `#${prefix}`).join(' '), costUsd: 0, tools: [] });

    await turns.enqueue(question());

    expect(support.findTicketByPrefix).toHaveBeenCalledTimes(10);
    expect(support.findTicketByPrefix.mock.calls.map((call) => call[0])).toEqual(prefixes.slice(0, 10));
  });

  it.each([
    ['auth', 'model_down'],
    ['rate_limit', 'model_down'],
    ['weekly_limit', 'model_down'],
    ['overloaded', 'model_down'],
    ['timeout', 'timeout'],
  ])('известная ошибка модели %s даёт безопасный ответ и статус %s', async (kind, expectedStatus) => {
    ai.answer.mockRejectedValue(Object.assign(new Error('RAW-MODEL-SECRET'), { kind }));
    status.summary.mockResolvedValue('Сводка без модели');

    await turns.enqueue(question());

    const fallback = `Модель недоступна: ${kind}.\n\nСводка без модели`;
    expect(telegram.sendChunks).toHaveBeenCalledWith(
      '100', fallback, 901, 300, undefined, expect.any(Function), [],
    );
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      status: expectedStatus, answer: fallback, errorKind: kind, durationMs: expect.any(Number),
    }));
    expect(chat.beginStream).toHaveBeenCalledTimes(1);
    expect(chat.endStream).toHaveBeenCalledTimes(1);
  });

  it('реальный ClaudeCliCallError с kind other получает model fallback', async () => {
    ai.answer.mockRejectedValue(new ClaudeCliCallError(
      'claude CLI код выхода 1: other',
      false,
      { kind: 'other', access: false },
    ));
    status.summary.mockResolvedValue('Сводка без модели');

    await turns.enqueue(question());

    expect(status.summary).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks).toHaveBeenCalledWith(
      '100', 'Модель недоступна: other.\n\nСводка без модели',
      901, 300, undefined, expect.any(Function), [],
    );
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      status: 'model_down', errorKind: 'other',
    }));
  });

  it.each([
    [{ kind: 'other' }],
    [{ kind: 'unknown' }],
    [{ kind: 'limit' }],
    [{}],
  ])('неизвестная ошибка ai.answer %# не маскируется под model_down', async (errorProps) => {
    ai.answer.mockRejectedValue(Object.assign(new Error('RAW-UNEXPECTED-AI'), errorProps));

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'model_outcome_unknown' });
    await expect(turns.enqueue(question({ updateId: 2 }))).rejects.toMatchObject({ kind: 'model_outcome_unknown' });

    expect(status.summary).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(store.finishTurn).not.toHaveBeenCalled();
    expect(chat.endStream).toHaveBeenCalledTimes(2);
  });

  it('держит один running и два waiting на чат, четвёртый получает busy без модели', async () => {
    const first = deferred<{ text: string; costUsd: number; tools: string[] }>();
    const started = deferred();
    ai.answer.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });
    store.tryCreateTurn.mockImplementation(async () => `turn-${store.tryCreateTurn.mock.calls.length}`);

    const running = turns.enqueue(question({ updateId: 1, questionMessageId: 301 }));
    await started.promise;
    const waiting1 = turns.enqueue(question({ updateId: 2, questionMessageId: 302 }));
    const waiting2 = turns.enqueue(question({ updateId: 3, questionMessageId: 303 }));
    const busy = turns.enqueue(question({ updateId: 4, questionMessageId: 304 }));
    await expect(busy).resolves.toBe('busy');

    expect(ai.answer).toHaveBeenCalledTimes(1);
    expect(store.tryCreateTurn).toHaveBeenCalledTimes(1);
    expect(store.createTurn).not.toHaveBeenCalled();
    expect(store.recordSystemTurn).toHaveBeenCalledWith(expect.objectContaining({ updateId: 4 }), 'busy');
    expect(store.finishTurn).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Занят, спросите через минуту', 304);

    first.resolve({ text: 'первый', costUsd: 0.01, tools: [] });
    await Promise.all([running, waiting1, waiting2]);
    await turns.idle();
    expect(ai.answer).toHaveBeenCalledTimes(3);
    expect(store.tryCreateTurn).toHaveBeenCalledTimes(3);
  });

  it('использует атомарный tryCreateTurn и записывает rate_limited без вызова модели', async () => {
    process.env.ALERT_BOT_RATE_PER_HOUR = '7';
    store.tryCreateTurn.mockResolvedValue(null);
    store.createTurn.mockResolvedValue('limited-1');

    await expect(turns.enqueue(question())).resolves.toBe('rate_limited');

    expect(store.tryCreateTurn).toHaveBeenCalledWith(question(), 7);
    expect(store.countRecentTurns).not.toHaveBeenCalled();
    expect(store.createTurn).not.toHaveBeenCalled();
    expect(store.recordSystemTurn).toHaveBeenCalledWith(question(), 'rate_limited');
    expect(store.finishTurn).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Лимит вопросов в час исчерпан', 300);
    expect(ai.answer).not.toHaveBeenCalled();
    expect(chat.beginStream).toHaveBeenCalledTimes(1);
    expect(chat.endStream).toHaveBeenCalledTimes(1);
    delete process.env.ALERT_BOT_RATE_PER_HOUR;
  });

  it('сбой admission пробрасывается наружу и не останавливает очередь чата', async () => {
    store.tryCreateTurn
      .mockRejectedValueOnce(Object.assign(new Error('RAW-ADMISSION-SECRET'), { kind: 'db_down' }))
      .mockResolvedValueOnce('turn-2');

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'db_down' });
    await expect(turns.enqueue(question({ updateId: 2 }))).resolves.toBe('accepted');

    expect(ai.answer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-ADMISSION-SECRET');
  });

  it('draft reservation проходит атомарный admission до вызова модели', async () => {
    const reservation = { draftId: 'draft-1', claimVersion: 7 };

    await expect((turns as any).enqueue(question(), reservation)).resolves.toBe('accepted');

    expect(store.admitDraftQuestion).toHaveBeenCalledWith({
      draftId: 'draft-1', claimVersion: 7, input: question(), maxPerHour: 30,
    });
    expect(store.tryCreateTurn).not.toHaveBeenCalled();
    expect(store.attachAnswerMessages).toHaveBeenCalledWith('draft-turn-1', [901]);
    expect(ai.answer).toHaveBeenCalledTimes(1);
  });

  it('stale draft admission не создаёт placeholder и не вызывает модель', async () => {
    store.admitDraftQuestion.mockResolvedValue({ status: 'stale' });

    await expect((turns as any).enqueue(
      question(), { draftId: 'draft-1', claimVersion: 8 },
    )).resolves.toBe('stale');

    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(ai.answer).not.toHaveBeenCalled();
    expect(store.recordSystemTurn).not.toHaveBeenCalled();
  });

  it('rate-limited draft admission не вызывает модель и оставляет reservation для service', async () => {
    store.admitDraftQuestion.mockResolvedValue({ status: 'rate_limited' });

    await expect((turns as any).enqueue(
      question(), { draftId: 'draft-1', claimVersion: 9 },
    )).resolves.toBe('rate_limited');

    expect(store.recordSystemTurn).toHaveBeenCalledWith(question(), 'rate_limited');
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Лимит вопросов в час исчерпан', 300);
    expect(ai.answer).not.toHaveBeenCalled();
  });

  it('system turn не зависит от failed finish и не оставляет in_progress', async () => {
    store.tryCreateTurn.mockResolvedValue(null);
    store.finishTurn.mockRejectedValue(new Error('finish failed'));

    await turns.enqueue(question());

    expect(store.recordSystemTurn).toHaveBeenCalledWith(question(), 'rate_limited');
    expect(store.createTurn).not.toHaveBeenCalled();
    expect(store.finishTurn).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Лимит вопросов в час исчерпан', 300);
  });

  it('разные чаты выполняются независимыми очередями', async () => {
    const first = deferred<{ text: string; costUsd: number; tools: string[] }>();
    const started = deferred();
    ai.answer.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });

    const blocked = turns.enqueue(question({ chatId: 'chat-a' }));
    await started.promise;
    await turns.enqueue(question({ chatId: 'chat-b', updateId: 2 }));

    expect(ai.answer).toHaveBeenCalledTimes(2);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({ status: 'ok' }));
    first.resolve({ text: 'первый чат', costUsd: 0.01, tools: [] });
    await blocked;
  });

  it('для follow-up берёт turnChain, а не unrelated recentTurns', async () => {
    store.turnChain.mockResolvedValue([{ question: 'прежний вопрос', answer: 'прежний ответ' }]);

    await turns.enqueue(question({ parentTurnId: 'parent-1' }));

    expect(store.turnChain).toHaveBeenCalledWith('parent-1', 3);
    expect(store.recentTurns).not.toHaveBeenCalled();
    expect(ai.answer).toHaveBeenCalledWith(expect.objectContaining({
      parentTurnId: 'parent-1',
      history: [{ question: 'прежний вопрос', answer: 'прежний ответ' }],
    }));
  });

  it('private без parent берёт три recentTurns за 30 минут', async () => {
    store.recentTurns.mockResolvedValue([{ question: 'недавнее', answer: 'ответ' }]);

    await turns.enqueue(question());

    expect(store.recentTurns).toHaveBeenCalledWith('100', 3, 30);
    expect(store.turnChain).not.toHaveBeenCalled();
    expect(ai.answer).toHaveBeenCalledWith(expect.objectContaining({
      history: [{ question: 'недавнее', answer: 'ответ' }],
    }));
  });

  it('group без parent не получает unrelated recent history', async () => {
    await turns.enqueue(question({ privateChat: false, chatId: '-1001' }));

    expect(store.recentTurns).not.toHaveBeenCalled();
    expect(store.turnChain).not.toHaveBeenCalled();
    expect(ai.answer).toHaveBeenCalledWith(expect.objectContaining({ history: [] }));
  });

  it('сбой journal после доставки не перезаписывает видимый ответ и требует безопасного retry', async () => {
    store.attachAnswerMessages
      .mockRejectedValueOnce(Object.assign(new Error('RAW-ATTACH-SECRET'), { kind: 'db_down' }));
    telegram.sendChunks.mockImplementation(async (...args: any[]) => {
      await args[5]?.([901]);
      return [901];
    });

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'answer_journal_failed' });

    expect(telegram.sendChunks).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).not.toHaveBeenCalledWith(
      '100', 901, 'Не получилось ответить, попробуйте ещё раз',
    );
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({ status: 'ok' }));
    expect(store.completeDelivery).not.toHaveBeenCalled();
    expect(store.deferDelivery).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-ATTACH-SECRET');
  });

  it('сбой finish до доставки не показывает непроверенный ответ и остаётся retryable', async () => {
    store.finishTurn.mockRejectedValueOnce(Object.assign(new Error('RAW-FINISH-SECRET'), { kind: 'db_down' }));

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'db_down' });

    expect(telegram.sendChunks).not.toHaveBeenCalled();
    expect(telegram.editMessageText).not.toHaveBeenCalledWith(
      '100', 901, 'Не получилось ответить, попробуйте ещё раз',
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-FINISH-SECRET');
  });

  it('частично доставленные chunks сохраняются и retry не перезаписывает видимый ответ', async () => {
    telegram.sendChunks.mockImplementation(async (...args: any[]) => {
      await args[5]?.([901]);
      await args[5]?.([901, 902]);
      throw Object.assign(new Error('RAW-CONTINUATION-SECRET'), { kind: 'send_failed' });
    });

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'send_failed' });

    expect(store.attachAnswerMessages).toHaveBeenCalledWith('turn-1', [901, 902]);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({ status: 'ok' }));
    expect(store.deferDelivery).toHaveBeenCalledWith('turn-1');
    expect(store.completeDelivery).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('RAW-CONTINUATION-SECRET');
  });

  it('неожиданная ошибка не раскрывает сырые данные, сохраняет ответ и освобождает очередь', async () => {
    ai.answer.mockResolvedValue({ text: 'ОТВЕТ-СЕКРЕТ', costUsd: 0.01, tools: [] });
    telegram.sendChunks.mockRejectedValueOnce(Object.assign(new Error('RAW-SEND-SECRET'), { kind: 'send_failed' }));

    await expect(turns.enqueue(question({ question: 'ВОПРОС-СЕКРЕТ' })))
      .rejects.toMatchObject({ kind: 'send_failed' });
    await expect(turns.enqueue(question({ updateId: 2 }))).resolves.toBe('accepted');

    expect(ai.answer).toHaveBeenCalledTimes(2);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(store.finishTurn).toHaveBeenNthCalledWith(1, 'turn-1', expect.objectContaining({
      status: 'ok', answer: 'ОТВЕТ-СЕКРЕТ', durationMs: expect.any(Number),
    }));
    expect(store.deferDelivery).toHaveBeenCalledWith('turn-1');
    expect(chat.endStream).toHaveBeenCalledTimes(2);
    const logs = JSON.stringify(logger.error.mock.calls);
    expect(logs).not.toContain('RAW-SEND-SECRET');
    expect(logs).not.toContain('ВОПРОС-СЕКРЕТ');
    expect(logs).not.toContain('ОТВЕТ-СЕКРЕТ');
  });

  it('finishTurn=false после interrupt не вызывает доставку или overwrite', async () => {
    store.finishTurn.mockResolvedValue(false);

    await expect(turns.enqueue(question())).rejects.toMatchObject({ kind: 'turn_fenced' });

    expect(telegram.sendChunks).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(store.completeDelivery).not.toHaveBeenCalled();
    expect(chat.endStream).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify([...logger.error.mock.calls, ...logger.debug.mock.calls]);
    expect(logs).not.toContain('status=ok kind=done');
    expect(logs).toContain('status=error kind=turn_fenced');
  });

  it('queued второй ход уже учитывается в activeStreams и освобождает drain после завершения', async () => {
    const first = deferred<{ text: string; costUsd: number; tools: string[] }>();
    const started = deferred();
    let activeStreams = 0;
    chat.beginStream.mockImplementation(() => { activeStreams += 1; });
    chat.endStream.mockImplementation(() => { activeStreams -= 1; });
    ai.answer.mockImplementationOnce(() => {
      started.resolve();
      return first.promise;
    });

    const running = turns.enqueue(question({ updateId: 1, questionMessageId: 301 }));
    await started.promise;
    const waiting = turns.enqueue(question({ updateId: 2, questionMessageId: 302 }));

    expect(activeStreams).toBe(2);
    first.resolve({ text: 'первый', costUsd: 0, tools: [] });
    await Promise.all([running, waiting]);
    expect(activeStreams).toBe(0);
    expect(ai.answer).toHaveBeenCalledTimes(2);
  });

  it('ticket buttons имеют общий 5s deadline, передают signal и не держат ответ или drain', async () => {
    ai.answer.mockResolvedValue({ text: 'Смотри #11111111', costUsd: 0, tools: [] });
    let lookupSignal: AbortSignal | undefined;
    support.findTicketByPrefix.mockImplementation((_prefix: string, signal?: AbortSignal) => {
      lookupSignal = signal;
      return new Promise(() => {});
    });

    const startedAt = Date.now();
    await expect(turns.enqueue(question())).resolves.toBe('accepted');

    expect(Date.now() - startedAt).toBeLessThan(6500);
    expect(lookupSignal?.aborted).toBe(true);
    expect(telegram.sendChunks).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks.mock.calls[0][4]).toBeUndefined();
    expect(chat.endStream).toHaveBeenCalledTimes(1);
  }, 7000);

  it('ambiguous ticket prefix пропускается, а однозначный тикет сохраняет кнопку', async () => {
    ai.answer.mockResolvedValue({ text: '#11111111 и #22222222', costUsd: 0, tools: [] });
    support.findTicketByPrefix.mockImplementation(async (prefix: string) => {
      if (prefix === '11111111') {
        throw Object.assign(new Error('ambiguous'), { name: 'TicketPrefixAmbiguousError' });
      }
      return { id: TICKET_2 };
    });

    await expect(turns.enqueue(question())).resolves.toBe('accepted');

    const markup = telegram.sendChunks.mock.calls[0][4];
    expect(markup.inline_keyboard.flat().map((button: any) => button.text)).toEqual(['Открыть #22222222']);
  });
});
