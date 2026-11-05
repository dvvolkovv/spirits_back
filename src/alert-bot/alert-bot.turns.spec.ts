jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

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
  let logger: { error: jest.Mock; warn: jest.Mock };
  let turns: AlertBotTurns;

  beforeEach(() => {
    process.env.ADMIN_ORIGIN = 'https://my.linkeon.io/';
    store = {
      tryCreateTurn: jest.fn().mockResolvedValue('turn-1'),
      createTurn: jest.fn().mockResolvedValue('system-turn-1'),
      recordSystemTurn: jest.fn().mockResolvedValue('system-turn-1'),
      attachAnswerMessage: jest.fn().mockResolvedValue(undefined),
      attachAnswerMessages: jest.fn().mockResolvedValue(undefined),
      finishTurn: jest.fn().mockResolvedValue(true),
      turnChain: jest.fn().mockResolvedValue([]),
      recentTurns: jest.fn().mockResolvedValue([]),
      countRecentTurns: jest.fn(),
    };
    telegram = {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 901 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockResolvedValue([901]),
    };
    ai = {
      answer: jest.fn().mockResolvedValue({ text: 'Всё спокойно', costUsd: 0.02, tools: ['health'] }),
    };
    status = { summary: jest.fn().mockResolvedValue('Алерты: горящих нет') };
    chat = { beginStream: jest.fn(), endStream: jest.fn() };
    support = { findTicketByPrefix: jest.fn().mockResolvedValue(null) };
    logger = { error: jest.fn(), warn: jest.fn() };
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
    telegram.sendChunks.mockResolvedValue([901, 902, 903]);
    support.findTicketByPrefix.mockImplementation(async (prefix: string) => {
      if (prefix === '11111111') return { id: TICKET_1 };
      if (prefix === '22222222') return { id: TICKET_2 };
      if (prefix === '44444444') return { id: TICKET_4 };
      return null;
    });

    await turns.enqueue(question());
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
    expect(telegram.editMessageText).toHaveBeenCalledWith('100', 901, fallback);
    expect(telegram.sendChunks).not.toHaveBeenCalled();
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({
      status: expectedStatus, answer: fallback, errorKind: kind, durationMs: expect.any(Number),
    }));
    expect(chat.beginStream).toHaveBeenCalledTimes(1);
    expect(chat.endStream).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ kind: 'other' }],
    [{ kind: 'unknown' }],
    [{ kind: 'limit' }],
    [{}],
  ])('неизвестная ошибка ai.answer %# не маскируется под model_down', async (errorProps) => {
    ai.answer.mockRejectedValue(Object.assign(new Error('RAW-UNEXPECTED-AI'), errorProps));

    await turns.enqueue(question());

    expect(status.summary).not.toHaveBeenCalled();
    expect(telegram.editMessageText).toHaveBeenCalledWith('100', 901, 'Не получилось ответить, попробуйте ещё раз');
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(store.finishTurn).toHaveBeenCalledWith('turn-1', expect.objectContaining({ status: 'error' }));
    expect(chat.endStream).toHaveBeenCalledTimes(1);
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
    await busy;

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

    await turns.enqueue(question());

    expect(store.tryCreateTurn).toHaveBeenCalledWith(question(), 7);
    expect(store.countRecentTurns).not.toHaveBeenCalled();
    expect(store.createTurn).not.toHaveBeenCalled();
    expect(store.recordSystemTurn).toHaveBeenCalledWith(question(), 'rate_limited');
    expect(store.finishTurn).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith('100', 'Лимит вопросов в час исчерпан', 300);
    expect(ai.answer).not.toHaveBeenCalled();
    expect(chat.beginStream).not.toHaveBeenCalled();
    delete process.env.ALERT_BOT_RATE_PER_HOUR;
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

  it('неожиданная ошибка не раскрывает сырые данные, завершается один раз и освобождает очередь', async () => {
    ai.answer.mockResolvedValue({ text: 'ОТВЕТ-СЕКРЕТ', costUsd: 0.01, tools: [] });
    telegram.sendChunks.mockRejectedValueOnce(Object.assign(new Error('RAW-SEND-SECRET'), { kind: 'send_failed' }));

    await turns.enqueue(question({ question: 'ВОПРОС-СЕКРЕТ' }));
    await turns.enqueue(question({ updateId: 2 }));

    expect(ai.answer).toHaveBeenCalledTimes(2);
    expect(telegram.editMessageText).toHaveBeenCalledWith('100', 901, 'Не получилось ответить, попробуйте ещё раз');
    expect(store.finishTurn).toHaveBeenNthCalledWith(1, 'turn-1', expect.objectContaining({
      status: 'error', errorKind: 'send_failed', durationMs: expect.any(Number),
    }));
    expect(chat.endStream).toHaveBeenCalledTimes(2);
    const logs = JSON.stringify(logger.error.mock.calls);
    expect(logs).not.toContain('RAW-SEND-SECRET');
    expect(logs).not.toContain('ВОПРОС-СЕКРЕТ');
    expect(logs).not.toContain('ОТВЕТ-СЕКРЕТ');
  });

  it('finishTurn=false после interrupt не вызывает повторную отправку или overwrite', async () => {
    store.finishTurn.mockResolvedValue(false);

    await turns.enqueue(question());

    expect(telegram.sendChunks).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(telegram.editMessageText).not.toHaveBeenCalled();
    expect(store.finishTurn).toHaveBeenCalledTimes(1);
    expect(chat.endStream).toHaveBeenCalledTimes(1);
  });
});
