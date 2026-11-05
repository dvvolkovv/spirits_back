jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AlertBotDrafts } from './alert-bot.drafts';
import { AlertBotService } from './alert-bot.service';
import { AlertBotStore } from './alert-bot.store';
import { AlertBotTurns } from './alert-bot.turns';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_recovery_spec_${process.pid}`;

maybe('state-aware recovery бота алертов против PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: AlertBotStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_alert_bot.sql'), 'utf8'));
    store = new AlertBotStore({
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    } as any);
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE alert_bot_updates, alert_bot_turns, alert_bot_ticket_drafts, alert_messages');
    jest.restoreAllMocks();
  });

  function makeService(telegram: Record<string, jest.Mock>, aiAnswer: jest.Mock) {
    const support = {
      findTicketByPrefix: jest.fn().mockResolvedValue(null),
      findTelegramDraftPublication: jest.fn().mockResolvedValue(false),
      postOwnerReplyFromTelegram: jest.fn().mockResolvedValue(undefined),
    };
    const turns = new AlertBotTurns(
      store,
      telegram as any,
      { answer: aiAnswer } as any,
      { summary: jest.fn().mockResolvedValue('Сводка') } as any,
      { beginStream: jest.fn(), endStream: jest.fn() } as any,
      support as any,
    );
    const drafts = new AlertBotDrafts(store, support as any, telegram as any);
    const commands = { start: jest.fn(), status: jest.fn(), close: jest.fn() };
    const service = new AlertBotService(
      { resolveTelegram: jest.fn().mockResolvedValue({ isAdmin: true, userId: 'admin-retry' }) } as any,
      telegram as any,
      store,
      commands as any,
      drafts,
      turns,
      support as any,
    );
    return { service, support, drafts, turns, commands };
  }

  function telegramMock() {
    return {
      getMe: jest.fn().mockResolvedValue({ id: 999, username: 'linkeon_alert_bot' }),
      sendMessage: jest.fn().mockResolvedValue({ message_id: 901 }),
      editMessageText: jest.fn().mockResolvedValue(undefined),
      sendChunks: jest.fn().mockImplementation(async (
        _chatId: string,
        _text: string,
        firstMessageId: number,
        _replyTo: number,
        _markup: unknown,
        onIds?: (ids: number[]) => Promise<void>,
      ) => {
        await onIds?.([firstMessageId]);
        return [firstMessageId];
      }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
    };
  }

  function unknownTelegramOutcome() {
    return Object.assign(new Error('timeout after remote success'), {
      kind: 'telegram_unknown', outcome: 'unknown', retryable: false,
    });
  }

  const update = {
    update_id: 92001,
    message: {
      message_id: 10,
      text: 'Что горит?',
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
    },
  };

  async function makeDue(updateId: number) {
    await pool.query(
      `UPDATE alert_bot_updates
       SET next_retry_at = now() - interval '1 second'
       WHERE update_id = $1 AND status = 'failed'`,
      [updateId],
    );
  }

  it('сбой placeholder до модели оставляет durable retry и не завершает update', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'Ответ', costUsd: 0, tools: [] });
    const telegram = telegramMock();
    telegram.sendMessage.mockRejectedValueOnce(Object.assign(new Error('temporary'), { kind: 'send_failed' }));
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);

    expect((await pool.query(
      'SELECT status, attempts FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0]).toMatchObject({ status: 'failed', attempts: 1 });
    expect(aiAnswer).not.toHaveBeenCalled();

    await makeDue(update.update_id);
    await service.retryFailedUpdates();

    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('completed');
  });

  it('сохраняет ответ до delivery и retry продолжает доставку без повторного Claude', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'Сохранённый ответ', costUsd: 0.01, tools: ['health'] });
    const telegram = telegramMock();
    let persistedAtFirstDelivery: string | null = null;
    telegram.sendChunks
      .mockImplementationOnce(async () => {
        persistedAtFirstDelivery = (await pool.query(
          'SELECT answer FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
        )).rows[0]?.answer ?? null;
        throw Object.assign(new Error('delivery down'), { kind: 'send_failed' });
      })
      .mockImplementationOnce(async (
        _chatId: string,
        _text: string,
        firstMessageId: number,
        _replyTo: number,
        _markup: unknown,
        onIds?: (ids: number[]) => Promise<void>,
      ) => {
        await onIds?.([firstMessageId]);
        return [firstMessageId];
      });
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);

    expect(persistedAtFirstDelivery).toBe('Сохранённый ответ');
    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('failed');

    await makeDue(update.update_id);
    await service.retryFailedUpdates();

    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('completed');
  });

  it('запущенная модель без сохранённого ответа только defer, никогда не запускается повторно', async () => {
    const aiAnswer = jest.fn().mockRejectedValue(Object.assign(new Error('unknown outcome'), { kind: 'unknown' }));
    const telegram = telegramMock();
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);

    const started = await pool.query(
      'SELECT model_started_at, answer FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
    );
    expect(started.rows[0].model_started_at).toBeInstanceOf(Date);
    expect(started.rows[0].answer).toBeNull();
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('failed');

    await makeDue(update.update_id);
    await service.retryFailedUpdates();

    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks).not.toHaveBeenCalled();
    expect((await pool.query(
      'SELECT status, attempts FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('retry системного rate_limited повторяет уведомление только пока оно не сохранено', async () => {
    process.env.ALERT_BOT_RATE_PER_HOUR = '1';
    try {
      await pool.query(
        `INSERT INTO alert_bot_turns
           (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
            question, private_chat, status, finished_at)
         VALUES (91999, '100', '200', 'admin-retry', 1, 'prior', true, 'ok', now())`,
      );
      const aiAnswer = jest.fn();
      const telegram = telegramMock();
      telegram.sendMessage
        .mockRejectedValueOnce(Object.assign(new Error('notify down'), { kind: 'send_failed' }))
        .mockResolvedValue({ message_id: 950 });
      const { service } = makeService(telegram, aiAnswer);

      await service.handleUpdate(update);
      await makeDue(update.update_id);
      await service.retryFailedUpdates();

      expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
      expect(telegram.sendMessage.mock.calls[1][1]).toContain('Лимит');
      expect(Number((await pool.query(
        'SELECT answer_message_id FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
      )).rows[0].answer_message_id)).toBe(950);

      await pool.query(
        `UPDATE alert_bot_updates
         SET status = 'failed', next_retry_at = now() - interval '1 second'
         WHERE update_id = $1`,
        [update.update_id],
      );
      await service.retryFailedUpdates();
      expect(telegram.sendMessage).toHaveBeenCalledTimes(2);
      expect(aiAnswer).not.toHaveBeenCalled();
    } finally {
      delete process.env.ALERT_BOT_RATE_PER_HOUR;
    }
  });

  it('pre-commit сбой публикации черновика не глотается и повторяется durable retry', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    const { service, support } = makeService(telegram, aiAnswer);
    support.postOwnerReplyFromTelegram
      .mockRejectedValueOnce(Object.assign(new Error('before commit'), { kind: 'db_down' }))
      .mockResolvedValueOnce(undefined);
    const draftId = await store.createDraft({
      chatId: '100', tgUserId: '200', adminUserId: 'admin-retry', ticketId: '11111111-1111-4111-8111-111111111111', text: 'Ответ',
    });
    const callback = {
      update_id: 92002,
      callback_query: {
        id: 'callback-recovery', data: `draft:${draftId}:send`, from: { id: 200 },
        message: { message_id: 900, chat: { id: 100, type: 'private' } },
      },
    };

    await service.handleUpdate(callback);

    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [callback.update_id],
    )).rows[0].status).toBe('failed');

    await makeDue(callback.update_id);
    await service.retryFailedUpdates();

    expect(support.postOwnerReplyFromTelegram).toHaveBeenCalledTimes(2);
    expect((await pool.query('SELECT outcome FROM alert_bot_ticket_drafts WHERE id = $1', [draftId])).rows[0].outcome).toBe('sent');
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [callback.update_id],
    )).rows[0].status).toBe('completed');
  });

  it('periodic lease sweep восстанавливает processing после сбоя failUpdate', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'После recovery', costUsd: 0, tools: [] });
    const telegram = telegramMock();
    telegram.getMe.mockRejectedValueOnce(Object.assign(new Error('temporary'), { kind: 'telegram_down' }));
    const { service } = makeService(telegram, aiAnswer);
    jest.spyOn(store, 'failUpdate').mockRejectedValueOnce(new Error('state database down'));

    await service.handleUpdate(update);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('processing');

    await pool.query(
      `UPDATE alert_bot_updates SET updated_at = now() - interval '2 minutes' WHERE update_id = $1`,
      [update.update_id],
    );
    await service.retryFailedUpdates();

    expect(telegram.getMe).toHaveBeenCalledTimes(2);
    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('completed');
  });

  it('asked draft retry сразу resume-ит существующий turn без повторного draft callback', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'Ответ после retry', costUsd: 0, tools: [] });
    const telegram = telegramMock();
    telegram.sendChunks.mockImplementationOnce(async () => {
      throw Object.assign(new Error('definite API refusal'), { kind: 'send_failed' });
    });
    const { service, drafts, turns } = makeService(telegram, aiAnswer);
    const draftId = await store.createDraft({
      chatId: '100', tgUserId: '200', adminUserId: 'admin-retry',
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'Вопрос из черновика',
    });
    const callback = {
      update_id: 92003,
      callback_query: {
        id: 'callback-ask-resume', data: `draft:${draftId}:ask`, from: { id: 200 },
        message: { message_id: 900, chat: { id: 100, type: 'private' } },
      },
    };
    const draftCallback = jest.spyOn(drafts, 'handleCallback');
    const resume = jest.spyOn(turns as any, 'resumeExisting');

    await service.handleUpdate(callback);
    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asked' });
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [callback.update_id],
    )).rows[0].status).toBe('failed');

    await makeDue(callback.update_id);
    await service.retryFailedUpdates();

    expect(draftCallback).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect(telegram.sendChunks).toHaveBeenCalledTimes(2);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [callback.update_id],
    )).rows[0].status).toBe('completed');
  });

  it('releaseAsk failure + immediate retry не завершает update по активному claim', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    const { service, drafts, turns } = makeService(telegram, aiAnswer);
    const draftId = await store.createDraft({
      chatId: '100', tgUserId: '200', adminUserId: 'admin-retry',
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'Вопрос с активным claim',
    });
    const callback = {
      update_id: 92004,
      callback_query: {
        id: 'callback-release-failure', data: `draft:${draftId}:ask`, from: { id: 200 },
        message: { message_id: 900, chat: { id: 100, type: 'private' } },
      },
    };
    jest.spyOn(turns, 'enqueue').mockRejectedValue(Object.assign(new Error('admission failed'), { kind: 'db_down' }));
    const release = jest.spyOn(drafts, 'releaseAsk').mockRejectedValue(Object.assign(new Error('release failed'), { kind: 'db_down' }));

    await service.handleUpdate(callback);
    await makeDue(callback.update_id);
    await service.retryFailedUpdates();

    expect(release).toHaveBeenCalledTimes(1);
    expect(await store.getDraft(draftId)).toMatchObject({ outcome: 'asking', claimVersion: 1 });
    expect((await pool.query(
      'SELECT status, attempts FROM alert_bot_updates WHERE update_id = $1', [callback.update_id],
    )).rows[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('timeout после remote success placeholder не очищает marker и не создаёт второй placeholder', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    telegram.sendMessage.mockRejectedValueOnce(unknownTelegramOutcome());
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);
    await makeDue(update.update_id);
    await service.retryFailedUpdates();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect(aiAnswer).not.toHaveBeenCalled();
    expect((await pool.query(
      'SELECT placeholder_started_at FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
    )).rows[0].placeholder_started_at).toBeInstanceOf(Date);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('failed');
  });

  it('timeout после remote success system notification не создаёт второе уведомление', async () => {
    process.env.ALERT_BOT_RATE_PER_HOUR = '1';
    try {
      await pool.query(
        `INSERT INTO alert_bot_turns
           (update_id, chat_id, tg_user_id, linkeon_user_id, question_message_id,
            question, private_chat, status, finished_at)
         VALUES (91998, '100', '200', 'admin-retry', 1, 'prior', true, 'ok', now())`,
      );
      const aiAnswer = jest.fn();
      const telegram = telegramMock();
      telegram.sendMessage.mockRejectedValueOnce(unknownTelegramOutcome());
      const { service } = makeService(telegram, aiAnswer);

      await service.handleUpdate(update);
      await makeDue(update.update_id);
      await service.retryFailedUpdates();

      expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
      expect((await pool.query(
        'SELECT placeholder_started_at FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
      )).rows[0].placeholder_started_at).toBeInstanceOf(Date);
      expect((await pool.query(
        'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
      )).rows[0].status).toBe('failed');
    } finally {
      delete process.env.ALERT_BOT_RATE_PER_HOUR;
    }
  });

  it('timeout после remote success continuation сохраняет delivery marker и не повторяет sendChunks', async () => {
    const aiAnswer = jest.fn().mockResolvedValue({ text: 'Длинный ответ', costUsd: 0, tools: [] });
    const telegram = telegramMock();
    telegram.sendChunks.mockImplementationOnce(async (...args: any[]) => {
      await args[5]?.([901]);
      await args[5]?.([901, 902]);
      throw unknownTelegramOutcome();
    });
    const { service } = makeService(telegram, aiAnswer);

    await service.handleUpdate(update);
    await makeDue(update.update_id);
    await service.retryFailedUpdates();

    expect(telegram.sendChunks).toHaveBeenCalledTimes(1);
    expect(aiAnswer).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT delivery_started_at FROM alert_bot_turns WHERE update_id = $1', [update.update_id],
    )).rows[0].delivery_started_at).toBeInstanceOf(Date);
    expect((await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [update.update_id],
    )).rows[0].status).toBe('failed');
  });

  it('direct /status timeout после remote success dead-letter-ится без повторной команды и второго сообщения', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    telegram.sendMessage.mockRejectedValueOnce(unknownTelegramOutcome());
    const { service, commands } = makeService(telegram, aiAnswer);
    commands.status.mockResolvedValue('Сводка по алертам');
    const statusUpdate = {
      ...update,
      update_id: 92101,
      message: { ...update.message, text: '/status' },
    };

    await service.handleUpdate(statusUpdate);
    await service.retryFailedUpdates();

    expect(commands.status).toHaveBeenCalledTimes(1);
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT status, next_retry_at FROM alert_bot_updates WHERE update_id = $1', [statusUpdate.update_id],
    )).rows[0]).toMatchObject({ status: 'failed', next_retry_at: null });
  });

  it('draft prompt timeout после публикации оставляет draft активным и не повторяет prompt', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    telegram.sendMessage.mockRejectedValueOnce(unknownTelegramOutcome());
    const { service, support } = makeService(telegram, aiAnswer);
    support.findTicketByPrefix.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' });
    const promptUpdate = {
      update_id: 92102,
      message: {
        ...update.message,
        text: 'Черновик ответа',
        reply_to_message: {
          message_id: 800,
          text: 'Эскалация #11111111',
          from: { id: 999, is_bot: true, username: 'linkeon_alert_bot' },
        },
      },
    };

    await service.handleUpdate(promptUpdate);
    await service.retryFailedUpdates();

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    expect((await pool.query(
      'SELECT outcome, prompt_message_id FROM alert_bot_ticket_drafts',
    )).rows[0]).toMatchObject({ outcome: null, prompt_message_id: null });
    expect((await pool.query(
      'SELECT status, next_retry_at FROM alert_bot_updates WHERE update_id = $1', [promptUpdate.update_id],
    )).rows[0]).toMatchObject({ status: 'failed', next_retry_at: null });
  });

  it('scheduled older retry при active guard нового callback остаётся failed, fresh duplicate завершается без работы', async () => {
    const aiAnswer = jest.fn();
    const telegram = telegramMock();
    const { service, turns } = makeService(telegram, aiAnswer);
    const draftId = await store.createDraft({
      chatId: '100', tgUserId: '200', adminUserId: 'admin-retry',
      ticketId: '11111111-1111-4111-8111-111111111111', text: 'Вопрос с active guard',
    });
    const callback = (updateId: number, callbackId: string) => ({
      update_id: updateId,
      callback_query: {
        id: callbackId, data: `draft:${draftId}:ask`, from: { id: 200 },
        message: { message_id: 900, chat: { id: 100, type: 'private' } },
      },
    });
    const newer = callback(92104, 'newer-active');
    const older = callback(92103, 'older-scheduled');
    let finishAdmission!: (value: 'accepted') => void;
    const admission = new Promise<'accepted'>((resolve) => { finishAdmission = resolve; });
    jest.spyOn(turns, 'enqueue').mockReturnValue(admission);
    const newerHandling = service.handleUpdate(newer);
    for (let i = 0; i < 30 && (turns.enqueue as jest.Mock).mock.calls.length === 0; i += 1) await Promise.resolve();
    expect(turns.enqueue).toHaveBeenCalledTimes(1);

    await store.claimUpdate(older.update_id, older);
    await store.failUpdate(older.update_id, 'db_down');
    await makeDue(older.update_id);
    await service.retryFailedUpdates();
    const retryState = (await pool.query(
      'SELECT status, attempts FROM alert_bot_updates WHERE update_id = $1', [older.update_id],
    )).rows[0];

    await makeDue(older.update_id);
    await service.handleUpdate(older);
    const freshState = (await pool.query(
      'SELECT status FROM alert_bot_updates WHERE update_id = $1', [older.update_id],
    )).rows[0];
    finishAdmission('accepted');
    await newerHandling;

    expect(retryState).toMatchObject({ status: 'failed', attempts: 2 });
    expect(freshState.status).toBe('completed');
    expect(turns.enqueue).toHaveBeenCalledTimes(1);
  });
});
